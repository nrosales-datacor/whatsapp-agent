import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { EmailError, sendEmail, type EmailMessage } from "../../src/platform/email/email";
import { isTransientResendStatus, RESEND_API_URL, sendViaResend } from "../../src/platform/email/resend";
import { isTransientError } from "../../src/platform/net/transient";
import { _resetAlertsForTests } from "../../src/platform/observability/alerts";

// ─────────────────────────────────────────────────────────────────────────────
// Proveedor Resend (src/platform/email/resend.ts) con `globalThis.fetch` mockeado (sin
// red real): forma del pedido, éxito, y la clasificación de errores que lee la cola —
// 429/5xx/red/timeout transitorios, 4xx permanentes.
// ─────────────────────────────────────────────────────────────────────────────

const ENV_KEYS = ["NODE_ENV", "EMAIL_PROVIDER", "RESEND_API_KEY", "EMAIL_FROM"] as const;
const previousEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
const originalFetch = globalThis.fetch;
const original = { log: console.log, warn: console.warn, error: console.error };

let calls: { url: string; init: RequestInit }[] = [];
let logLines: string[] = [];

const message: EmailMessage = {
  to: "Ana <ana.perez@correo.com>",
  subject: "Recordatorio",
  html: "<p>Hola</p>",
  text: "Hola",
  replyTo: "hola@clinica.cr",
  tags: { kind: "appointment_reminder" },
  idempotencyKey: "reminder-123",
};

/** Mock de fetch que responde siempre con `status` y `body` (JSON). */
function respond(status: number, body: unknown): void {
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
  }) as typeof fetch;
}

beforeEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.EMAIL_PROVIDER = "resend";
  process.env.RESEND_API_KEY = "re_test_key";
  calls = [];
  logLines = [];
  _resetAlertsForTests();
  // Los log.* van a console: se capturan para revisar que no lleven datos personales.
  console.log = console.warn = console.error = (...args: unknown[]) => logLines.push(args.map(String).join(" "));
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  Object.assign(console, original);
  for (const k of ENV_KEYS) {
    if (previousEnv[k] === undefined) delete process.env[k];
    else process.env[k] = previousEnv[k];
  }
});

test("éxito: POST a Resend con Bearer, idempotencia y el cuerpo esperado; devuelve el id", async () => {
  respond(200, { id: "49a3999c-0ce1-4ea6-ab68-afcd6dc2e794" });
  const result = await sendEmail(message);
  assert.deepEqual(result, { id: "49a3999c-0ce1-4ea6-ab68-afcd6dc2e794" });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, RESEND_API_URL);
  assert.equal(calls[0].init.method, "POST");
  const headers = calls[0].init.headers as Record<string, string>;
  assert.equal(headers.Authorization, "Bearer re_test_key");
  assert.equal(headers["Content-Type"], "application/json");
  assert.equal(headers["Idempotency-Key"], "reminder-123");
  assert.ok(calls[0].init.signal instanceof AbortSignal, "lleva timeout");
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), {
    from: "Selyon CRM <no-reply@selyon.app>",
    to: ["Ana <ana.perez@correo.com>"],
    subject: "Recordatorio",
    html: "<p>Hola</p>",
    text: "Hola",
    reply_to: "hola@clinica.cr",
    tags: [{ name: "kind", value: "appointment_reminder" }],
  });

  const logs = logLines.join("\n");
  assert.match(logs, /email_sent/);
  assert.ok(!logs.includes("ana.perez") && !logs.includes("re_test_key"), "sin dirección completa ni API key en logs");
});

test("429 por rate limit y 500/503 → EmailError transitorio (la cola reintenta)", async () => {
  for (const [status, name] of [[429, "rate_limit_exceeded"], [500, "internal_server_error"], [503, undefined]] as const) {
    respond(status, name ? { statusCode: status, name, message: "x" } : "<html>Bad gateway</html>");
    await assert.rejects(sendEmail(message), (e: unknown) => {
      assert.ok(e instanceof EmailError);
      assert.equal(e.status, status);
      assert.equal(e.transient, true, `status ${status}`);
      assert.equal(isTransientError(e), true);
      return true;
    });
  }
});

test("422 → EmailError permanente, sin direcciones completas en el mensaje", async () => {
  respond(422, { statusCode: 422, name: "invalid_parameter", message: "Invalid `to` field: ana.perez@correo.com" });
  await assert.rejects(sendEmail(message), (e: unknown) => {
    assert.ok(e instanceof EmailError);
    assert.equal(e.transient, false);
    assert.equal(isTransientError(e), false);
    assert.equal(e.status, 422);
    assert.equal(e.code, "invalid_parameter");
    assert.match(e.message, /422 \(invalid_parameter\)/);
    assert.ok(!e.message.includes("ana.perez"), e.message);
    return true;
  });
  assert.ok(!logLines.join("\n").includes("ana.perez"));
});

test("403 (API key o dominio) → permanente y alerta a la plataforma", async () => {
  respond(403, { statusCode: 403, name: "validation_error", message: "The selyon.app domain is not verified." });
  await assert.rejects(sendEmail(message), (e: unknown) => e instanceof EmailError && !e.transient && e.status === 403);
  assert.ok(logLines.some((l) => l.includes("platform_alert") && l.includes("email_provider_auth_failed")));
});

test("clasificación: cuota agotada (429) y 409 de idempotencia", () => {
  assert.equal(isTransientResendStatus(429, "daily_quota_exceeded"), false, "la cuota no vuelve en segundos");
  assert.equal(isTransientResendStatus(429), true);
  assert.equal(isTransientResendStatus(409, "concurrent_idempotent_requests"), true);
  assert.equal(isTransientResendStatus(409, "invalid_idempotent_request"), false);
  assert.equal(isTransientResendStatus(408), true);
  for (const s of [400, 401, 404, 422]) assert.equal(isTransientResendStatus(s), false, `status ${s}`);
});

test("error de red → transitorio", async () => {
  globalThis.fetch = (async () => {
    throw new TypeError("fetch failed", { cause: Object.assign(new Error("connect"), { code: "ECONNRESET" }) });
  }) as typeof fetch;
  await assert.rejects(sendEmail(message), (e: unknown) => {
    assert.ok(e instanceof EmailError);
    assert.equal(e.code, "network");
    assert.equal(e.transient, true);
    assert.match(e.message, /ECONNRESET/);
    return true;
  });
});

test("timeout: Resend colgado → se aborta y queda transitorio", async () => {
  // fetch que nunca responde: solo termina cuando la señal de timeout lo aborta.
  globalThis.fetch = ((_input: unknown, init?: RequestInit) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
    })) as typeof fetch;
  const started = Date.now();
  await assert.rejects(sendViaResend(message, { apiKey: "re_test_key", from: "a@b.co", timeoutMs: 30 }), (e: unknown) => {
    assert.ok(e instanceof EmailError);
    assert.equal(e.code, "timeout");
    assert.equal(e.transient, true);
    assert.match(e.message, /no respondió en 30 ms/);
    return true;
  });
  assert.ok(Date.now() - started < 5_000, "no se queda colgado");
});

test("2xx sin id: no se relanza (reintentar duplicaría el correo)", async () => {
  respond(200, "no-json");
  assert.deepEqual(await sendEmail(message), { id: "unknown" });
});
