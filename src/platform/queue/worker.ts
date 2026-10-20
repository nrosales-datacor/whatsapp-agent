import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import type { Executor } from "../db/scope";
import { startLeaderLoop } from "../net/leaderLease";
import type { Loop } from "../net/scheduler";
import { isShuttingDown, trackTask } from "../net/shutdown";
import { log } from "../observability/log";
import { captureError } from "../observability/sentry";
import { purgeFinishedJobs } from "./admin";
import { classifyJobError, computeBackoffMs, DEFAULT_BACKOFF, describeJobError, JobTimeoutError } from "./errors";
import { getJobHandler, registeredJobHandlers, type JobContext, type RegisteredHandler } from "./handlers";
import { recordJobEvent, trackDeadJob } from "./stats";
import {
  claimJob,
  heartbeatJobs,
  markJobDead,
  markJobDone,
  markJobForRetry,
  recoverExpiredJobs,
  releaseJob,
  type ClaimedJob,
} from "./store";

// ─────────────────────────────────────────────────────────────────────────────
// Worker de la cola durable (tabla `jobs`, ver ./schema.ts y ./store.ts).
//
// Por proceso (`ROLE=worker|all`):
//   • `concurrency` slots en paralelo: cada uno reclama un job, corre su handler y lo
//     cierra; si no hay nada, duerme `pollMs`. El orden por grupo y el reparto entre
//     negocios NO los decide este archivo sino el claim (./store.ts): valen igual entre
//     slots del mismo proceso que entre réplicas. Los claims de un proceso se hacen de a
//     uno (son una transacción de milisegundos) para que el cupo por tipo
//     (`registerJobHandler(…, { concurrency })`) sea exacto.
//   • Latido cada `heartbeatMs`: renueva el lock de los jobs en curso, así un job lento
//     pero vivo no se recupera (y se duplica) solo por durar más que el lock.
//   • Recuperación cada `recoveryIntervalMs`: los `running` sin latido hace más de
//     `lockTimeoutMs` (worker muerto) vuelven a la cola, o a `dead` si ya no les quedan
//     intentos. Corre en todas las réplicas: es una sola sentencia atómica.
//   • Purga (con lease de liderazgo, una réplica): borra los `done` más viejos que
//     `retentionDays`.
//
// Apagado ordenado (src/platform/net/shutdown.ts): con la señal (o `stop()`) los slots
// dejan de reclamar; cada claim+ejecución está registrado con `trackTask`, así
// `drainTasks` espera a los jobs en curso. Un job reclamado justo cuando llegó la señal
// se devuelve a la cola sin correrlo. Lo que no termine dentro del tope lo rescata la
// recuperación cuando vence su lock.
//
// Escalar: subir QUEUE_CONCURRENCY o sumar réplicas `ROLE=worker`. Cada slot usa una
// conexión del pool solo mientras consulta (no mientras corre el handler).
// ─────────────────────────────────────────────────────────────────────────────

function intFromEnv(name: string, fallback: number, min: number): number {
  const n = Number(process.env[name]);
  return Number.isInteger(n) && n >= min ? n : fallback;
}

export interface QueueWorkerOptions {
  /** Pool del proceso. */
  db: Executor;
  /** Slots en paralelo (default QUEUE_CONCURRENCY o 4). */
  concurrency?: number;
  /** Espera entre polls cuando no hay trabajo, en ms (default QUEUE_POLL_MS o 1000). */
  pollMs?: number;
  /** Sin latido por más de esto, un job `running` se da por huérfano (default QUEUE_LOCK_TIMEOUT_MS o 5 min). */
  lockTimeoutMs?: number;
  /** Cada cuánto se renueva el lock de los jobs en curso (default lockTimeoutMs / 4). */
  heartbeatMs?: number;
  /** Cada cuánto se buscan jobs huérfanos (default el menor entre 60 s y lockTimeoutMs / 2). */
  recoveryIntervalMs?: number;
  /** Días que se conservan los `done` antes de purgarlos (default QUEUE_RETENTION_DAYS o 7; 0 = no purgar). */
  retentionDays?: number;
  /** Cada cuánto corre la purga (default 1 h). */
  purgeIntervalMs?: number;
  /** Id de este worker en `locked_by` (default "host:pid:azar"). */
  workerId?: string;
}

export interface QueueWorker {
  readonly workerId: string;
  /** Deja de reclamar, espera a los jobs en curso y frena los loops de fondo. */
  stop(): Promise<void>;
}

/** Defaults de la cola desde el entorno (documentados en .env.example). */
export function queueConfigFromEnv() {
  const lockTimeoutMs = intFromEnv("QUEUE_LOCK_TIMEOUT_MS", 5 * 60_000, 1_000);
  return {
    concurrency: intFromEnv("QUEUE_CONCURRENCY", 4, 1),
    pollMs: intFromEnv("QUEUE_POLL_MS", 1_000, 10),
    lockTimeoutMs,
    retentionDays: intFromEnv("QUEUE_RETENTION_DAYS", 7, 0),
  };
}

/** Ciclo con setTimeout recursivo (sin solaparse) cuyo `stop()` espera al tick en curso. */
function startTimerLoop(intervalMs: number, tick: () => Promise<void>): { stop: () => Promise<void> } {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let current: Promise<void> = Promise.resolve();
  const run = (): void => {
    if (stopped) return;
    current = tick().finally(() => {
      if (!stopped) timer = setTimeout(run, intervalMs);
    });
  };
  run();
  return {
    stop: async () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      await current.catch(() => {});
    },
  };
}

function jobFields(job: ClaimedJob): Record<string, unknown> {
  return { jobId: job.id, jobType: job.type, tenantId: job.businessId, attempt: job.attempt, maxAttempts: job.maxAttempts };
}

/** Arranca el worker de la cola en este proceso. Sin handlers registrados no reclama nada. */
export function startQueueWorker(options: QueueWorkerOptions): QueueWorker {
  const env = queueConfigFromEnv();
  const db = options.db;
  const concurrency = Math.max(1, Math.floor(options.concurrency ?? env.concurrency));
  const pollMs = Math.max(1, Math.floor(options.pollMs ?? env.pollMs));
  const lockTimeoutMs = Math.max(1, Math.floor(options.lockTimeoutMs ?? env.lockTimeoutMs));
  const heartbeatMs = Math.max(1, Math.floor(options.heartbeatMs ?? lockTimeoutMs / 4));
  const recoveryIntervalMs = Math.max(1, Math.floor(options.recoveryIntervalMs ?? Math.min(60_000, lockTimeoutMs / 2)));
  const retentionDays = Math.max(0, options.retentionDays ?? env.retentionDays);
  const purgeIntervalMs = Math.max(1, Math.floor(options.purgeIntervalMs ?? 60 * 60_000));
  const workerId = options.workerId ?? `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;

  let stopping = false;
  const shouldStop = (): boolean => stopping || isShuttingDown();

  // Jobs en curso de este proceso (para el latido y el cupo por tipo).
  const inFlight = new Map<string, ClaimedJob>();
  const inFlightByType = new Map<string, number>();

  // Esperas interrumpibles: `stop()` despierta a los slots dormidos.
  const sleepers = new Set<() => void>();
  const sleep = (ms: number): Promise<void> =>
    new Promise<void>((resolve) => {
      if (stopping) return resolve();
      const wake = (): void => {
        clearTimeout(timer);
        sleepers.delete(wake);
        resolve();
      };
      const timer = setTimeout(wake, ms);
      sleepers.add(wake);
    });

  // Claims de a uno por proceso (ver cabecera): cadena de promesas como mutex.
  let claimChain: Promise<unknown> = Promise.resolve();
  const claimNext = (): Promise<ClaimedJob | null> => {
    const next = claimChain.then(async () => {
      if (shouldStop()) return null;
      const types = registeredJobHandlers()
        .filter((h) => (inFlightByType.get(h.type) ?? 0) < h.concurrency)
        .map((h) => h.type);
      if (types.length === 0) return null;
      const job = await claimJob(db, { types, workerId, perBusiness: concurrency });
      if (job) {
        inFlight.set(job.id, job);
        inFlightByType.set(job.type, (inFlightByType.get(job.type) ?? 0) + 1);
      }
      return job;
    });
    claimChain = next.catch(() => {});
    return next;
  };

  const forget = (job: ClaimedJob): void => {
    inFlight.delete(job.id);
    inFlightByType.set(job.type, Math.max(0, (inFlightByType.get(job.type) ?? 1) - 1));
  };

  /** Corre el handler con su timeout. Devuelve el error, o null si salió bien. */
  const runHandler = async (job: ClaimedJob, registered: RegisteredHandler): Promise<unknown> => {
    const controller = new AbortController();
    const ctx: JobContext = {
      jobId: job.id,
      type: job.type,
      businessId: job.businessId,
      attempt: job.attempt,
      maxAttempts: job.maxAttempts,
      isLastAttempt: job.attempt >= job.maxAttempts,
      signal: controller.signal,
      db,
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const run = Promise.resolve().then(() => registered.handler(job.payload, ctx));
      const timeoutMs = registered.timeoutMs;
      if (timeoutMs === null) {
        await run;
      } else {
        // Si vence el timeout, el handler sigue corriendo: que su rechazo tardío no quede sin manejar.
        run.catch(() => {});
        await Promise.race([
          run,
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              const err = new JobTimeoutError(timeoutMs);
              controller.abort(err);
              reject(err);
            }, timeoutMs);
          }),
        ]);
      }
      return null;
    } catch (e) {
      return e ?? new Error("el handler rechazó sin error");
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  const finishFailed = async (job: ClaimedJob, registered: RegisteredHandler | undefined, error: unknown, durationMs: number) => {
    const kind = classifyJobError(error);
    const message = describeJobError(error);
    if (error instanceof JobTimeoutError) recordJobEvent(job.type, "timedOut");
    if (kind === "permanent" || job.attempt >= job.maxAttempts) {
      const owned = await markJobDead(db, job, workerId, message);
      recordJobEvent(job.type, "dead", durationMs);
      log.error("job_dead", { ...jobFields(job), errorKind: kind, error: message, durationMs, lockLost: !owned });
      if (owned) trackDeadJob(job.businessId, job.type);
      return;
    }
    const delayMs = computeBackoffMs(job.attempt, { ...DEFAULT_BACKOFF, ...registered?.backoff });
    const owned = await markJobForRetry(db, job, workerId, message, delayMs);
    recordJobEvent(job.type, "retried", durationMs);
    log.warn("job_retry", { ...jobFields(job), errorKind: kind, error: message, delayMs, durationMs, lockLost: !owned });
  };

  const runJob = async (job: ClaimedJob): Promise<void> => {
    recordJobEvent(job.type, "claimed");
    const registered = getJobHandler(job.type);
    const started = Date.now();
    // El claim solo pide tipos registrados: sin handler acá = lo desregistraron en caliente.
    const error = registered ? await runHandler(job, registered) : new Error(`no hay handler para "${job.type}"`);
    const durationMs = Date.now() - started;
    try {
      if (error === null) {
        const owned = await markJobDone(db, job, workerId);
        recordJobEvent(job.type, "done", durationMs);
        if (owned) log.info("job_done", { ...jobFields(job), durationMs });
        else log.warn("job_done_lock_lost", { ...jobFields(job), durationMs });
      } else {
        await finishFailed(job, registered, error, durationMs);
      }
    } catch (e) {
      // No se pudo cerrar (base caída): el job queda `running` y, sin latido, la
      // recuperación lo devuelve a la cola cuando vence el lock (at-least-once).
      log.error("job_close_failed", { ...jobFields(job), error: describeJobError(e) });
      captureError(e, { module: "queue", step: "close", jobId: job.id, jobType: job.type });
    }
  };

  /** Un ciclo de un slot: reclamar y correr. true si corrió un job (no hace falta dormir). */
  const claimAndRun = async (): Promise<boolean> => {
    const job = await claimNext();
    if (!job) return false;
    try {
      if (shouldStop()) {
        // Llegó el apagado durante el claim: se devuelve sin correrlo.
        await releaseJob(db, job, workerId);
        return false;
      }
      await runJob(job);
      return true;
    } finally {
      forget(job);
    }
  };

  const slotLoop = async (slot: number): Promise<void> => {
    // Arranque escalonado: que los slots no le peguen a la base en el mismo milisegundo.
    await sleep(Math.floor((pollMs * slot) / concurrency));
    while (!shouldStop()) {
      let ran = false;
      try {
        ran = await trackTask(claimAndRun());
      } catch (e) {
        log.error("queue_slot_error", { workerId, slot, error: describeJobError(e) });
        captureError(e, { module: "queue", loop: "slot", slot });
      }
      if (!ran && !shouldStop()) await sleep(pollMs);
    }
  };

  const heartbeat = startTimerLoop(heartbeatMs, async () => {
    const ids = [...inFlight.keys()];
    if (ids.length === 0) return;
    try {
      const renewed = await heartbeatJobs(db, workerId, ids);
      if (renewed < ids.length) log.warn("queue_heartbeat_lost", { workerId, inFlight: ids.length, renewed });
    } catch (e) {
      log.error("queue_heartbeat_error", { workerId, error: describeJobError(e) });
      captureError(e, { module: "queue", loop: "heartbeat" });
    }
  });

  const recovery = startTimerLoop(recoveryIntervalMs, async () => {
    try {
      for (const r of await recoverExpiredJobs(db, lockTimeoutMs)) {
        recordJobEvent(r.type, "recovered");
        log.warn("job_recovered", { jobId: r.id, jobType: r.type, tenantId: r.businessId, status: r.status });
        if (r.status === "dead") {
          recordJobEvent(r.type, "dead");
          trackDeadJob(r.businessId, r.type);
        }
      }
    } catch (e) {
      log.error("queue_recovery_error", { workerId, error: describeJobError(e) });
      captureError(e, { module: "queue", loop: "recovery" });
    }
  });

  let purge: Loop | null = null;
  if (retentionDays > 0) {
    purge = startLeaderLoop({
      db,
      label: "queue-purge",
      intervalMs: purgeIntervalMs,
      scalingHint: "Bajar QUEUE_RETENTION_DAYS si la purga tarda demasiado.",
      tick: async () => {
        const n = await purgeFinishedJobs(db, new Date(Date.now() - retentionDays * 86_400_000));
        if (n > 0) log.info("queue_purged", { count: n, retentionDays });
      },
      onError: (e, phase) => {
        log.error("queue_purge_error", { phase, error: describeJobError(e) });
        captureError(e, { module: "queue", loop: "purge", phase });
      },
    });
  }

  const slots = Array.from({ length: concurrency }, (_, slot) =>
    slotLoop(slot).catch((e) => {
      log.error("queue_slot_crashed", { workerId, slot, error: describeJobError(e) });
      captureError(e, { module: "queue", loop: "slot", slot, fatal: true });
    }),
  );

  log.info("queue_worker_started", {
    workerId,
    concurrency,
    pollMs,
    lockTimeoutMs,
    retentionDays,
    types: registeredJobHandlers().map((h) => h.type),
  });

  let stopPromise: Promise<void> | null = null;
  return {
    workerId,
    stop: () => {
      stopPromise ??= (async () => {
        stopping = true;
        for (const wake of [...sleepers]) wake();
        purge?.stop();
        // Los slots salen después de cerrar su job en curso; recién ahí se frena el latido.
        await Promise.allSettled(slots);
        await Promise.allSettled([heartbeat.stop(), recovery.stop()]);
        log.info("queue_worker_stopped", { workerId });
      })();
      return stopPromise;
    },
  };
}
