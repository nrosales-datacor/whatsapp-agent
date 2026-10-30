// ─────────────────────────────────────────────────────────────────────────────
// Fail-closed de secretos al arrancar en producción (lo llama src/server.ts ANTES de
// cargar la app). Sin estos secretos el proceso no debe atender ni un request:
//
//   • PANEL_SESSION_SECRET: firma las sesiones. Sin él cada arranque usaría uno al azar
//     (todos deslogueados en cada deploy; con varias réplicas, cada una firmaría distinto).
//     Con uno adivinable (p. ej. el placeholder público de .env.example) cualquiera puede
//     FORJAR sesiones: por eso se exige largo (≥32) y una entropía razonable.
//   • TOKENS_ENCRYPTION_KEY: cifra en reposo los secretos de cada negocio y de cada
//     usuario (token de WhatsApp, secreto del 2FA). Sin ella no hay dónde guardarlos.
//   • WHATSAPP_APP_SECRET / WHATSAPP_VERIFY_TOKEN: opcionales, pero SI están definidos
//     reciben el mismo trato que el secreto de sesión (el primero firma los webhooks de
//     Meta: con un valor conocido cualquiera inyecta mensajes falsos).
//   • HEALTH_DETAIL_TOKEN: opcional; si está definido, no puede ser el placeholder.
//
// Ningún valor conocido de .env.example (que es PÚBLICO) se acepta en producción. La
// lista de abajo se mantiene a mano; test/security/requiredSecrets.test.ts lee
// .env.example y falla si aparece un placeholder nuevo que no esté acá.
//
// Los módulos que los usan (src/platform/auth/sessionToken.ts, src/platform/crypto/
// secrets.ts) igual se niegan a cargar sin ellos; este chequeo existe para fallar ANTES,
// con TODOS los problemas juntos y un mensaje claro, y no con el stack del primer import.
// Los mensajes NUNCA incluyen el valor del secreto.
// ─────────────────────────────────────────────────────────────────────────────

type Env = Record<string, string | undefined>;

export const MIN_SECRET_LENGTH = 32;
/** Piso de la estimación de entropía (Shannon por carácter × largo), en bits. */
const MIN_ESTIMATED_BITS = 80;
/** Mínimo de caracteres distintos (descarta "aaaa…", "abab…" y parecidos). */
const MIN_DISTINCT_CHARS = 8;

/** Placeholders publicados en .env.example (y sus variantes obvias): nunca valen en producción. */
export const KNOWN_PLACEHOLDERS: readonly string[] = [
  "cambiame-por-una-cadena-larga-al-azar",
  "un-token-secreto-que-vos-elegis",
  "cadena-larga-al-azar",
  "salt:hash",
];

/** Palabras que delatan un valor de ejemplo copiado tal cual (en minúscula). */
const PLACEHOLDER_WORDS = ["cambiame", "changeme", "change-me", "placeholder", "ejemplo", "example", "al-azar", "vos-elegis"];

/** ¿El valor es (o contiene) un placeholder conocido? */
export function isKnownPlaceholder(value: string): boolean {
  const v = value.trim().toLowerCase();
  if (!v) return false;
  return KNOWN_PLACEHOLDERS.some((p) => v === p.toLowerCase()) || PLACEHOLDER_WORDS.some((w) => v.includes(w));
}

/** Estimación (gruesa) de bits de entropía: Shannon por carácter × largo. */
export function estimatedEntropyBits(value: string): number {
  const chars = [...value];
  if (chars.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const ch of chars) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let perChar = 0;
  for (const n of counts.values()) {
    const p = n / chars.length;
    perChar -= p * Math.log2(p);
  }
  return perChar * chars.length;
}

/** ¿Es un patrón que se repite ("0123…0123…")? Truco clásico: s aparece dentro de s+s antes del final. */
function isPeriodic(value: string): boolean {
  return value.length > 1 && (value + value).indexOf(value, 1) < value.length;
}

/**
 * Problema de un secreto "fuerte" (null = está bien). `required` = falta es problema;
 * si no, solo se valida cuando está definido.
 */
function strongSecretProblem(name: string, raw: string | undefined, required: boolean): string | null {
  const value = (raw ?? "").trim();
  if (!value) return required ? `${name} falta (mínimo ${MIN_SECRET_LENGTH} caracteres al azar; mejor 64 hex).` : null;
  if (isKnownPlaceholder(value)) return `${name} es el valor de ejemplo de .env.example (público): generá uno nuevo al azar.`;
  if (value.length < MIN_SECRET_LENGTH) return `${name} es corto (mínimo ${MIN_SECRET_LENGTH} caracteres al azar; mejor 64 hex).`;
  const distinct = new Set(value).size;
  if (distinct < MIN_DISTINCT_CHARS || isPeriodic(value) || estimatedEntropyBits(value) < MIN_ESTIMATED_BITS) {
    return `${name} tiene poca entropía (parece un patrón o una palabra): generá uno al azar.`;
  }
  return null;
}

const HEX_64 = /^[0-9a-fA-F]{64}$/;

/** Generador sugerido en los mensajes (32 bytes al azar en hex). */
const GENERATE_HINT = `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`;

/** Problemas de configuración de secretos (vacío = todo bien). Fuera de producción no exige nada. */
export function productionSecretProblems(env: Env = process.env): string[] {
  if (env.NODE_ENV !== "production") return [];
  const problems: string[] = [];
  const add = (p: string | null) => {
    if (p) problems.push(p);
  };
  add(strongSecretProblem("PANEL_SESSION_SECRET", env.PANEL_SESSION_SECRET, true));
  const key = (env.TOKENS_ENCRYPTION_KEY ?? "").trim();
  if (!HEX_64.test(key)) {
    problems.push("TOKENS_ENCRYPTION_KEY falta o no tiene el formato (64 caracteres hex = 32 bytes).");
  } else if (new Set(key.toLowerCase()).size < MIN_DISTINCT_CHARS || isPeriodic(key.toLowerCase())) {
    problems.push(`TOKENS_ENCRYPTION_KEY tiene poca entropía (parece un patrón): generala con ${GENERATE_HINT}.`);
  }
  add(strongSecretProblem("WHATSAPP_APP_SECRET", env.WHATSAPP_APP_SECRET, false));
  add(strongSecretProblem("WHATSAPP_VERIFY_TOKEN", env.WHATSAPP_VERIFY_TOKEN, false));
  if (env.HEALTH_DETAIL_TOKEN?.trim() && isKnownPlaceholder(env.HEALTH_DETAIL_TOKEN)) {
    problems.push("HEALTH_DETAIL_TOKEN es el valor de ejemplo de .env.example (público): generá uno nuevo al azar.");
  }
  return problems;
}

/** Avisos que no frenan el arranque pero sí una función (p. ej. los links de los correos). */
export function productionConfigWarnings(env: Env = process.env): string[] {
  if (env.NODE_ENV !== "production") return [];
  const warnings: string[] = [];
  if (!env.PUBLIC_BASE_URL?.trim()) {
    warnings.push("PUBLIC_BASE_URL sin configurar: las invitaciones y la recuperación de clave van a fallar.");
  }
  if (!env.PANEL_SUPERADMIN_USERNAME?.trim() || !env.PANEL_SUPERADMIN_HASH?.trim()) {
    warnings.push("Superadmin sin configurar (PANEL_SUPERADMIN_USERNAME / PANEL_SUPERADMIN_HASH): nadie puede crear negocios.");
  } else if (isKnownPlaceholder(env.PANEL_SUPERADMIN_HASH)) {
    warnings.push("PANEL_SUPERADMIN_HASH es el valor de ejemplo de .env.example: nadie puede entrar como superadmin.");
  }
  return warnings;
}
