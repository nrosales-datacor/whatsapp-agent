// ─────────────────────────────────────────────────────────────────────────────
// Lógica pura del backup diario (`scripts/backupDb.ts`), separada para testearla sin
// `pg_dump` ni disco.
//
// POR QUÉ: el script podaba SIEMPRE, aunque el backup de hoy hubiera fallado, y un
// `pg_dump` caído a la mitad dejaba un `.gz` truncado con la fecha de hoy que parecía
// bueno. Con 14 días seguidos de fallos sin alerta, no quedaba ningún respaldo
// restaurable.
// ─────────────────────────────────────────────────────────────────────────────

/** Línea con la que `pg_dump` (formato plain) cierra un volcado completo. */
export const DUMP_COMPLETE_MARKER = "PostgreSQL database dump complete";

/** true si el final del volcado (texto SIN comprimir) trae la marca de cierre. */
export function isDumpComplete(dumpTail: string): boolean {
  return dumpTail.includes(DUMP_COMPLETE_MARKER);
}

export interface BackupFile {
  name: string;
  mtimeMs: number;
}

/**
 * Qué backups borrar: los más viejos que `retentionDays`, pero NUNCA dejando menos de
 * `minToKeep` (se conservan siempre los N más recientes, aunque sean viejos). El
 * llamador solo poda si el backup de hoy salió bien.
 */
export function selectBackupsToPrune(
  files: BackupFile[],
  nowMs: number,
  retentionDays: number,
  minToKeep: number,
): string[] {
  const newestFirst = [...files].sort((a, b) => b.mtimeMs - a.mtimeMs);
  return newestFirst
    .slice(Math.max(0, minToKeep))
    .filter((f) => (nowMs - f.mtimeMs) / 86_400_000 > retentionDays)
    .map((f) => f.name);
}
