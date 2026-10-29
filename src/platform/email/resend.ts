import { EMAIL_TIMEOUT_MS, timeoutSignal } from "../net/timeouts";
import { log } from "../observability/log";
import { redactEmails } from "../observability/privacy";
import { EmailError, type EmailMessage } from "./message";

// ─────────────────────────────────────────────────────────────────────────────
// Proveedor Resend por su API HTTP, con `fetch` nativo (sin SDK: política de
// dependencias). Docs: POST https://api.resend.com/emails con `Authorization: Bearer`.
//
// Clasificación del error (la marca `transient` de EmailError la lee la cola):
//   - transitorio: sin respuesta (red, timeout), 408, 429 por rate limit, 5xx y el 409
//     de "otro pedido con la misma clave de idempotencia está en curso";
//   - permanente: el resto de los 4xx (422 dato inválido, 401/403 API key o dominio sin
//     verificar…) y el 429 por CUOTA diaria/mensual agotada (como el `insufficient_quota`
//     de OpenAI en transient.ts: reintentar en segundos no lo arregla).
// ─────────────────────────────────────────────────────────────────────────────

export const RESEND_API_URL = "https://api.resend.com/emails";

const MAX_DETAIL_LENGTH = 200;

export interface ResendOptions {
  apiKey: string;
  /** Remitente ya validado ("Selyon CRM <no-reply@selyon.app>"). */
  from: string;
  /** Solo para tests; por default EMAIL_TIMEOUT_MS (src/platform/net/timeouts.ts). */
  timeoutMs?: number;
}

/** ¿Vale la pena reintentar un status HTTP de Resend? `name` es el código de error del cuerpo. */
export function isTransientResendStatus(status: number, name?: string): boolean {
  if (status === 408 || status >= 500) return true;
  if (status === 429) return !/quota/i.test(name ?? "");
  if (status === 409) return name === "concurrent_idempotent_requests";
  return false;
}

/** Lee el cuerpo de error de Resend (`{ statusCode, name, message }`) sin dejar direcciones completas. */
async function readError(res: Response): Promise<{ name?: string; detail: string }> {
  const raw = await res.text().catch(() => "");
  let name: string | undefined;
  let detail = raw;
  try {
    const body = JSON.parse(raw) as { name?: unknown; message?: unknown };
    if (typeof body.name === "string") name = body.name;
    if (typeof body.message === "string") detail = body.message;
  } catch {
    // Cuerpo que no es JSON (p. ej. la página de error de un proxy): va el texto recortado.
  }
  return { name, detail: redactEmails(detail.replace(/\s+/g, " ").trim()).slice(0, MAX_DETAIL_LENGTH) };
}

/** Envía un mensaje ya validado. Lanza `EmailError` (con `transient`) si no sale. */
export async function sendViaResend(message: EmailMessage, options: ResendOptions): Promise<{ id: string }> {
  const timeoutMs = options.timeoutMs ?? EMAIL_TIMEOUT_MS;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${options.apiKey}`,
    "Content-Type": "application/json",
  };
  if (message.idempotencyKey) headers["Idempotency-Key"] = message.idempotencyKey;

  const body: Record<string, unknown> = {
    from: options.from,
    to: [message.to],
    subject: message.subject,
    html: message.html,
    text: message.text,
  };
  if (message.replyTo) body.reply_to = message.replyTo;
  if (message.tags) body.tags = Object.entries(message.tags).map(([name, value]) => ({ name, value }));

  let res: Response;
  try {
    res = await fetch(RESEND_API_URL, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: timeoutSignal(timeoutMs),
    });
  } catch (e) {
    const name = e instanceof Error ? e.name : "";
    if (name === "TimeoutError" || name === "AbortError") {
      throw new EmailError(`Resend no respondió en ${timeoutMs} ms`, { transient: true, code: "timeout", cause: e });
    }
    // undici: "fetch failed" con la causa real (ECONNRESET, ENOTFOUND…) en `cause.code`.
    const cause = (e as { cause?: { code?: unknown } } | null)?.cause?.code;
    const what = typeof cause === "string" ? cause : e instanceof Error ? e.message : String(e);
    throw new EmailError(`Resend: error de red (${what})`, { transient: true, code: "network", cause: e });
  }

  if (res.ok) {
    const data = (await res.json().catch(() => null)) as { id?: unknown } | null;
    if (data && typeof data.id === "string" && data.id) return { id: data.id };
    // Resend aceptó el correo (2xx) pero no devolvió el id: NO se relanza (un reintento lo
    // duplicaría), solo se deja constancia.
    log.warn("email_provider_response_without_id", { provider: "resend", status: res.status });
    return { id: "unknown" };
  }

  const { name, detail } = await readError(res);
  const transient = isTransientResendStatus(res.status, name);
  throw new EmailError(`Resend respondió ${res.status}${name ? ` (${name})` : ""}: ${detail || "sin detalle"}`, {
    transient,
    status: res.status,
    code: name,
  });
}
