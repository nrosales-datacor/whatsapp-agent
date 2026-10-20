// ─────────────────────────────────────────────────────────────────────────────
// Normaliza el resultado de `db.execute(sql`…`)` a un arreglo de filas.
//
// Los dos drivers de Postgres que usamos devuelven formas distintas para el SQL crudo:
// postgres.js (producción / Supabase) devuelve el arreglo de filas directamente,
// mientras que el driver PGlite (desarrollo y tests, en el proceso, sin servidor)
// devuelve `{ rows: [...] }`. Este helper deja el código AGNÓSTICO del driver.
//
// Con postgres.js `r` ya es el arreglo (o una subclase de Array), así que
// `Array.isArray(r)` es true y se devuelve tal cual.
// ─────────────────────────────────────────────────────────────────────────────
export function rowsOf<T = unknown>(r: unknown): T[] {
  if (Array.isArray(r)) return r as T[];
  const rows = (r as { rows?: unknown } | null)?.rows;
  return Array.isArray(rows) ? (rows as T[]) : [];
}
