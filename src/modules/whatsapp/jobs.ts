import type { Executor } from "../../platform/db/scope";
import type { Loop } from "../../platform/net/scheduler";
import type { JobHandler, JobHandlerOptions } from "../../platform/queue";
import type { WhatsAppDeps } from "./deps";
import { handleMediaEraseJob, WHATSAPP_MEDIA_ERASE_JOB } from "./eraser";
import { WHATSAPP_INBOUND_JOB } from "./ingest";
import { handleInboundJob } from "./pipeline";
import { startRawWebhookLoop } from "./rawWebhooks";
import { handleWhatsAppReminderJob, WHATSAPP_REMINDER_JOB } from "./reminders";
import { reingestRawPayload } from "./webhook";

// ─────────────────────────────────────────────────────────────────────────────
// Lo que la composición (src/jobs.ts) registra del módulo: los handlers de la cola y los
// loops periódicos. Se exportan como datos (tipo, handler, opciones) para que el registro
// quede explícito en src/jobs.ts, igual que el resto de los módulos.
// ─────────────────────────────────────────────────────────────────────────────

export interface WhatsAppJobSpec {
  type: string;
  handler: JobHandler<unknown>;
  options: JobHandlerOptions;
}

/**
 * Handlers de la cola. `deps` puede ser el objeto ya armado o una función que lo arma con
 * el pool del proceso (la primera vez que corre un job), para la composición que todavía
 * no tiene la base al registrar.
 */
export function whatsappJobHandlers(deps: WhatsAppDeps | ((db: Executor) => WhatsAppDeps)): WhatsAppJobSpec[] {
  const resolve = (db: Executor): WhatsAppDeps => (typeof deps === "function" ? deps(db) : deps);
  return [
    // Un turno del agente puede tardar (varias llamadas al LLM y a Graph): tope holgado,
    // por debajo del QUEUE_LOCK_TIMEOUT_MS (5 min) para que el lock no venza en pleno turno.
    { type: WHATSAPP_INBOUND_JOB, handler: (payload, ctx) => handleInboundJob(payload, ctx, resolve(ctx.db)), options: { timeoutMs: 240_000 } },
    {
      type: WHATSAPP_REMINDER_JOB,
      handler: async (payload, ctx) => {
        await handleWhatsAppReminderJob(payload, ctx, resolve(ctx.db));
      },
      options: { timeoutMs: 60_000 },
    },
    {
      type: WHATSAPP_MEDIA_ERASE_JOB,
      handler: async (payload, ctx) => {
        await handleMediaEraseJob(payload, ctx, resolve(ctx.db));
      },
      options: { timeoutMs: 120_000 },
    },
  ];
}

/** Loops del módulo (procesos `ROLE=worker|all`): reproceso y purga de `raw_webhooks`. */
export function startWhatsAppSchedulers(db: Executor): Loop[] {
  return [startRawWebhookLoop({ db, ingest: reingestRawPayload(db) })];
}
