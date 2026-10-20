import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import {
  clearTestOutbox,
  DEFAULT_EMAIL_FROM,
  EmailError,
  getTestOutbox,
  resolveEmailConfig,
  sendEmail,
  type EmailMessage,
} from "../../src/platform/email/email";
import { isTransientError } from "../../src/platform/net/transient";
import { _resetAlertsForTests } from "../../src/platform/observability/alerts";
import { maskEmail, redactEmails, sanitizeLogFields } from "../../src/platform/observability/privacy";

// ─────────────────────────────────────────────────────────────────────────────
// Correo de la plataforma (src/platform/email/email.ts): proveedor `log` con su outbox,
// elección del proveedor por env, fallo cerrado en producción sin configuración y
// validación del mensaje. Sin red: el proveedor `log` no sale del proceso.
// ─────────────────────────────────────────────────────────────────────────────

const ENV_KEYS = ["NODE_ENV", "EMAIL_PROVIDER", "RESEND_API_KEY", "EMAIL_FROM"] as const;
const previousEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

const message: EmailMessage = {
  to: "Ana Pérez <ana.perez@correo.com>",
  subject: "Hola",
  html: "<p>Hola</p>",
  text: "Hola",
  tags: { kind: "test", business_id: "b-1" },
};

/** Corre `fn` capturando todo lo que sale por console.* (los log.* escriben ahí). */
async function captureLogs<T>(fn: () => Promise<T>): Promise<{ result?: T; error?: unknown; lines: string[] }> {
  const lines: string[] = [];
  const original = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = (...args: unknown[]) => lines.push(args.map(String).join(" "));
  try {
    return { result: await fn(), lines };
  } catch (error) {
    return { error, lines };
  } finally {
    Object.assign(console, original);
  }
}

beforeEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
  clearTestOutbox();
  _resetAlertsForTests();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (previousEnv[k] === undefined) delete process.env[k];
    else process.env[k] = previousEnv[k];
  }
});

test("log (default fuera de producción): no envía, guarda en el outbox con id y remitente", async () => {
  assert.deepEqual(resolveEmailConfig(), { provider: "log", from: DEFAULT_EMAIL_FROM });
  assert.equal(DEFAULT_EMAIL_FROM, "Selyon CRM <no-reply@selyon.app>");

  const { id } = await sendEmail(message);
  assert.match(id, /^log_/);
  const outbox = getTestOutbox();
  assert.equal(outbox.length, 1);
  assert.equal(outbox[0].id, id);
  assert.equal(outbox[0].from, DEFAULT_EMAIL_FROM);
  assert.equal(outbox[0].to, message.to);
  assert.equal(outbox[0].subject, "Hola");
  assert.deepEqual(outbox[0].tags, { kind: "test", business_id: "b-1" });
});

test("outbox: getTestOutbox devuelve copias y clearTestOutbox lo vacía", async () => {
  process.env.EMAIL_PROVIDER = "log";
  process.env.EMAIL_FROM = "Clínica <hola@clinica.cr>";
  await sendEmail(message);
  await sendEmail({ ...message, subject: "Segundo" });
  const outbox = getTestOutbox();
  assert.deepEqual(outbox.map((e) => e.subject), ["Hola", "Segundo"]);
  assert.equal(outbox[0].from, "Clínica <hola@clinica.cr>");
  outbox[0].subject = "mutado";
  assert.equal(getTestOutbox()[0].subject, "Hola", "mutar la copia no toca el outbox");
  clearTestOutbox();
  assert.deepEqual(getTestOutbox(), []);
});

test("log: el log del envío no lleva la dirección completa ni el contenido", async () => {
  const { lines } = await captureLogs(() =>
    sendEmail({ ...message, subject: "Su cita con la Dra. Mora", text: "Texto secreto del correo" }),
  );
  const all = lines.join("\n");
  assert.match(all, /email_logged/);
  assert.match(all, /a\*\*\*@correo\.com/);
  assert.ok(!all.includes("ana.perez"), "sin la dirección completa");
  assert.ok(!all.includes("Dra. Mora") && !all.includes("Texto secreto"), "sin asunto ni contenido");
});

test("producción sin EMAIL_PROVIDER: importar no falla, enviar falla cerrado (permanente) con mensaje claro", async () => {
  process.env.NODE_ENV = "production";
  const { error, lines } = await captureLogs(() => sendEmail(message));
  assert.ok(error instanceof EmailError);
  assert.equal(error.code, "not_configured");
  assert.equal(error.transient, false);
  assert.equal(isTransientError(error), false);
  assert.match(error.message, /EMAIL_PROVIDER/);
  assert.match(error.message, /RESEND_API_KEY/);
  assert.deepEqual(getTestOutbox(), [], "no cae en silencio al outbox");
  assert.ok(lines.some((l) => l.includes("platform_alert") && l.includes("email_not_configured")), "alerta a la plataforma");
});

test("producción: `log` explícito o `resend` sin API key tampoco sirven", async () => {
  process.env.NODE_ENV = "production";
  process.env.EMAIL_PROVIDER = "log";
  assert.throws(() => resolveEmailConfig(), (e: unknown) => e instanceof EmailError && /no se permite en producción/.test(e.message));
  process.env.EMAIL_PROVIDER = "resend";
  assert.throws(() => resolveEmailConfig(), /RESEND_API_KEY/);
  process.env.RESEND_API_KEY = "re_test";
  assert.deepEqual(resolveEmailConfig(), { provider: "resend", from: DEFAULT_EMAIL_FROM, apiKey: "re_test" });
});

test("configuración inválida en cualquier entorno: proveedor desconocido o EMAIL_FROM roto", () => {
  process.env.EMAIL_PROVIDER = "sendgrid";
  assert.throws(() => resolveEmailConfig(), /no es válido \(resend \| log\)/);
  process.env.EMAIL_PROVIDER = "LOG";
  process.env.EMAIL_FROM = "sin-arroba";
  assert.throws(() => resolveEmailConfig(), /EMAIL_FROM/);
  process.env.EMAIL_FROM = "Selyon <no-reply@selyon.app>";
  assert.deepEqual(resolveEmailConfig(), { provider: "log", from: "Selyon <no-reply@selyon.app>" });
});

test("validación: mensaje roto → EmailError permanente, sin gastar un envío", async () => {
  const bad: unknown[] = [
    { ...message, to: "" },
    { ...message, to: "no-es-correo" },
    { ...message, to: "a@x.com, b@x.com" },
    { ...message, to: "a@x.com\r\nBcc: otro@x.com" },
    { ...message, subject: "  " },
    { ...message, html: "" },
    { ...message, text: undefined },
    { ...message, replyTo: "roto" },
    { ...message, idempotencyKey: "x".repeat(257) },
    null,
  ];
  for (const m of bad) {
    await assert.rejects(
      sendEmail(m as EmailMessage),
      (e: unknown) => e instanceof EmailError && e.code === "invalid_message" && !e.transient,
      `debió rechazar: ${JSON.stringify(m)}`,
    );
  }
  assert.deepEqual(getTestOutbox(), []);
});

test("validación: asunto en una línea y etiquetas saneadas a [A-Za-z0-9_-]", async () => {
  await sendEmail({ ...message, subject: "Hola\r\nBcc: x", replyTo: "negocio@clinica.cr", tags: { "tipo de correo": "recordatorio 24h", vacio: "" } });
  const [sent] = getTestOutbox();
  assert.equal(sent.subject, "Hola Bcc: x");
  assert.equal(sent.replyTo, "negocio@clinica.cr");
  assert.deepEqual(sent.tags, { tipo_de_correo: "recordatorio_24h" });
});

test("privacidad: maskEmail/redactEmails y la red de seguridad de log.* con correos", () => {
  assert.equal(maskEmail("ana.perez@gmail.com"), "a***@gmail.com");
  assert.equal(maskEmail("a***@gmail.com"), "a***@gmail.com", "idempotente");
  assert.equal(maskEmail("sin-arroba"), "***");
  assert.equal(maskEmail(undefined), "—");
  assert.equal(redactEmails("solo a dueño@negocio.cr (prueba)"), "solo a d***@negocio.cr (prueba)");
  const clean = sanitizeLogFields({ email: "ana@x.com", to: "luis@y.com", recipient: "eva@z.com", phone: "50688887777" });
  assert.deepEqual(clean, { email: "a***@x.com", to: "l***@y.com", recipient: "e***@z.com", phone: "506***7777" });
  assert.equal(sanitizeLogFields({ to: "50688887777" }).to, "506***7777", "`to` sin @ sigue siendo un teléfono");
});
