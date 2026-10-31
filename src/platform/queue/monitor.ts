import { sql } from "drizzle-orm";
import { rowsOf } from "../db/rows";
import { withSystem, type Executor } from "../db/scope";
import { startLeaderLoop } from "../net/leaderLease";
import type { Loop } from "../net/scheduler";
import { alertPlatform, forgetAlert } from "../observability/alerts";
import { log } from "../observability/log";
import { numberFromEnv } from "../observability/rateAlert";
import { captureError } from "../observability/sentry";
import { registeredJobHandlers } from "./handlers";
import { queueConfigFromEnv } from "./worker";

// ─────────────────────────────────────────────────────────────────────────────
// Vigilante de la cola (loop con lease: corre en UNA réplica). Dos modos de falla que
// dejan a todos los negocios sin servicio sin que nada "se caiga" (/health sigue en 200):
//
//   • `queue_backlog` (critical): jobs listos (`pending`/`failed` con `run_after` vencido)
//     que nadie reclama hace más de `ALERTS_QUEUE_BACKLOG_MIN` (default 15). Worker caído o
//     saturado, slots colgados, la base rechazando el claim. Solo cuenta los tipos con
//     handler registrado en este proceso: un tipo sin handler queda `pending` a propósito
//     (src/jobs.ts) y alertaría para siempre. Un job postergado (negocio pausado) tiene su
//     `run_after` en el futuro: no cuenta.
//   • `queue_stuck` (critical): jobs `running` sin latido hace más de
//     `ALERTS_QUEUE_STUCK_MIN` (default 2 × QUEUE_LOCK_TIMEOUT_MS). La recuperación de
//     cada worker los libera al vencer el lock; si siguen ahí, la recuperación no corre.
//
// Al normalizarse, `forgetAlert`: una recaída vuelve a alertar en el acto, sin esperar el
// cooldown de la alerta anterior. Solo conteos y tiempos (sin payloads ni datos personales).
// ─────────────────────────────────────────────────────────────────────────────

export const QUEUE_BACKLOG_ALERT = "queue_backlog";
export const QUEUE_STUCK_ALERT = "queue_stuck";

export interface QueueMonitorThresholds {
  /** Un job listo hace más que esto sin que nadie lo reclame = backlog. */
  backlogMs: number;
  /** Un job `running` sin latido hace más que esto = atascado. */
  stuckMs: number;
}

/** Umbrales desde el entorno (documentados en .env.example y DEPLOY.md §22). */
export function queueMonitorThresholdsFromEnv(): QueueMonitorThresholds {
  const { lockTimeoutMs } = queueConfigFromEnv();
  const backlogMs = numberFromEnv("ALERTS_QUEUE_BACKLOG_MIN", 15, 1) * 60_000;
  // Nunca por debajo del lock + 1 min: antes de eso la recuperación normal todavía no actuó.
  const stuckMs = Math.max(numberFromEnv("ALERTS_QUEUE_STUCK_MIN", (2 * lockTimeoutMs) / 60_000, 1) * 60_000, lockTimeoutMs + 60_000);
  return { backlogMs, stuckMs };
}

export interface QueueHealth {
  /** Jobs listos hace más de `backlogMs` sin reclamar. */
  backlog: number;
  /** El `run_after` más viejo de esos (null si no hay). */
  oldestReadyAt: Date | null;
  /** Negocios con jobs en el backlog (el de sistema cuenta como uno). */
  backlogBusinesses: number;
  /** Jobs `running` sin latido hace más de `stuckMs`. */
  stuck: number;
  /** El `locked_at` más viejo de esos (null si no hay). */
  oldestLockedAt: Date | null;
}

const toDate = (v: Date | string | null): Date | null => (v === null ? null : v instanceof Date ? v : new Date(v));

/**
 * Foto de la salud de la cola en `now`. `types`: los tipos que cuentan para el backlog
 * (vacío = todos). Una sola consulta sobre los índices parciales de la cola.
 */
export async function readQueueHealth(
  db: Executor,
  options: QueueMonitorThresholds & { types?: readonly string[] },
  now: Date = new Date(),
): Promise<QueueHealth> {
  const backlogCut = new Date(now.getTime() - options.backlogMs).toISOString();
  const stuckCut = new Date(now.getTime() - options.stuckMs).toISOString();
  const types = options.types ?? [];
  const typeFilter = types.length > 0 ? sql`AND type IN (${sql.join(types.map((t) => sql`${t}`), sql`, `)})` : sql``;
  const [row] = rowsOf<{
    backlog: number | string;
    oldest_ready_at: Date | string | null;
    backlog_businesses: number | string;
    stuck: number | string;
    oldest_locked_at: Date | string | null;
  }>(
    await withSystem(db, (tx) =>
      tx.execute(sql`
        SELECT
          (SELECT count(*) FROM jobs
            WHERE status IN ('pending', 'failed') AND run_after < ${backlogCut}::timestamptz ${typeFilter}) AS backlog,
          (SELECT min(run_after) FROM jobs
            WHERE status IN ('pending', 'failed') AND run_after < ${backlogCut}::timestamptz ${typeFilter}) AS oldest_ready_at,
          (SELECT count(DISTINCT coalesce(business_id::text, 'system')) FROM jobs
            WHERE status IN ('pending', 'failed') AND run_after < ${backlogCut}::timestamptz ${typeFilter}) AS backlog_businesses,
          (SELECT count(*) FROM jobs
            WHERE status = 'running' AND locked_at < ${stuckCut}::timestamptz) AS stuck,
          (SELECT min(locked_at) FROM jobs
            WHERE status = 'running' AND locked_at < ${stuckCut}::timestamptz) AS oldest_locked_at
      `),
    ),
  );
  return {
    backlog: Number(row?.backlog ?? 0),
    oldestReadyAt: toDate(row?.oldest_ready_at ?? null),
    backlogBusinesses: Number(row?.backlog_businesses ?? 0),
    stuck: Number(row?.stuck ?? 0),
    oldestLockedAt: toDate(row?.oldest_locked_at ?? null),
  };
}

const minutesSince = (d: Date | null, now: Date) => (d ? Math.round((now.getTime() - d.getTime()) / 60_000) : 0);

/**
 * Un tick del vigilante: lee la salud y alerta (o olvida la alerta si se normalizó).
 * Devuelve la foto y qué alertas salieron.
 */
export async function checkQueueHealth(
  db: Executor,
  options: Partial<QueueMonitorThresholds> & { types?: readonly string[] } = {},
  now: Date = new Date(),
): Promise<{ health: QueueHealth; alerted: string[] }> {
  const thresholds = { ...queueMonitorThresholdsFromEnv(), ...options };
  const types = options.types ?? registeredJobHandlers().map((h) => h.type);
  const health = await readQueueHealth(db, { ...thresholds, types }, now);
  const alerted: string[] = [];

  if (health.backlog > 0) {
    const ageMin = minutesSince(health.oldestReadyAt, now);
    const fired = alertPlatform(
      {
        type: QUEUE_BACKLOG_ALERT,
        severity: "critical",
        message: `${health.backlog} job(s) listos sin reclamar hace más de ${Math.round(thresholds.backlogMs / 60_000)} min (el más viejo: ${ageMin} min, ${health.backlogBusinesses} negocio(s)). ¿Worker caído o saturado?`,
        data: { backlog: health.backlog, oldestAgeMin: ageMin, businesses: health.backlogBusinesses, thresholdMin: Math.round(thresholds.backlogMs / 60_000) },
      },
      now.getTime(),
    );
    if (fired) alerted.push(QUEUE_BACKLOG_ALERT);
  } else {
    forgetAlert(QUEUE_BACKLOG_ALERT);
  }

  if (health.stuck > 0) {
    const ageMin = minutesSince(health.oldestLockedAt, now);
    const fired = alertPlatform(
      {
        type: QUEUE_STUCK_ALERT,
        severity: "critical",
        message: `${health.stuck} job(s) en running sin latido hace más de ${Math.round(thresholds.stuckMs / 60_000)} min (el más viejo: ${ageMin} min): la recuperación de la cola no los está liberando.`,
        data: { stuck: health.stuck, oldestAgeMin: ageMin, thresholdMin: Math.round(thresholds.stuckMs / 60_000) },
      },
      now.getTime(),
    );
    if (fired) alerted.push(QUEUE_STUCK_ALERT);
  } else {
    forgetAlert(QUEUE_STUCK_ALERT);
  }

  return { health, alerted };
}

/**
 * Arranca el vigilante (procesos `ROLE=worker|all`, una réplica por lease). Cada
 * `ALERTS_CHECK_INTERVAL_MIN` (default 5). Llamar UNA vez, después de registrar los handlers.
 */
export function startQueueMonitor(db: Executor, options: { intervalMs?: number } = {}): Loop {
  const intervalMs = options.intervalMs ?? numberFromEnv("ALERTS_CHECK_INTERVAL_MIN", 5, 1) * 60_000;
  return startLeaderLoop({
    db,
    label: "queue_monitor",
    intervalMs,
    tick: async () => {
      await checkQueueHealth(db);
    },
    onError: (e, phase) => {
      log.error("queue_monitor_error", { phase, error: e instanceof Error ? e.message : String(e) });
      captureError(e, { module: "queue", loop: "monitor", phase });
    },
    scalingHint: "Subí ALERTS_CHECK_INTERVAL_MIN o revisá los índices parciales de jobs (jobs_ready_idx, jobs_running_idx).",
  });
}
