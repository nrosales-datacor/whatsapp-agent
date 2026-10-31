// ─────────────────────────────────────────────────────────────────────────────
// API pública de la cola durable (los módulos importan de acá, no de los archivos
// internos):
//   • enqueue(executor, { type, payload, businessId?, runAfter?, dedupeKey?, groupKey?, maxAttempts? })
//   • registerJobHandler(type, handler, { concurrency?, timeoutMs?, backoff? })
//   • startQueueWorker({ db, concurrency?, pollMs?, … }) → { stop() }
//   • Operación: listDeadJobs, retryJob, purgeFinishedJobs, countJobs, getQueueStats
//   • Vigilancia: startQueueMonitor (alertas `queue_backlog` / `queue_stuck`, ./monitor.ts)
//   • Errores: PermanentJobError (directo a dead); los transitorios se marcan con
//     `transient: true` (src/platform/net/transient.ts).
// ─────────────────────────────────────────────────────────────────────────────

export { countJobs, listDeadJobs, purgeFinishedJobs, retryJob, type DeadJob } from "./admin";
export { enqueue, type EnqueueOptions, type EnqueueResult } from "./enqueue";
export {
  classifyJobError,
  computeBackoffMs,
  DEFAULT_BACKOFF,
  JobTimeoutError,
  PermanentJobError,
  type BackoffOptions,
  type JobErrorKind,
} from "./errors";
export { hasNewerGroupJob, type NewerGroupJobQuery } from "./groups";
export { checkQueueHealth, QUEUE_BACKLOG_ALERT, QUEUE_STUCK_ALERT, startQueueMonitor, type QueueHealth } from "./monitor";
export { registerJobHandler, type JobContext, type JobHandler, type JobHandlerOptions } from "./handlers";
// La tabla `jobs` no se exporta: los módulos usan estas funciones, no la leen directo.
export { JOB_STATUSES, type JobStatus } from "./schema";
export { getQueueStats, type JobTypeStats } from "./stats";
export { queueConfigFromEnv, startQueueWorker, type QueueWorker, type QueueWorkerOptions } from "./worker";
