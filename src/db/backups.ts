// ─────────────────────────────────────────────────────────────────────────────
// Lógica pura del backup diario (`scripts/backupDb.ts`), separada para testearla
// sin `pg_dump` ni disco (revisión pre-venta 2026-10).
//
// POR QUÉ: el script podaba SIEMPRE, aunque el backup de hoy hubiera fallado, y un
// `pg_dump` caído a la mitad dejaba un `.gz` truncado con la fecha de hoy que
// parecía bueno. Con 14 días seguidos de fallos sin alerta, no quedaba ningún
// respaldo restaurable.
// ─────────────────────────────────────────────────────────────────────────────

/** Línea con la que `pg_dump` (formato plain) cierra un volcado completo. */
export const MARCA_DUMP_COMPLETO = "PostgreSQL database dump complete";

/** true si el final del volcado (texto SIN comprimir) trae la marca de cierre. */
export function dumpCompleto(colaDelDump: string): boolean {
  return colaDelDump.includes(MARCA_DUMP_COMPLETO);
}

export interface ArchivoBackup {
  nombre: string;
  mtimeMs: number;
}

/**
 * Qué backups borrar: los más viejos que `retencionDias`, pero NUNCA dejando menos
 * de `minimoAConservar` (se conservan siempre los N más recientes, aunque sean
 * viejos). El llamador solo poda si el backup de hoy salió bien.
 */
export function elegirBackupsAPodar(
  archivos: ArchivoBackup[],
  ahoraMs: number,
  retencionDias: number,
  minimoAConservar: number,
): string[] {
  const ordenados = [...archivos].sort((a, b) => b.mtimeMs - a.mtimeMs); // más nuevo primero
  return ordenados
    .slice(Math.max(0, minimoAConservar))
    .filter((a) => (ahoraMs - a.mtimeMs) / 86_400_000 > retencionDias)
    .map((a) => a.nombre);
}
