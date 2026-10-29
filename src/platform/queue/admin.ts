import { sql } from "drizzle-orm";
import { rowsOf } from "../db/rows";
import { isTenantId, withSystem, withTenant, type Executor } from "../db/scope";
import type { JobStatus } from "./schema";

// ─────────────────────────────────────────────────────────────────────────────
// Operación de la cola: ver el DLQ, reencolar un job muerto, purgar terminados y contar
// por estado. Las consume el superadmin (y, con `businessId`, el panel de un negocio:
// corren con `withTenant` y solo ven lo suyo).
// ─────────────────────────────────────────────────────────────────────────────

/** Una fila del DLQ: resumen liviano, SIN el payload (puede ser grande y traer datos personales). */
export interface DeadJob {
  id: string;
  businessId: string | null;
  type: string;
  attempts: number;
  maxAttempts: number;
  lastError: string | null;
  groupKey: string | null;
  dedupeKey: string | null;
  createdAt: Date;
  finishedAt: Date | null;
}

interface DeadJobRow {
  id: string;
  business_id: string | null;
  type: string;
  attempts: number;
  max_attempts: number;
  last_error: string | null;
  group_key: string | null;
  dedupe_key: string | null;
  created_at: Date | string;
  finished_at: Date | string | null;
}

function toDate(v: Date | string): Date {
  return v instanceof Date ? v : new Date(v);
}

/**
 * Jobs en `dead`, más recientes primero. Con `businessId`, solo los de ese negocio (en su
 * contexto RLS); sin él, todos (contexto de sistema, solo superadmin).
 */
export async function listDeadJobs(
  db: Executor,
  options: { businessId?: string; type?: string; limit?: number } = {},
): Promise<DeadJob[]> {
  const limit = Math.min(Math.max(1, Math.floor(options.limit ?? 100)), 1000);
  const query = sql`
    SELECT id, business_id, type, attempts, max_attempts, last_error, group_key, dedupe_key, created_at, finished_at
      FROM jobs
     WHERE status = 'dead'
       ${options.businessId ? sql`AND business_id = ${options.businessId}::uuid` : sql``}
       ${options.type ? sql`AND type = ${options.type}` : sql``}
     ORDER BY finished_at DESC NULLS LAST
     LIMIT ${limit}
  `;
  const result = options.businessId
    ? await withTenant(db, options.businessId, (tx) => tx.execute(query))
    : await withSystem(db, (tx) => tx.execute(query));
  return rowsOf<DeadJobRow>(result).map((r) => ({
    id: r.id,
    businessId: r.business_id,
    type: r.type,
    attempts: Number(r.attempts),
    maxAttempts: Number(r.max_attempts),
    lastError: r.last_error,
    groupKey: r.group_key,
    dedupeKey: r.dedupe_key,
    createdAt: toDate(r.created_at),
    finishedAt: r.finished_at === null ? null : toDate(r.finished_at),
  }));
}

/**
 * Reencola un job del DLQ: vuelve a `pending`, reclamable ya, con los intentos en 0.
 * Quien lo reencola a mano asume resuelta la causa (se reconectó la integración, se
 * corrigió el dato): dejarlo con los intentos agotados lo mandaría de vuelta a `dead` al
 * primer fallo transitorio. `last_error` se conserva como contexto hasta el próximo fallo.
 *
 * Solo actúa sobre `dead` (el WHERE del propio UPDATE): reencolar dos veces, o un job que
 * ya no está muerto, es un no-op atómico. Devuelve true si reencoló.
 */
export async function retryJob(db: Executor, id: string): Promise<boolean> {
  if (!isTenantId(id)) return false; // misma forma uuid: un id malformado no existe
  const rows = rowsOf<{ id: string }>(
    await withSystem(db, (tx) =>
      tx.execute(sql`
        UPDATE jobs
           SET status = 'pending', attempts = 0, run_after = now(), finished_at = NULL, locked_by = NULL
         WHERE id = ${id}::uuid AND status = 'dead'
        RETURNING id
      `),
    ),
  );
  return rows.length > 0;
}

/**
 * Borra los jobs terminados antes de `olderThan` (por `finished_at`): `done` siempre;
 * `dead` solo con `includeDead` (el DLQ se conserva hasta que alguien lo revise). Es lo que
 * evita que la tabla crezca sin límite: cada job deja su payload para siempre.
 *
 * Borra en LOTES, cada uno en su propia transacción corta: un DELETE gigante retendría
 * locks que el claim necesita. Devuelve el total borrado.
 */
export async function purgeFinishedJobs(
  db: Executor,
  olderThan: Date,
  options: { includeDead?: boolean; batchSize?: number } = {},
): Promise<number> {
  const batchSize = Math.max(1, Math.floor(options.batchSize ?? 500));
  const statuses = options.includeDead ? sql`('done', 'dead')` : sql`('done')`;
  let total = 0;
  for (;;) {
    const rows = rowsOf<{ id: string }>(
      await withSystem(db, (tx) =>
        tx.execute(sql`
          DELETE FROM jobs
           WHERE id IN (
             SELECT id FROM jobs
              WHERE status IN ${statuses} AND finished_at < ${olderThan.toISOString()}::timestamptz
              ORDER BY finished_at ASC
              LIMIT ${batchSize}
           )
          RETURNING id
        `),
      ),
    );
    total += rows.length;
    // Lote incompleto = no queda nada más viejo que el corte (y el loop no es infinito).
    if (rows.length < batchSize) break;
  }
  return total;
}

/** Cantidad de jobs por tipo y estado (profundidad de la cola), para el superadmin y los detectores. */
export async function countJobs(db: Executor): Promise<{ type: string; status: JobStatus; count: number }[]> {
  const rows = rowsOf<{ type: string; status: JobStatus; count: number | string }>(
    await withSystem(db, (tx) =>
      tx.execute(sql`SELECT type, status, count(*) AS count FROM jobs GROUP BY type, status ORDER BY type, status`),
    ),
  );
  return rows.map((r) => ({ type: r.type, status: r.status, count: Number(r.count) }));
}
