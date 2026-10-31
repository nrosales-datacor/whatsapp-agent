import type { Executor } from "../../platform/db/scope";
import type { Loop } from "../../platform/net/scheduler";
import type { JobHandler, JobHandlerOptions } from "../../platform/queue";
import type { WhatsAppDeps } from "./deps";
import { handleMediaEraseJob, WHATSAPP_MEDIA_ERASE_JOB } from "./eraser";
import { handleFollowUpJob, startFollowUpLoop, WHATSAPP_FOLLOW_UP_JOB } from "./followUps";
import type { GrowthResolver } from "./growth";
import { handleQuoteTouchJob, startQuoteRecoveryLoop, WHATSAPP_QUOTE_TOUCH_JOB } from "./quotes";
import { startInboundWatchLoop } from "./inboundWatch";
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

/**
 * Tipos de job del módulo que la cola corre aunque el negocio esté pausado (cobro manual)
 * o dado de baja; el resto (recordatorios) se posterga hasta que se reactive. Se los da la
 * composición a billing como `jobsAllowedWhilePaused` (src/plans.ts).
 *   • `whatsapp.inbound`: completa lo que ya entró (guarda la foto o el audio) y NO
 *     responde (./pipeline.ts). Postergarlo haría que el bot conteste días tarde al
 *     reactivar; correrlo no gasta IA.
 *   • `whatsapp.media.erase`: el borrado de adjuntos de un cliente anonimizado es una
 *     obligación de datos personales (Ley 8968) que no espera al cobro.
 */
export const WHATSAPP_JOBS_ALLOWED_WHILE_PAUSED: readonly string[] = [WHATSAPP_INBOUND_JOB, WHATSAPP_MEDIA_ERASE_JOB];

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
    // Crecimiento (I6): seguimiento post-servicio y toques del rescate de cotizaciones.
    {
      type: WHATSAPP_FOLLOW_UP_JOB,
      handler: async (payload, ctx) => {
        await handleFollowUpJob(payload, ctx, resolve(ctx.db));
      },
      options: { timeoutMs: 60_000 },
    },
    {
      type: WHATSAPP_QUOTE_TOUCH_JOB,
      handler: async (payload, ctx) => {
        await handleQuoteTouchJob(payload, ctx, resolve(ctx.db));
      },
      options: { timeoutMs: 60_000 },
    },
  ];
}

/**
 * Loops del módulo (procesos `ROLE=worker|all`): reproceso y purga de `raw_webhooks`, el
 * vigilante «sin entrantes» (apagable con ALERTS_INBOUND_SILENCE_HOURS=0) y, con lo de
 * crecimiento del plan (`getGrowth`, I6), los barridos del seguimiento post-servicio y del
 * rescate de cotizaciones.
 */
export function startWhatsAppSchedulers(db: Executor, options: { getGrowth?: GrowthResolver } = {}): Loop[] {
  const loops = [startRawWebhookLoop({ db, ingest: reingestRawPayload(db) })];
  const inboundWatch = startInboundWatchLoop(db);
  if (inboundWatch) loops.push(inboundWatch);
  if (options.getGrowth) {
    loops.push(startFollowUpLoop({ db, getGrowth: options.getGrowth }), startQuoteRecoveryLoop({ db, getGrowth: options.getGrowth }));
  }
  return loops;
}
