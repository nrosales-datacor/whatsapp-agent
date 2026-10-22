import { createPlanService } from "./modules/billing";
import { handleReminderJob, REMINDER_SEND_JOB, startReminderScheduler, type ReminderJobPayload } from "./modules/scheduling";
import {
  createAgentRunner,
  createWhatsAppDeps,
  defaultAiLimits,
  isWhatsAppConnected,
  queueWhatsAppReminder,
  startWhatsAppSchedulers,
  whatsappJobHandlers,
  type AgentRunner,
  type AiLimitsResolver,
  type WhatsAppDeps,
} from "./modules/whatsapp";
import type { Executor } from "./platform/db/scope";
import { handleSendEmailJob, SEND_EMAIL_JOB, type SendEmailJobPayload } from "./platform/email/job";
import type { Loop } from "./platform/net/scheduler";
import { registerJobHandler } from "./platform/queue";

// ─────────────────────────────────────────────────────────────────────────────
// Punto único de composición de los handlers de la cola (el equivalente de src/routes.ts
// para el trabajo de fondo). Cada módulo que encola trabajo suma acá su registro; el
// worker solo reclama los tipos registrados, así que un tipo nuevo sin registrar queda en
// `pending` en vez de fallar.
// ─────────────────────────────────────────────────────────────────────────────

// ── WhatsApp IA: puntos de inyección ────────────────────────────────────────

/**
 * Agente de IA de WhatsApp (contrato en src/modules/whatsapp/agentContract.ts; el agente vive
 * en src/modules/whatsapp/agent). Sin `OPENAI_API_KEY` queda `undefined` y el pipeline pasa
 * cada conversación a una persona (`handoffAgentRunner`): el bot nunca inventa respuestas.
 */
const whatsappAgentRunner: AgentRunner | undefined = process.env.OPENAI_API_KEY ? createAgentRunner() : undefined;

/** Límites de IA del plan (tope de conversaciones y de gasto). TODO(billing): los del plan del negocio. */
const whatsappAiLimits: AiLimitsResolver = defaultAiLimits;

export interface JobDeps {
  /** Dependencias del módulo WhatsApp (los tests inyectan dobles de Graph, OpenAI y el agente). */
  whatsapp?: WhatsAppDeps;
}

export function registerJobHandlers(options: JobDeps = {}): void {
  registerJobHandler<SendEmailJobPayload>(SEND_EMAIL_JOB, async (payload, ctx) => {
    // El id del job da la clave de idempotencia: un reintento tras un timeout no duplica el correo.
    await handleSendEmailJob(payload, { id: ctx.jobId });
  });

  // Recordatorios de cita: el job elige el canal al enviar. El núcleo no conoce WhatsApp: se
  // le inyecta si hay número conectado y cómo encolar el envío (outbox).
  registerJobHandler<ReminderJobPayload>(REMINDER_SEND_JOB, async (payload, ctx) => {
    await handleReminderJob(payload, { db: ctx.db, businessId: ctx.businessId }, { isWhatsAppConnected, queueWhatsAppReminder });
  });

  // WhatsApp: mensajes entrantes (pipeline + agente), recordatorios y borrado de adjuntos.
  // Las dependencias se arman con el pool del proceso la primera vez que corre un job.
  let whatsapp = options.whatsapp;
  const whatsappDeps = (db: Executor): WhatsAppDeps =>
    (whatsapp ??= createWhatsAppDeps(db, { agent: whatsappAgentRunner, getAiLimits: whatsappAiLimits }));
  for (const spec of whatsappJobHandlers(whatsappDeps)) registerJobHandler(spec.type, spec.handler, spec.options);
}

/**
 * Loops periódicos de los módulos (procesos `ROLE=worker|all`). Cada uno se coordina entre
 * réplicas con su lease (src/platform/net/leaderLease.ts).
 */
export function startModuleSchedulers(db: Executor): Loop[] {
  return [startReminderScheduler({ db }), ...startWhatsAppSchedulers(db)];
}

/**
 * Chequeo del worker de la cola (`canRunJob`): un job de un negocio pausado o dado de baja
 * se posterga sin correrlo (src/platform/queue/worker.ts) hasta que se reactive. Los planes
 * viven en modules/billing; la cola no los conoce. `jobsAllowedWhilePaused` = tipos que
 * igual corren con el negocio pausado (p. ej. guardar los mensajes que siguen entrando,
 * cuando exista el módulo WhatsApp).
 */
export function createJobGate(db: Executor): (businessId: string, jobType: string) => Promise<boolean> {
  return createPlanService(db, { jobsAllowedWhilePaused: [] }).canRunJob;
}
