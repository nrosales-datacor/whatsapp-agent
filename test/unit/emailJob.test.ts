import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { clearTestOutbox, EmailError, getTestOutbox, type EmailMessage } from "../../src/platform/email/email";
import { handleSendEmailJob, SEND_EMAIL_JOB, type SendEmailJobPayload } from "../../src/platform/email/job";
import { invitationEmail } from "../../src/platform/email/templates";
import { isTransientError } from "../../src/platform/net/transient";

// ─────────────────────────────────────────────────────────────────────────────
// Job "email.send" (src/platform/email/job.ts), listo para registrar en la cola: payload
// serializable con el mensaje ya armado, clave de idempotencia desde el id del job y
// errores transitorios relanzados como tales.
// ─────────────────────────────────────────────────────────────────────────────

const ENV_KEYS = ["NODE_ENV", "EMAIL_PROVIDER", "RESEND_API_KEY", "EMAIL_FROM"] as const;
const previousEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
const originalFetch = globalThis.fetch;
const original = { log: console.log, warn: console.warn, error: console.error };

const message: EmailMessage = {
  to: "sofia@correo.com",
  ...invitationEmail({ businessName: "Uñas Bellas", acceptUrl: "https://app.selyon.app/invite/tok" }),
  tags: { kind: "invitation" },
};

beforeEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
  clearTestOutbox();
  console.log = console.warn = console.error = () => {};
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  Object.assign(console, original);
  for (const k of ENV_KEYS) {
    if (previousEnv[k] === undefined) delete process.env[k];
    else process.env[k] = previousEnv[k];
  }
});

test("nombre del job y payload serializable: lo que vuelve de la base (JSON) se envía igual", async () => {
  assert.equal(SEND_EMAIL_JOB, "email.send");
  const payload: SendEmailJobPayload = JSON.parse(JSON.stringify({ message }));
  const { id } = await handleSendEmailJob(payload, { id: 42 });
  const [sent] = getTestOutbox();
  assert.equal(sent.id, id);
  assert.equal(sent.to, "sofia@correo.com");
  assert.equal(sent.subject, "Te invitaron a Uñas Bellas en Selyon CRM");
  assert.equal(sent.idempotencyKey, "email-job-42", "la clave sale del id del job: el reintento no duplica");
});

test("idempotencia: la clave del mensaje gana; sin job ni clave, va sin clave", async () => {
  await handleSendEmailJob({ message: { ...message, idempotencyKey: "invite-7" } }, { id: "j-1" });
  await handleSendEmailJob({ message });
  const [withKey, withoutKey] = getTestOutbox();
  assert.equal(withKey.idempotencyKey, "invite-7");
  assert.equal(withoutKey.idempotencyKey, undefined);
});

test("errores transitorios del proveedor se relanzan como transitorios (la cola reintenta)", async () => {
  process.env.EMAIL_PROVIDER = "resend";
  process.env.RESEND_API_KEY = "re_test";
  let sentKey: string | undefined;
  globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
    sentKey = (init?.headers as Record<string, string>)["Idempotency-Key"];
    return new Response(JSON.stringify({ statusCode: 503, name: "internal_server_error", message: "x" }), { status: 503 });
  }) as typeof fetch;
  await assert.rejects(handleSendEmailJob({ message }, { id: 9 }), (e: unknown) => {
    assert.ok(e instanceof EmailError);
    assert.equal(e.transient, true);
    assert.equal(isTransientError(e), true);
    return true;
  });
  assert.equal(sentKey, "email-job-9");
});

test("errores permanentes y payload roto: no se reintentan", async () => {
  await assert.rejects(handleSendEmailJob({} as SendEmailJobPayload), (e: unknown) => {
    assert.ok(e instanceof EmailError);
    assert.equal(e.code, "invalid_message");
    assert.equal(isTransientError(e), false);
    return true;
  });
  await assert.rejects(handleSendEmailJob({ message: { ...message, to: "roto" } }), (e: unknown) => !isTransientError(e));

  process.env.NODE_ENV = "production"; // sin EMAIL_PROVIDER: falla cerrado
  await assert.rejects(handleSendEmailJob({ message }), (e: unknown) => {
    assert.ok(e instanceof EmailError);
    assert.equal(e.code, "not_configured");
    assert.equal(isTransientError(e), false);
    return true;
  });
  assert.deepEqual(getTestOutbox(), []);
});
