import { sendEmail } from "./email";
import { EmailError, type EmailMessage } from "./message";

// ─────────────────────────────────────────────────────────────────────────────
// Job de la cola para enviar un correo (PLAN-GESTION.md §2: los efectos externos, correo
// incluido, van siempre por la cola). Queda listo para registrarlo en el motor de colas
// (src/platform/queue/) con el nombre SEND_EMAIL_JOB; este archivo no importa la cola.
//
// El payload es el mensaje YA ARMADO (destinatario, asunto, HTML y texto, p. ej. con las
// plantillas de ./templates.ts): serializable a JSON y sin depender de que el negocio, la
// cita o la plantilla sigan iguales cuando el job corra.
//
// Errores: `sendEmail` lanza `EmailError` con la marca `transient`; acá se relanzan TAL
// CUAL para que la cola reintente con backoff los transitorios (`isTransientError`) y dé
// por fallidos de una vez los permanentes.
// ─────────────────────────────────────────────────────────────────────────────

export const SEND_EMAIL_JOB = "email.send";

export interface SendEmailJobPayload {
  message: EmailMessage;
}

/**
 * Datos del job que corre (opcional). Con `id`, el envío usa `email-job-<id>` como clave
 * de idempotencia si el mensaje no trae una: si un timeout esconde un envío que sí salió,
 * el reintento de la cola no manda un duplicado. Al registrar el handler, pasale el job.
 */
export interface SendEmailJobContext {
  id?: string | number;
}

export async function handleSendEmailJob(
  payload: SendEmailJobPayload,
  job?: SendEmailJobContext,
): Promise<{ id: string }> {
  const message = (payload as { message?: unknown } | null | undefined)?.message;
  if (!message || typeof message !== "object") {
    throw new EmailError(`Job ${SEND_EMAIL_JOB} sin \`message\` en el payload`, { transient: false, code: "invalid_message" });
  }
  const msg = message as EmailMessage;
  const jobId = job?.id;
  const idempotencyKey = msg.idempotencyKey ?? (jobId !== undefined && jobId !== "" ? `email-job-${jobId}` : undefined);
  return sendEmail(idempotencyKey ? { ...msg, idempotencyKey } : msg);
}
