import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  alertPlatform,
  forgetAlert,
  _resetAlertsForTests,
  _setWebhookSenderForTests,
} from "../../src/platform/observability/alerts";

// ─────────────────────────────────────────────────────────────────────────────
// Canal de alertas a la plataforma (src/platform/observability/alerts.ts):
// deduplicación por (tipo, negocio) con cooldown y webhook genérico {text, content}.
// ─────────────────────────────────────────────────────────────────────────────

let sent: { url: string; text: string; content: string }[] = [];
const previousUrl = process.env.ALERTS_WEBHOOK_URL;

beforeEach(() => {
  _resetAlertsForTests();
  sent = [];
  _setWebhookSenderForTests(async (url, body) => {
    sent.push({ url, ...body });
  });
  process.env.ALERTS_WEBHOOK_URL = "https://hooks.ejemplo.test/alertas";
});

afterEach(() => {
  _setWebhookSenderForTests(null);
  if (previousUrl === undefined) delete process.env.ALERTS_WEBHOOK_URL;
  else process.env.ALERTS_WEBHOOK_URL = previousUrl;
});

const base = { type: "dlq_recent", severity: "critical" as const, message: "3 jobs en error" };

test("alertas: la primera ocurrencia sale por el webhook con {text, content}", () => {
  assert.equal(alertPlatform({ ...base, tenantId: "t1" }, 1_000), true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].url, "https://hooks.ejemplo.test/alertas");
  assert.match(sent[0].text, /dlq_recent/);
  assert.match(sent[0].text, /tenant t1/);
  assert.match(sent[0].text, /selyon-crm/);
  assert.equal(sent[0].text, sent[0].content, "Slack lee `text`, Discord lee `content`: mismo texto");
});

test("alertas: deduplica la misma (tipo, negocio) dentro del cooldown y vuelve a salir al vencer", () => {
  const cooldownMs = 60_000;
  assert.equal(alertPlatform({ ...base, tenantId: "t1", cooldownMs }, 0), true);
  assert.equal(alertPlatform({ ...base, tenantId: "t1", cooldownMs }, 30_000), false, "dentro del cooldown");
  assert.equal(alertPlatform({ ...base, tenantId: "t1", cooldownMs }, 59_999), false);
  assert.equal(alertPlatform({ ...base, tenantId: "t1", cooldownMs }, 60_000), true, "venció el cooldown");
  assert.equal(sent.length, 2);
});

test("alertas: el cooldown es por (tipo, negocio) — otro negocio u otro tipo no quedan silenciados", () => {
  assert.equal(alertPlatform({ ...base, tenantId: "t1" }, 0), true);
  assert.equal(alertPlatform({ ...base, tenantId: "t2" }, 1), true, "otro negocio");
  assert.equal(alertPlatform({ ...base, type: "quota_exhausted", tenantId: "t1" }, 2), true, "otro tipo");
  assert.equal(alertPlatform({ ...base, type: "queue_stuck" }, 3), true, "global (sin negocio)");
  assert.equal(alertPlatform({ ...base, type: "queue_stuck" }, 4), false);
  assert.equal(sent.length, 4);
});

test("alertas: forgetAlert permite re-alertar de inmediato (problema resuelto y recaída)", () => {
  assert.equal(alertPlatform({ ...base, tenantId: "t1" }, 0), true);
  forgetAlert("dlq_recent", "t1");
  assert.equal(alertPlatform({ ...base, tenantId: "t1" }, 1), true);
});

test("alertas: sin ALERTS_WEBHOOK_URL no intenta el POST (solo log/Sentry) y no lanza", () => {
  delete process.env.ALERTS_WEBHOOK_URL;
  assert.equal(alertPlatform({ ...base, tenantId: "t1" }, 0), true);
  assert.equal(sent.length, 0);
});

test("alertas: un webhook que falla no lanza ni rompe al llamador", async () => {
  _setWebhookSenderForTests(async () => {
    throw new Error("503 de Slack");
  });
  assert.doesNotThrow(() => alertPlatform({ ...base, tenantId: "t1" }, 0));
  await new Promise((r) => setImmediate(r)); // deja correr el catch del envío en segundo plano
});
