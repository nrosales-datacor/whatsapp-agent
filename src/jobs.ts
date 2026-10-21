import { handleReminderJob, REMINDER_SEND_JOB, startReminderScheduler, type ReminderJobPayload } from "./modules/scheduling";
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

export function registerJobHandlers(): void {
  registerJobHandler<SendEmailJobPayload>(SEND_EMAIL_JOB, async (payload, ctx) => {
    // El id del job da la clave de idempotencia: un reintento tras un timeout no duplica el correo.
    await handleSendEmailJob(payload, { id: ctx.jobId });
  });

  // Recordatorios de cita: el job elige el canal al enviar. WhatsApp todavía no existe
  // como módulo: TODO(I2) inyectar acá `isWhatsAppConnected` del módulo whatsapp.
  registerJobHandler<ReminderJobPayload>(REMINDER_SEND_JOB, async (payload, ctx) => {
    await handleReminderJob(payload, { db: ctx.db, businessId: ctx.businessId });
  });
}

/**
 * Loops periódicos de los módulos (procesos `ROLE=worker|all`). Cada uno se coordina entre
 * réplicas con su lease (src/platform/net/leaderLease.ts).
 */
export function startModuleSchedulers(db: Executor): Loop[] {
  return [startReminderScheduler({ db })];
}
