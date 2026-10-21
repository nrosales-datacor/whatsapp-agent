// ─────────────────────────────────────────────────────────────────────────────
// Códigos de error de Postgres que la app trata a propósito (no como un 500).
//
// Drizzle envuelve el error original del driver (postgres.js en producción, PGlite en
// desarrollo y tests) en uno propio con `cause`: `hasPgCode` recorre esa cadena.
// ─────────────────────────────────────────────────────────────────────────────

/** Violación de una FK: p. ej. borrar una fila que otra referencia con NO ACTION. */
export const PG_FOREIGN_KEY_VIOLATION = "23503";

/** Violación de un índice único. */
export const PG_UNIQUE_VIOLATION = "23505";

/** ¿El error (o alguno de su cadena de `cause`) trae este código de Postgres? */
export function hasPgCode(error: unknown, code: string): boolean {
  for (let current: unknown = error, depth = 0; current && depth < 6; depth++) {
    if ((current as { code?: unknown }).code === code) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}
