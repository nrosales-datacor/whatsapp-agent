// ─────────────────────────────────────────────────────────────────────────────
// Datos personales en los logs (Ley 8968).
//
// Los logs (`pm2 logs`, Sentry, un colector externo) NO son un lugar para datos
// personales del cliente final: los lee más gente que el panel, se copian a otros
// sistemas y no los alcanza el borrado de un cliente. Reglas para cualquier
// console.* / log.* del backend:
//   - El teléfono del cliente final va SIEMPRE enmascarado: maskPhone().
//   - El CONTENIDO de un mensaje (texto entrante, transcripción, respuesta del bot,
//     notas, nombres de archivo/contacto) NO se loguea: solo su tipo y su longitud
//     (describeText()). Para depurar una conversación está el panel.
// test/security/logsWithoutPii.test.ts falla si un log interpola esas variables sin
// pasar por estos helpers.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * "50688887777" → "506***7777". Deja el prefijo de país (3 dígitos) y los últimos 4 para
 * poder correlacionar con el panel sin exponer el número completo. Con 8 dígitos o menos
 * solo deja los últimos 2. Idempotente: un valor ya enmascarado (con `*`) se devuelve
 * tal cual.
 */
export function maskPhone(phone: string | null | undefined): string {
  if (!phone) return "—";
  if (phone.includes("*")) return phone;
  const digits = phone.replace(/\D/g, "");
  if (digits.length === 0) return "***";
  if (digits.length <= 8) return `***${digits.slice(-2)}`;
  return `${digits.slice(0, 3)}***${digits.slice(-4)}`;
}

/** Describe un contenido sin revelarlo: "[42 car.]" (o "[vacío]"). */
export function describeText(text: string | null | undefined): string {
  if (!text) return "[vacío]";
  return `[${text.length} car.]`;
}

// Campos que, si llegan a log.* (./log.ts), se sanean solos como red de seguridad,
// aunque quien loguea se olvide del helper.
const PHONE_FIELDS = new Set(["phone", "clientPhone", "to"]);
const CONTENT_FIELDS = new Set(["text", "content", "reply", "body", "transcript", "notes"]);

/** Copia de `fields` con teléfonos enmascarados y contenidos reemplazados por su longitud. */
export function sanitizeLogFields(fields: Record<string, unknown>): Record<string, unknown> {
  let copy: Record<string, unknown> | null = null;
  for (const [key, value] of Object.entries(fields)) {
    let clean: unknown = value;
    if (PHONE_FIELDS.has(key) && typeof value === "string") clean = maskPhone(value);
    else if (CONTENT_FIELDS.has(key) && typeof value === "string") clean = describeText(value);
    if (clean !== value) {
      copy ??= { ...fields };
      copy[key] = clean;
    }
  }
  return copy ?? fields;
}
