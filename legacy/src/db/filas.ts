// ─────────────────────────────────────────────────────────────────────────────
// Normaliza el resultado de `db.execute(sql`…`)` a un arreglo de filas.
//
// Los dos drivers de Postgres que usamos devuelven formas distintas para el
// SQL crudo: postgres.js (producción / Supabase) devuelve el arreglo de filas
// directamente, mientras que el driver PGlite (usado in-process por los tests de
// fiabilidad, sin servidor) devuelve `{ rows: [...] }`. Este helper deja el
// código de las colas AGNÓSTICO del driver.
//
// Comportamiento en producción sin cambios: con postgres.js `r` ya es el arreglo
// (o una subclase de Array), así que `Array.isArray(r)` es true y se devuelve tal cual.
// ─────────────────────────────────────────────────────────────────────────────
export function filasDe<T = unknown>(r: unknown): T[] {
  if (Array.isArray(r)) return r as T[];
  const rows = (r as { rows?: unknown } | null)?.rows;
  return Array.isArray(rows) ? (rows as T[]) : [];
}
