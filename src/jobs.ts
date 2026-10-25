import { startTrialExpiryLoop, type PlanService } from "./modules/billing";
import { CAMPAIGN_DISPATCH_JOB, handleCampaignDispatchJob } from "./modules/campaigns";
import { handleReminderJob, REMINDER_SEND_JOB, startReminderScheduler, type ReminderJobPayload } from "./modules/scheduling";
import {
  createAgentRunner,
  createWhatsAppDeps,
  isWhatsAppConnected,
  queueWhatsAppReminder,
  sendMarketingTemplate,
  startWhatsAppSchedulers,
  whatsappJobHandlers,
  type AgentRunner,
  type WhatsAppDeps,
} from "./modules/whatsapp";
import type { Executor } from "./platform/db/scope";
import { handleSendEmailJob, SEND_EMAIL_JOB, type SendEmailJobPayload } from "./platform/email/job";
import type { Loop } from "./platform/net/scheduler";
import { registerJobHandler } from "./platform/queue";
import { aiLimitsFromPlan, createPlans, growthFromPlan } from "./plans";
import { createUsageTracker } from "./usage";

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
const whatsappAgentRunner: AgentRunner | undefined = process.env.OPENAI_API_KEY
  ? // Cada cita que agenda el agente suma a `daily_usage` (métricas de producto, src/usage.ts).
    createAgentRunner({ onAppointmentBooked: createUsageTracker().appointmentBooked })
  : undefined;

export interface JobDeps {
  /** Dependencias del módulo WhatsApp (los tests inyectan dobles de Graph, OpenAI y el agente). */
  whatsapp?: WhatsAppDeps;
  /**
   * Planes del proceso (src/plans.ts): de acá salen los topes del agente de cada negocio
   * (conversaciones y gasto del mes, agente apagado por plan o pausa). Default: los reales.
   */
  plans?: PlanService;
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
  // Las dependencias se arman con el pool del proceso la primera vez que corre un job; los
  // topes del agente y lo de crecimiento (I6) son los del plan de cada negocio.
  let whatsapp = options.whatsapp;
  const whatsappDeps = (db: Executor): WhatsAppDeps => {
    if (whatsapp) return whatsapp;
    const plans = options.plans ?? createPlans(db);
    whatsapp = createWhatsAppDeps(db, { agent: whatsappAgentRunner, getAiLimits: aiLimitsFromPlan(plans), getGrowth: growthFromPlan(plans) });
    return whatsapp;
  };
  for (const spec of whatsappJobHandlers(whatsappDeps)) registerJobHandler(spec.type, spec.handler, spec.options);

  // Campañas (I6): cada lote de una campaña; el envío lo hace el módulo WhatsApp con la
  // plantilla de marketing del número (campaigns no conoce Graph).
  registerJobHandler(
    CAMPAIGN_DISPATCH_JOB,
    async (payload, ctx) => {
      await handleCampaignDispatchJob(payload, ctx, { send: (db, businessId, input) => sendMarketingTemplate(db, whatsappDeps(db), businessId, input) });
    },
    { timeoutMs: 180_000 },
  );
}

/**
 * Loops periódicos de los módulos (procesos `ROLE=worker|all`). Cada uno se coordina entre
 * réplicas con su lease (src/platform/net/leaderLease.ts).
 */
export function startModuleSchedulers(db: Executor, plans: PlanService = createPlans(db)): Loop[] {
  return [
    startReminderScheduler({ db }),
    // Seguimiento post-servicio y rescate de cotizaciones con lo que permite el plan (I6).
    ...startWhatsAppSchedulers(db, { getGrowth: growthFromPlan(plans) }),
    // Pruebas gratis vencidas sin suscripción → pago pendiente (I6.7, modules/billing).
    startTrialExpiryLoop({ db }),
  ];
}

/**
 * Chequeo del worker de la cola (`canRunJob`): un job de un negocio pausado o dado de baja
 * se posterga sin correrlo (src/platform/queue/worker.ts) hasta que se reactive, salvo los
 * tipos que completan lo que ya entró por WhatsApp sin responder (ver
 * `JOBS_ALLOWED_WHILE_PAUSED` en src/plans.ts). Los planes viven en modules/billing; la cola
 * no los conoce.
 */
export function createJobGate(db: Executor, plans: Pick<PlanService, "canRunJob"> = createPlans(db)): (businessId: string, jobType: string) => Promise<boolean> {
  return (businessId, jobType) => plans.canRunJob(businessId, jobType);
}
