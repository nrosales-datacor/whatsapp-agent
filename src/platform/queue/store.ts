import { sql, type SQL } from "drizzle-orm";
import { rowsOf } from "../db/rows";
import { withSystem, type Executor } from "../db/scope";

// ─────────────────────────────────────────────────────────────────────────────
// SQL del ciclo de vida de un job: reclamar, cerrar (hecho / reintento / dead), latido y
// recuperación de locks vencidos. Todo en contexto de sistema: el worker atiende a todos
// los negocios.
//
// Patrón (heredado de legacy/src/queue/cola.ts): claim en una transacción CORTA con
// `FOR UPDATE SKIP LOCKED` → el trabajo corre FUERA de transacción (segundos de LLM o de
// un proveedor sin retener una conexión ni locks) → otra transacción corta lo cierra.
// Pooler-safe: sin advisory locks de sesión; el único advisory lock (exclusión por grupo)
// es de TRANSACCIÓN.
//
// Fencing: cada cierre exige `status = 'running' AND locked_by = <yo> AND attempts = <el
// intento que reclamé>`. Si mi lock venció y otro worker ya lo recuperó (o lo reclamó de
// nuevo), mi cierre tardío no pisa nada: afecta 0 filas.
// ─────────────────────────────────────────────────────────────────────────────

/** Job ya reclamado (`running`) por este worker. */
export interface ClaimedJob {
  id: string;
  businessId: string | null;
  type: string;
  payload: unknown;
  /** Número de este intento (ya sumado al reclamar). */
  attempt: number;
  maxAttempts: number;
  groupKey: string | null;
}

// Balde de los jobs de sistema en el reparto (no hay negocio con este id).
const SYSTEM_BUCKET = "00000000-0000-0000-0000-000000000000";

// ─────────────────────────────────────────────────────────────────────────────
// Reglas del claim (valen igual entre slots de un proceso y entre réplicas):
//
// 1) Solo tipos que este proceso sabe correr y con cupo (`types`).
//
// 2) Reparto entre negocios (F8 del motor viejo, mejorado): un negocio con 500 jobs
//    encolados no monopoliza los slots. Orden de preferencia:
//      a. el negocio con MENOS jobs `running` ahora;
//      b. el job más adelantado de su negocio primero (`rn`: se intercalan negocios en vez
//         de vaciar uno);
//      c. el negocio atendido hace MÁS tiempo (último `locked_at`; nunca atendido primero):
//         round-robin real aun con un solo slot, donde (a) siempre empata en 0;
//      d. el más viejo (`run_after`, `created_at`).
//    Se consideran hasta `perBusiness` candidatos por negocio: si otro worker tiene
//    bloqueado el primero de un negocio (SKIP LOCKED), se puede tomar el segundo.
//
// 3) Un job `running` como mucho por (negocio, group_key). El NOT EXISTS filtra a los
//    candidatos cuyo grupo ya está en vuelo; como en READ COMMITTED dos claims simultáneos
//    no ven el UPDATE ajeno sin commit, además se toma un advisory lock de TRANSACCIÓN
//    por grupo y se re-chequea con el lock en mano. Quien no consigue el lock no espera:
//    devuelve "nada" y reintenta en el próximo poll.
// ─────────────────────────────────────────────────────────────────────────────

interface ClaimRow {
  id: string;
  business_id: string | null;
  type: string;
  payload: unknown;
  attempts: number;
  max_attempts: number;
  group_key: string | null;
}

/**
 * Reclama UN job listo de alguno de `types` y lo pone `running` a nombre de `workerId`.
 * null si no hay ninguno (o si el elegido es de un grupo que otro claim está tomando).
 */
export async function claimJob(
  db: Executor,
  options: { types: readonly string[]; workerId: string; perBusiness: number },
): Promise<ClaimedJob | null> {
  const { types, workerId } = options;
  if (types.length === 0) return null;
  const perBusiness = Math.max(1, Math.floor(options.perBusiness));
  const typeList = sql.join(
    types.map((t) => sql`${t}`),
    sql`, `,
  );

  return withSystem(db, async (tx) => {
    const [row] = rowsOf<ClaimRow>(
      await tx.execute(sql`
        WITH ready AS (
          SELECT j.id, coalesce(j.business_id, ${SYSTEM_BUCKET}::uuid) AS bucket, j.run_after, j.created_at,
                 row_number() OVER (
                   PARTITION BY coalesce(j.business_id, ${SYSTEM_BUCKET}::uuid) ORDER BY j.run_after, j.created_at
                 ) AS rn
            FROM jobs j
           WHERE j.status IN ('pending', 'failed') AND j.run_after <= now()
             AND j.type IN (${typeList})
             AND (j.group_key IS NULL OR NOT EXISTS (
               SELECT 1 FROM jobs g
                WHERE g.status = 'running' AND g.group_key = j.group_key
                  AND g.business_id IS NOT DISTINCT FROM j.business_id
             ))
        ),
        candidates AS (
          SELECT * FROM ready WHERE rn <= ${perBusiness}
        ),
        buckets AS (
          SELECT b.bucket,
                 (SELECT count(*) FROM jobs r
                   WHERE r.status = 'running'
                     AND (CASE WHEN b.bucket = ${SYSTEM_BUCKET}::uuid THEN r.business_id IS NULL ELSE r.business_id = b.bucket END)
                 ) AS in_flight,
                 (CASE WHEN b.bucket = ${SYSTEM_BUCKET}::uuid
                       THEN (SELECT max(x.locked_at) FROM jobs x WHERE x.business_id IS NULL)
                       ELSE (SELECT max(x.locked_at) FROM jobs x WHERE x.business_id = b.bucket)
                  END) AS last_claimed_at
            FROM (SELECT DISTINCT bucket FROM candidates) b
        )
        SELECT j.id, j.business_id, j.type, j.payload, j.attempts, j.max_attempts, j.group_key
          FROM jobs j
          JOIN candidates c ON c.id = j.id
          JOIN buckets b ON b.bucket = c.bucket
         WHERE j.status IN ('pending', 'failed') AND j.run_after <= now()
         ORDER BY b.in_flight ASC, c.rn ASC, b.last_claimed_at ASC NULLS FIRST, c.run_after ASC, c.created_at ASC
         LIMIT 1
           FOR UPDATE OF j SKIP LOCKED
      `),
    );
    if (!row) return null;

    if (row.group_key !== null) {
      // Regla 3: exclusión por grupo entre claims simultáneos.
      const lockKey = `jobs:group:${row.business_id ?? "system"}:${row.group_key}`;
      const [lock] = rowsOf<{ ok: boolean }>(
        await tx.execute(sql`SELECT pg_try_advisory_xact_lock(hashtextextended(${lockKey}, 0)) AS ok`),
      );
      if (!lock?.ok) return null;
      const busy = rowsOf<{ id: string }>(
        await tx.execute(sql`
          SELECT id FROM jobs
           WHERE status = 'running' AND group_key = ${row.group_key}
             AND business_id IS NOT DISTINCT FROM ${row.business_id}::uuid
           LIMIT 1
        `),
      );
      if (busy.length > 0) return null;
    }

    const [claimed] = rowsOf<{ attempts: number }>(
      await tx.execute(sql`
        UPDATE jobs
           SET status = 'running', locked_at = now(), locked_by = ${workerId}, attempts = attempts + 1
         WHERE id = ${row.id}
        RETURNING attempts
      `),
    );
    return {
      id: row.id,
      businessId: row.business_id,
      type: row.type,
      payload: row.payload,
      attempt: Number(claimed.attempts),
      maxAttempts: Number(row.max_attempts),
      groupKey: row.group_key,
    };
  });
}

/** Guardia de fencing de todo cierre (ver cabecera). */
function ownedBy(job: ClaimedJob, workerId: string) {
  return sql`id = ${job.id} AND status = 'running' AND locked_by = ${workerId} AND attempts = ${job.attempt}`;
}

async function updateOwned(db: Executor, job: ClaimedJob, workerId: string, set: SQL): Promise<boolean> {
  const rows = rowsOf<{ id: string }>(
    await withSystem(db, (tx) => tx.execute(sql`UPDATE jobs SET ${set} WHERE ${ownedBy(job, workerId)} RETURNING id`)),
  );
  return rows.length > 0;
}

/** Cierra el job como hecho. false si ya no era mío (lock vencido y recuperado). */
export function markJobDone(db: Executor, job: ClaimedJob, workerId: string): Promise<boolean> {
  return updateOwned(db, job, workerId, sql`status = 'done', locked_by = NULL, finished_at = now()`);
}

/** Falló un intento y quedan intentos: `failed`, reclamable de nuevo dentro de `delayMs`. */
export function markJobForRetry(db: Executor, job: ClaimedJob, workerId: string, error: string, delayMs: number): Promise<boolean> {
  return updateOwned(
    db,
    job,
    workerId,
    sql`status = 'failed', locked_by = NULL, last_error = ${error},
        run_after = now() + ${Math.max(0, Math.round(delayMs))} * interval '1 millisecond'`,
  );
}

/** Sin más intentos o error permanente: `dead` (DLQ). */
export function markJobDead(db: Executor, job: ClaimedJob, workerId: string, error: string): Promise<boolean> {
  return updateOwned(db, job, workerId, sql`status = 'dead', locked_by = NULL, last_error = ${error}, finished_at = now()`);
}

/**
 * Devuelve un job reclamado SIN haberlo corrido (p. ej. llegó el apagado justo después
 * del claim): vuelve a `pending` y se descuenta el intento, como si nunca se hubiera
 * tomado.
 */
export function releaseJob(db: Executor, job: ClaimedJob, workerId: string): Promise<boolean> {
  return updateOwned(
    db,
    job,
    workerId,
    sql`status = CASE WHEN attempts > 1 THEN 'failed' ELSE 'pending' END,
        locked_by = NULL, attempts = attempts - 1, run_after = now()`,
  );
}

/**
 * Posterga un job reclamado SIN correrlo (p. ej. su negocio está pausado): como
 * `releaseJob` (descuenta el intento: postergar no gasta reintentos), pero reclamable
 * recién dentro de `delayMs`.
 */
export function deferJob(db: Executor, job: ClaimedJob, workerId: string, delayMs: number): Promise<boolean> {
  return updateOwned(
    db,
    job,
    workerId,
    sql`status = CASE WHEN attempts > 1 THEN 'failed' ELSE 'pending' END,
        locked_by = NULL, attempts = attempts - 1,
        run_after = now() + ${Math.max(0, Math.round(delayMs))} * interval '1 millisecond'`,
  );
}

/**
 * Latido: renueva `locked_at` de los jobs que este worker sigue corriendo, para que la
 * recuperación no se los saque a un job lento pero vivo. Devuelve cuántos renovó.
 */
export async function heartbeatJobs(db: Executor, workerId: string, ids: readonly string[]): Promise<number> {
  if (ids.length === 0) return 0;
  const idList = sql.join(
    ids.map((id) => sql`${id}::uuid`),
    sql`, `,
  );
  const rows = rowsOf<{ id: string }>(
    await withSystem(db, (tx) =>
      tx.execute(sql`
        UPDATE jobs SET locked_at = now()
         WHERE status = 'running' AND locked_by = ${workerId} AND id IN (${idList})
        RETURNING id
      `),
    ),
  );
  return rows.length;
}

export interface RecoveredJob {
  id: string;
  type: string;
  businessId: string | null;
  status: "failed" | "dead";
}

export const LOCK_EXPIRED_ERROR = "lock vencido: el worker que lo corría murió o se colgó";

/**
 * Recupera los jobs `running` cuyo lock venció hace más de `lockTimeoutMs` (el worker
 * murió: crash, deploy sin apagado ordenado, máquina caída). Con intentos disponibles
 * quedan `failed` y reclamables ya (el lock vencido ya fue espera suficiente); sin
 * intentos, `dead`: un job que tumba al proceso cada vez (poison pill) no se repite para
 * siempre. Una sola sentencia atómica: correrla en varias réplicas a la vez es inofensivo.
 */
export async function recoverExpiredJobs(db: Executor, lockTimeoutMs: number): Promise<RecoveredJob[]> {
  const rows = rowsOf<{ id: string; type: string; business_id: string | null; status: "failed" | "dead" }>(
    await withSystem(db, (tx) =>
      tx.execute(sql`
        UPDATE jobs
           SET status = CASE WHEN attempts >= max_attempts THEN 'dead' ELSE 'failed' END,
               finished_at = CASE WHEN attempts >= max_attempts THEN now() ELSE NULL END,
               locked_by = NULL,
               last_error = ${LOCK_EXPIRED_ERROR},
               run_after = now()
         WHERE status = 'running'
           AND locked_at < now() - ${Math.max(0, Math.round(lockTimeoutMs))} * interval '1 millisecond'
        RETURNING id, type, business_id, status
      `),
    ),
  );
  return rows.map((r) => ({ id: r.id, type: r.type, businessId: r.business_id, status: r.status }));
}
