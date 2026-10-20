import { randomUUID } from "node:crypto";
import { PRODUCT_NAME } from "../brand";
import { alertPlatform } from "../observability/alerts";
import { log } from "../observability/log";
import { maskEmail } from "../observability/privacy";
import { EmailError, mailboxAddress, validateEmailMessage, type EmailMessage } from "./message";
import { sendViaResend } from "./resend";

export { EmailError, type EmailMessage } from "./message";

// ─────────────────────────────────────────────────────────────────────────────
// Correo de la plataforma (PLAN-GESTION.md §2 "Acceso fácil"): invitaciones, recuperación
// de clave y recordatorios por correo (§4). Un solo punto de salida, `sendEmail()`, con
// el proveedor elegido por env:
//
//   EMAIL_PROVIDER=resend  → API HTTP de Resend (./resend.ts), con RESEND_API_KEY.
//   EMAIL_PROVIDER=log     → no envía: guarda el mensaje en un outbox en memoria
//                            (getTestOutbox) y loguea sin datos personales. Es el default
//                            fuera de producción (desarrollo y tests).
//
// En producción (NODE_ENV=production) sin una configuración válida, `sendEmail()` FALLA
// CERRADO con un mensaje claro y una alerta a la plataforma: una invitación o un cambio de
// clave que "salió" pero nunca llegó es peor que un error visible. Se decide al enviar,
// no al importar: un proceso que nunca manda correo (p. ej. ROLE=web sin invitaciones
// todavía) arranca igual.
//
// Los envíos reales van siempre por la cola (job "email.send", ./job.ts): el reintento
// con backoff de los errores transitorios lo hace la cola, no este módulo.
// ─────────────────────────────────────────────────────────────────────────────

/** Remitente por default. El dominio tiene que estar verificado en el proveedor. */
export const DEFAULT_EMAIL_FROM = `${PRODUCT_NAME} <no-reply@selyon.app>`;

export type EmailConfig = { provider: "log"; from: string } | { provider: "resend"; from: string; apiKey: string };

function notConfigured(reason: string): EmailError {
  return new EmailError(`Correo no configurado: ${reason}`, { transient: false, code: "not_configured" });
}

/**
 * Configuración de correo según la env, leída en cada llamada (los tests la cambian).
 * Lanza `EmailError` permanente (`code: "not_configured"`) si no es válida.
 */
export function resolveEmailConfig(): EmailConfig {
  const production = process.env.NODE_ENV === "production";
  const provider = (process.env.EMAIL_PROVIDER ?? "").trim().toLowerCase();
  const from = (process.env.EMAIL_FROM ?? "").trim() || DEFAULT_EMAIL_FROM;
  if (!mailboxAddress(from)) {
    throw notConfigured('EMAIL_FROM no es un remitente válido (formato "Nombre <correo@dominio>" o "correo@dominio").');
  }

  if (provider === "resend") {
    const apiKey = (process.env.RESEND_API_KEY ?? "").trim();
    if (!apiKey) throw notConfigured("EMAIL_PROVIDER=resend necesita RESEND_API_KEY.");
    return { provider: "resend", from, apiKey };
  }
  if (provider === "" || provider === "log") {
    if (production) {
      throw notConfigured(
        provider === ""
          ? "falta EMAIL_PROVIDER en producción. Configurá EMAIL_PROVIDER=resend y RESEND_API_KEY."
          : "EMAIL_PROVIDER=log no envía nada y no se permite en producción. Configurá EMAIL_PROVIDER=resend y RESEND_API_KEY.",
      );
    }
    return { provider: "log", from };
  }
  throw notConfigured(`EMAIL_PROVIDER="${provider.slice(0, 40)}" no es válido (resend | log).`);
}

// ── Outbox del proveedor `log` ──
// Lo consultan los tests (y, en desarrollo, quien quiera ver qué se "mandó"). Acotado:
// un server de desarrollo que corre días no debe crecer sin tope.

export type OutboxEntry = EmailMessage & { id: string; from: string };

const OUTBOX_MAX = 200;
const outbox: OutboxEntry[] = [];

/** Correos "enviados" por el proveedor `log`, del más viejo al más nuevo (copias). */
export function getTestOutbox(): OutboxEntry[] {
  return structuredClone(outbox);
}

/** Vacía el outbox del proveedor `log`. */
export function clearTestOutbox(): void {
  outbox.length = 0;
}

/**
 * Envía un correo con el proveedor configurado y devuelve el id que le dio el proveedor.
 *
 * Lanza `EmailError`: con `transient: true` si conviene reintentar (la cola lo hace) y
 * `false` si no (mensaje inválido, 4xx, sin configuración).
 */
export async function sendEmail(message: EmailMessage): Promise<{ id: string }> {
  const msg = validateEmailMessage(message);
  const recipient = maskEmail(mailboxAddress(msg.to));
  const tags = msg.tags ?? {};

  let config: EmailConfig;
  try {
    config = resolveEmailConfig();
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    log.error("email_not_configured", { recipient, tags, error: reason });
    alertPlatform({ type: "email_not_configured", severity: "critical", message: reason });
    throw e;
  }

  if (config.provider === "log") {
    const id = `log_${randomUUID()}`;
    outbox.push({ ...structuredClone(msg), id, from: config.from });
    if (outbox.length > OUTBOX_MAX) outbox.splice(0, outbox.length - OUTBOX_MAX);
    log.info("email_logged", { provider: "log", id, recipient, tags });
    return { id };
  }

  try {
    const result = await sendViaResend(msg, { apiKey: config.apiKey, from: config.from });
    log.info("email_sent", { provider: config.provider, id: result.id, recipient, tags });
    return result;
  } catch (e) {
    const err =
      e instanceof EmailError
        ? e
        : new EmailError(`Error inesperado enviando el correo: ${e instanceof Error ? e.message : String(e)}`, {
            transient: false,
            cause: e,
          });
    log.warn("email_send_failed", {
      provider: config.provider,
      status: err.status ?? null,
      code: err.code ?? null,
      transient: err.transient,
      recipient,
      tags,
      error: err.message,
    });
    // API key revocada o dominio sin verificar: falla para TODOS los negocios hasta que
    // alguien lo arregle, así que avisa a la plataforma (con deduplicación).
    if (err.status === 401 || err.status === 403) {
      alertPlatform({ type: "email_provider_auth_failed", severity: "critical", message: err.message });
    }
    throw err;
  }
}
