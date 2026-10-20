import type { Executor } from "../db/scope";
import { enqueue, type EnqueueResult } from "../queue";
import type { EmailMessage } from "./message";
import { SEND_EMAIL_JOB, type SendEmailJobPayload } from "./job";

// ─────────────────────────────────────────────────────────────────────────────
// Envío diferido: el correo sale desde el worker de la cola, con reintentos y backoff,
// en vez de bloquear el request. Dentro de una transacción ya abierta el job queda
// atómico con la escritura que lo origina (outbox): si la transacción se revierte, el
// correo no sale.
// ─────────────────────────────────────────────────────────────────────────────

export interface QueueEmailOptions {
  /** Negocio dueño del envío (null/omitido = correo de plataforma). */
  businessId?: string;
  /** Evita encolar dos veces el mismo correo (p. ej. `reminder-24h-<appointmentId>`). */
  dedupeKey?: string;
  /** No antes de este momento (p. ej. un recordatorio programado). */
  runAfter?: Date;
}

export function queueEmail(executor: Executor, message: EmailMessage, options: QueueEmailOptions = {}): Promise<EnqueueResult> {
  return enqueue<SendEmailJobPayload>(executor, {
    type: SEND_EMAIL_JOB,
    payload: { message },
    businessId: options.businessId,
    dedupeKey: options.dedupeKey,
    runAfter: options.runAfter,
  });
}
