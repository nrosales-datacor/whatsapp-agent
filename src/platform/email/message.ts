// ─────────────────────────────────────────────────────────────────────────────
// Mensaje de correo y su error. Sin dependencias: lo usan el envío (./email.ts), cada
// proveedor (./resend.ts) y el job de la cola (./job.ts).
//
// El mensaje es un objeto plano y serializable (va tal cual en el payload del job). Se
// valida al enviar, no solo al armarlo: el payload de un job vuelve de la base como JSON
// y puede venir de una versión vieja del código.
// ─────────────────────────────────────────────────────────────────────────────

export interface EmailMessage {
  /** Destinatario: UNA dirección ("ana@correo.com" o "Ana Pérez <ana@correo.com>"). */
  to: string;
  subject: string;
  html: string;
  /** Versión en texto plano (clientes de correo sin HTML, filtros de spam, lectores de pantalla). */
  text: string;
  /** A dónde van las respuestas (p. ej. el correo del negocio); sin esto, al remitente. */
  replyTo?: string;
  /**
   * Etiquetas para el proveedor y los logs, p. ej. `{ kind: "appointment_reminder", business_id }`.
   * SIN datos personales: se loguean tal cual. Claves y valores quedan en [A-Za-z0-9_-].
   */
  tags?: Record<string, string>;
  /**
   * Clave de idempotencia (máx. 256 caracteres): el proveedor descarta un segundo envío con
   * la misma clave dentro de 24 h. Evita el correo duplicado cuando un timeout esconde un
   * envío que sí salió y la cola lo reintenta. El job la completa con el id del job.
   */
  idempotencyKey?: string;
}

/**
 * Error de envío de correo. `transient` es la marca que lee `isTransientError`
 * (src/platform/net/transient.ts): `true` = la cola debe reintentar (429, 5xx, red,
 * timeout); `false` = reintentar no lo arregla (mensaje inválido, 4xx, sin configuración).
 * El mensaje NO lleva direcciones completas (se puede loguear).
 */
export class EmailError extends Error {
  readonly transient: boolean;
  /** Status HTTP del proveedor, si lo hubo. */
  readonly status?: number;
  /** Código corto: "not_configured", "invalid_message", "timeout", "network" o el `name` del error del proveedor. */
  readonly code?: string;

  constructor(message: string, options: { transient: boolean; status?: number; code?: string; cause?: unknown }) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "EmailError";
    this.transient = options.transient;
    this.status = options.status;
    this.code = options.code;
  }
}

// Validación deliberadamente simple (la definitiva la hace el proveedor): lo que importa
// es cortar lo claramente roto antes de gastar un envío y, sobre todo, saltos de línea
// (inyección de cabeceras) y listas de destinatarios coladas en un campo de UNA dirección.
const ADDRESS = /^[^\s@<>"(),;:]+@[^\s@<>"(),;:.]+(\.[^\s@<>"(),;:.]+)+$/;
const MAX_ADDRESS_LENGTH = 320;
const MAX_SUBJECT_LENGTH = 998;
const MAX_IDEMPOTENCY_KEY_LENGTH = 256;
const MAX_TAG_LENGTH = 256;

/**
 * Dirección de un buzón ("Ana <ana@x.com>" → "ana@x.com"), o null si no es UNA dirección
 * válida (vacía, con saltos de línea, varias separadas por coma, sin dominio…).
 */
export function mailboxAddress(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const v = value.trim();
  if (!v || v.length > MAX_ADDRESS_LENGTH || /[\r\n]/.test(v)) return null;
  const named = /^([^<>]*)<([^<>]+)>$/.exec(v);
  const address = (named ? named[2] : v).trim();
  return ADDRESS.test(address) ? address : null;
}

function invalid(reason: string): EmailError {
  return new EmailError(`Correo inválido: ${reason}`, { transient: false, code: "invalid_message" });
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw invalid(`falta \`${field}\``);
  return value;
}

/** Deja una etiqueta en lo que aceptan los proveedores: [A-Za-z0-9_-], máx. 256. */
function cleanTag(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, MAX_TAG_LENGTH);
}

/**
 * Valida un mensaje (que puede venir de JSON) y devuelve una copia normalizada: asunto en
 * una sola línea y etiquetas saneadas. Lanza `EmailError` permanente si no sirve.
 */
export function validateEmailMessage(input: unknown): EmailMessage {
  if (!input || typeof input !== "object") throw invalid("se esperaba un objeto");
  const m = input as Record<string, unknown>;

  const to = requiredString(m.to, "to").trim();
  if (!mailboxAddress(to)) throw invalid("el destinatario no es UNA dirección válida");

  const subject = requiredString(m.subject, "subject").replace(/\s+/g, " ").trim().slice(0, MAX_SUBJECT_LENGTH);
  const html = requiredString(m.html, "html");
  const text = requiredString(m.text, "text");

  const message: EmailMessage = { to, subject, html, text };

  if (m.replyTo !== undefined && m.replyTo !== null && m.replyTo !== "") {
    if (!mailboxAddress(m.replyTo)) throw invalid("`replyTo` no es UNA dirección válida");
    message.replyTo = (m.replyTo as string).trim();
  }

  if (m.tags !== undefined && m.tags !== null) {
    if (typeof m.tags !== "object" || Array.isArray(m.tags)) throw invalid("`tags` debe ser un objeto { nombre: valor }");
    const tags: Record<string, string> = {};
    for (const [name, value] of Object.entries(m.tags as Record<string, unknown>)) {
      if (value === undefined || value === null) continue;
      const cleanName = cleanTag(name);
      const cleanValue = cleanTag(String(value));
      if (cleanName && cleanValue) tags[cleanName] = cleanValue;
    }
    if (Object.keys(tags).length > 0) message.tags = tags;
  }

  if (m.idempotencyKey !== undefined && m.idempotencyKey !== null) {
    const key = m.idempotencyKey;
    if (typeof key !== "string" || !key || key.length > MAX_IDEMPOTENCY_KEY_LENGTH || /[\r\n]/.test(key)) {
      throw invalid(`\`idempotencyKey\` debe ser un texto de 1 a ${MAX_IDEMPOTENCY_KEY_LENGTH} caracteres`);
    }
    message.idempotencyKey = key;
  }

  return message;
}
