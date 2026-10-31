import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { ErrorEvent } from "@sentry/node";

// ─────────────────────────────────────────────────────────────────────────────
// Sentry del backend (src/platform/observability/sentry.ts): el saneo de datos personales
// del `beforeSend` (`scrubEvent`), la config que se le pasa al panel y la CSP. Además, un
// envío de punta a punta con `initSentry` real y un transporte en memoria: lo que saldría
// por la red ya va con release, tag `app` y sin teléfono ni texto del cliente.
//
// El DSN se lee al cargar el módulo: este archivo corre en su propio proceso (node --test)
// y fija uno ficticio ANTES de importarlo. El transporte en memoria hace que nada salga a
// la red.
// ─────────────────────────────────────────────────────────────────────────────

process.env.SENTRY_DSN = "https://clavepublica@o0.ingest.sentry.example.test/1";
process.env.SENTRY_RELEASE = "abc1234def5678";

const Sentry = await import("@sentry/node");
const { captureError, flushSentry, initSentry, panelSentryConfig, scrubEvent, stripQuery } = await import(
  "../../src/platform/observability/sentry"
);
const { withPanelConfig } = await import("../../src/platform/http/staticPanel");
const { panelCsp } = await import("../../src/platform/net/securityHeaders");

const PHONE = "50688887777";
const TEXT = "Hola, soy Ana Pérez y quiero una cita el viernes";

test("scrubEvent: enmascara teléfonos y correos, recorta textos y limpia el request", () => {
  const event = scrubEvent({
    type: undefined,
    message: "falló el envío a ana.perez@gmail.com",
    extra: { businessId: "b1", phone: PHONE, clientPhone: `+${PHONE}`, text: TEXT, email: "ana.perez@gmail.com" },
    contexts: { whatsapp: { to: PHONE, reply: "Listo, te agendé" } },
    exception: { values: [{ type: "Error", value: "Resend rechazó a ana.perez@gmail.com" }] },
    request: {
      url: "https://app.test/api/panel/auth/reset?token=secreto",
      method: "POST",
      data: { password: "clave-del-usuario" },
      cookies: { selyon_session: "firmada" },
      query_string: "token=secreto",
      headers: { "User-Agent": "Mozilla/5.0", Cookie: "selyon_session=firmada", "X-Hub-Signature-256": "sha256=…" },
    },
    user: { ip_address: "201.1.2.3", email: "ana.perez@gmail.com" },
    breadcrumbs: [{ category: "http", data: { url: "https://graph.facebook.com/v21.0/123/messages?access_token=x", to: PHONE } }],
  });

  assert.equal(event.extra?.businessId, "b1");
  assert.equal(event.extra?.phone, "506***7777");
  assert.equal(event.extra?.clientPhone, "506***7777");
  assert.equal(event.extra?.text, `[${TEXT.length} car.]`);
  assert.equal(event.extra?.email, "a***@gmail.com");
  assert.deepEqual(event.contexts?.whatsapp, { to: "506***7777", reply: "[16 car.]" });
  assert.equal(event.message, "falló el envío a a***@gmail.com");
  assert.equal(event.exception?.values?.[0].value, "Resend rechazó a a***@gmail.com");
  assert.equal(event.request?.url, "https://app.test/api/panel/auth/reset");
  assert.equal(event.request?.method, "POST");
  assert.equal(event.request?.data, undefined);
  assert.equal(event.request?.cookies, undefined);
  assert.equal(event.request?.query_string, undefined);
  assert.deepEqual(event.request?.headers, { "User-Agent": "Mozilla/5.0" });
  assert.equal(event.user, undefined);
  assert.equal(event.breadcrumbs?.[0].data?.url, "https://graph.facebook.com/v21.0/123/messages");
  assert.equal(event.breadcrumbs?.[0].data?.to, "506***7777");
  assert.ok(!JSON.stringify(event).includes(PHONE));
  assert.ok(!JSON.stringify(event).includes("Ana Pérez"));
});

test("stripQuery: saca query y fragmento", () => {
  assert.equal(stripQuery("/panel/invite?token=abc#x"), "/panel/invite");
  assert.equal(stripQuery("/panel/agenda#hoy"), "/panel/agenda");
  assert.equal(stripQuery("/panel/agenda"), "/panel/agenda");
});

test("initSentry + captureError: el evento sale con release, environment, tag app y SIN datos personales", async () => {
  type Envelope = [unknown, [{ type: string }, unknown][]];
  const sent: Envelope[] = [];
  initSentry({
    transport: () => ({
      send: async (envelope) => {
        sent.push(envelope as unknown as Envelope);
        return {};
      },
      flush: async () => true,
    }),
  });
  try {
    captureError(new Error("OpenAI 400: context_length_exceeded"), { module: "whatsapp", businessId: "b1", clientPhone: PHONE, text: TEXT });
    assert.equal(await flushSentry(2000), true);
    const events = sent.flatMap(([, items]) => items.filter(([h]) => h.type === "event").map(([, payload]) => payload as ErrorEvent));
    assert.equal(events.length, 1);
    const [event] = events;
    assert.equal(event.release, "abc1234def5678");
    assert.equal(event.environment, process.env.NODE_ENV ?? "development");
    assert.equal(event.tags?.app, "backend");
    assert.equal(event.extra?.businessId, "b1");
    assert.equal(event.extra?.clientPhone, "506***7777");
    assert.equal(event.extra?.text, `[${TEXT.length} car.]`);
    const json = JSON.stringify(event);
    assert.ok(!json.includes(PHONE), "el teléfono completo no sale");
    assert.ok(!json.includes("Ana Pérez"), "el texto del cliente no sale");
  } finally {
    await Sentry.close(1000);
  }
});

test("panelSentryConfig: sin DSN null; con DSN, origen para la CSP y release; SENTRY_PANEL_DSN tiene prioridad", () => {
  assert.equal(panelSentryConfig({}), null);
  assert.equal(panelSentryConfig({ SENTRY_DSN: "no-es-una-url" }), null);
  assert.deepEqual(panelSentryConfig({ SENTRY_DSN: "https://k@o1.ingest.sentry.example.test/2", SENTRY_RELEASE: "sha1", NODE_ENV: "production" }), {
    dsn: "https://k@o1.ingest.sentry.example.test/2",
    origin: "https://o1.ingest.sentry.example.test",
    release: "sha1",
    environment: "production",
  });
  const own = panelSentryConfig({ SENTRY_DSN: "https://k@o1.ingest.sentry.example.test/2", SENTRY_PANEL_DSN: "https://p@o1.ingest.sentry.example.test/2" });
  assert.equal(own?.dsn, "https://p@o1.ingest.sentry.example.test/2");
});

test("index del panel: con DSN lleva las <meta name=sentry-*> (escapadas); sin DSN queda igual", () => {
  const index = "<!doctype html><html><head><title>x</title></head><body><div id=\"root\"></div></body></html>";
  assert.equal(withPanelConfig(index, {}), index);
  const html = withPanelConfig(index, { SENTRY_DSN: "https://k@o1.ingest.sentry.example.test/2", SENTRY_RELEASE: "a\"b", NODE_ENV: "production" });
  assert.match(html, /<meta name="sentry-dsn" content="https:\/\/k@o1\.ingest\.sentry\.example\.test\/2"><meta name="sentry-environment" content="production"><meta name="sentry-release" content="a&quot;b"><\/head>/);
});

test("CSP del panel: connect-src suma el origen de Sentry solo si hay DSN", () => {
  assert.match(panelCsp(false, null), /connect-src 'self';/);
  assert.match(panelCsp(false, "https://o1.ingest.sentry.example.test"), /connect-src 'self' https:\/\/o1\.ingest\.sentry\.example\.test;/);
  assert.match(
    panelCsp(true, "https://o1.ingest.sentry.example.test"),
    /connect-src 'self' https:\/\/\*\.facebook\.com https:\/\/graph\.facebook\.com https:\/\/o1\.ingest\.sentry\.example\.test;/,
  );
});

test("scripts/sentryTestEvent.ts sin DSN: no manda nada, lo dice claro y sale con 0", () => {
  // DOTENV_CONFIG_PATH a un archivo que no existe: un .env local con DSN no cuenta (nada sale a la red).
  const r = spawnSync(process.execPath, ["--import", "tsx", "scripts/sentryTestEvent.ts"], {
    cwd: process.cwd(),
    env: { ...process.env, SENTRY_DSN: "", DOTENV_CONFIG_PATH: path.join(tmpdir(), "no-existe-sentry-test.env") },
    encoding: "utf8",
    timeout: 60_000,
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Sentry no configurado: falta SENTRY_DSN/);
  assert.match(r.stdout, /No se mandó nada/);
});
