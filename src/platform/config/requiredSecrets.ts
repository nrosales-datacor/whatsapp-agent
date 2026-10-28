// ─────────────────────────────────────────────────────────────────────────────
// Fail-closed de secretos al arrancar en producción (lo llama src/server.ts ANTES de
// cargar la app). Sin estos secretos el proceso no debe atender ni un request:
//
//   • PANEL_SESSION_SECRET: firma las sesiones. Sin él cada arranque usaría uno al azar
//     (todos deslogueados en cada deploy; con varias réplicas, cada una firmaría distinto).
//   • TOKENS_ENCRYPTION_KEY: cifra en reposo los secretos de cada negocio y de cada
//     usuario (token de WhatsApp, secreto del 2FA). Sin ella no hay dónde guardarlos.
//
// Los módulos que los usan (src/platform/auth/sessionToken.ts, src/platform/crypto/
// secrets.ts) igual se niegan a cargar sin ellos; este chequeo existe para fallar ANTES,
// con TODOS los problemas juntos y un mensaje claro, y no con el stack del primer import.
// ─────────────────────────────────────────────────────────────────────────────

type Env = Record<string, string | undefined>;

const MIN_SESSION_SECRET_LENGTH = 16;

/** Problemas de configuración de secretos (vacío = todo bien). Fuera de producción no exige nada. */
export function productionSecretProblems(env: Env = process.env): string[] {
  if (env.NODE_ENV !== "production") return [];
  const problems: string[] = [];
  const sessionSecret = env.PANEL_SESSION_SECRET ?? "";
  if (sessionSecret.length < MIN_SESSION_SECRET_LENGTH) {
    problems.push(`PANEL_SESSION_SECRET falta o es corto (mínimo ${MIN_SESSION_SECRET_LENGTH} caracteres; mejor 64 hex al azar).`);
  }
  const key = env.TOKENS_ENCRYPTION_KEY ?? "";
  if (!/^[0-9a-fA-F]{64}$/.test(key)) {
    problems.push("TOKENS_ENCRYPTION_KEY falta o no tiene el formato (64 caracteres hex = 32 bytes).");
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
  }
  // Cobro en línea (Stripe, I6): configurado a medias queda apagado; mejor saberlo al arrancar.
  if (env.STRIPE_SECRET_KEY?.trim() && !env.STRIPE_WEBHOOK_SECRET?.trim()) {
    warnings.push("STRIPE_SECRET_KEY sin STRIPE_WEBHOOK_SECRET: el cobro en línea queda apagado (el webhook no puede verificar eventos).");
  }
  if (env.STRIPE_SECRET_KEY?.trim() && !env.STRIPE_PRICE_BASIC?.trim() && !env.STRIPE_PRICE_PRO?.trim()) {
    warnings.push("Stripe sin precios (STRIPE_PRICE_BASIC / STRIPE_PRICE_PRO): el cobro en línea queda apagado.");
  }
  return warnings;
}
