import { handleSendEmailJob, SEND_EMAIL_JOB, type SendEmailJobPayload } from "./platform/email/job";
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
}
