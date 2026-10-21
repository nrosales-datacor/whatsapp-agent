import type { Executor, Tx } from "../../platform/db/scope";
import { isTransientError } from "../../platform/net/transient";
import { log } from "../../platform/observability/log";
import { enqueue, PermanentJobError, type JobContext } from "../../platform/queue";
import { getBusinessContext } from "../business";
import { getClient } from "../clients";
import { getAppointment, recordReminderDeliveryFailure, type WhatsAppReminderRequest } from "../scheduling";
import { channelForLocation, credentialsOf } from "./channels";
import { ensureConversation, lastInboundAt, saveOutgoingMessage } from "./conversations";
import { loadTextProfile, type WhatsAppDeps } from "./deps";
import { GraphError } from "./graph";
import { reminderButtonIds } from "./payload";
import { windowState } from "./rules";
import { BUTTON_TITLES, pipelineText } from "./texts";
import { incrementAiUsage } from "./usage";

// ─────────────────────────────────────────────────────────────────────────────
// Recordatorios de cita por WhatsApp (el canal del job `reminder.send` de scheduling).
//
//   1. scheduling decide el canal y, si es WhatsApp, marca el recordatorio enviado y en la
//      MISMA transacción llama a `queueWhatsAppReminder` (outbox): se encola
//      `whatsapp.reminder` con ids, sin datos personales.
//   2. Este job elige cómo mandarlo: dentro de la ventana de 24 h (el cliente escribió
//      hace poco), texto con botones "Confirmo ✅ / Cancelar"; fuera de ella, la plantilla
//      aprobada de recordatorio del número (variables {{1}} cliente · {{2}} servicios ·
//      {{3}} cuándo, y dos botones de respuesta rápida con payload `confirm|<cita>` y
//      `cancel|<cita>`). Sin plantilla y fuera de la ventana no se puede: se registra la
//      falla en scheduling (`whatsapp_no_template`).
//   3. La respuesta del cliente (botón) la procesa el pipeline como acción directa sobre
//      scheduling (./pipeline.ts).
// ─────────────────────────────────────────────────────────────────────────────

export const WHATSAPP_REMINDER_JOB = "whatsapp.reminder";

export type WhatsAppReminderPayload = WhatsAppReminderRequest;

/** Lo que scheduling inyecta en su job: encola el envío dentro de su transacción. */
export async function queueWhatsAppReminder(tx: Tx, request: WhatsAppReminderRequest): Promise<void> {
  await enqueue<WhatsAppReminderPayload>(tx, {
    type: WHATSAPP_REMINDER_JOB,
    businessId: request.businessId,
    payload: request,
    dedupeKey: `wa-reminder:${request.reminderId}:${Date.parse(request.scheduledFor)}`,
  });
}

/** "mañana jueves 23 de octubre a las 10:00" / "hoy a las 10:00", en la zona de la sucursal. */
export function reminderWhen(startsAt: Date, timeZone: string, kind: string): string {
  const time = new Intl.DateTimeFormat("es-CR", { timeZone, hour: "2-digit", minute: "2-digit", hour12: false }).format(startsAt);
  if (kind === "same_day") return `hoy a las ${time}`;
  const day = new Intl.DateTimeFormat("es-CR", { timeZone, weekday: "long", day: "numeric", month: "long" }).format(startsAt);
  return `mañana ${day} a las ${time}`;
}

export type WhatsAppReminderOutcome = "sent_buttons" | "sent_template" | "failed" | "skipped";

/** Corre un `whatsapp.reminder`. */
export async function handleWhatsAppReminderJob(rawPayload: unknown, ctx: JobContext, deps: WhatsAppDeps): Promise<WhatsAppReminderOutcome> {
  const p = rawPayload as Partial<WhatsAppReminderPayload> | null;
  const businessId = ctx.businessId;
  if (!businessId || !p?.reminderId || !p.appointmentId || !p.clientId) throw new PermanentJobError("whatsapp.reminder: payload inválido");
  const db: Executor = ctx.db;
  const fail = async (code: string): Promise<WhatsAppReminderOutcome> => {
    await recordReminderDeliveryFailure(db, businessId, p.reminderId as string, code);
    log.warn("whatsapp_reminder_failed", { businessId, reminderId: p.reminderId, code });
    return "failed";
  };

  const now = deps.now();
  const appointment = await getAppointment(db, businessId, p.appointmentId);
  if (!appointment || (appointment.status !== "pending" && appointment.status !== "confirmed") || Date.parse(appointment.startsAt) <= now.getTime()) {
    return "skipped";
  }
  const client = await getClient(db, businessId, p.clientId);
  if (!client?.phone || client.anonymized) return fail("whatsapp_no_phone");
  const business = await getBusinessContext(db, businessId);
  const channel = await channelForLocation(db, businessId, appointment.locationId);
  const credentials = channel ? credentialsOf(channel) : null;
  if (!business || !channel || !credentials) return fail("whatsapp_not_connected");

  const conversation = await ensureConversation(db, businessId, channel.id, client.id);
  const win = windowState(await lastInboundAt(db, businessId, conversation.id), now);
  const texts = await loadTextProfile(db, businessId);
  const timeZone = appointment.location?.timezone ?? business.business.timezone;
  const services = appointment.services.map((s) => s.name).join(" + ") || "la cita";
  const when = reminderWhen(new Date(appointment.startsAt), timeZone, p.kind ?? "day_before");
  const ids = reminderButtonIds(appointment.id);

  try {
    if (win.open) {
      const body = pipelineText(texts, "appointmentReminder", { cliente: client.name, cuando: when, servicio: services });
      await deps.api.sendButtons(credentials, client.phone, body, [
        { id: ids.confirm, title: BUTTON_TITLES.confirmAppointment },
        { id: ids.cancel, title: BUTTON_TITLES.cancelAppointment },
      ]);
      await saveOutgoingMessage(db, businessId, conversation.id, {
        content: `${body}\n[${BUTTON_TITLES.confirmAppointment} / ${BUTTON_TITLES.cancelAppointment}]`,
        at: now,
      });
      await incrementAiUsage(db, businessId, { messagesOut: 1 }, now);
      return "sent_buttons";
    }
    const template = channel.templates?.reminder;
    if (!template) return fail("whatsapp_no_template");
    await deps.api.sendTemplate(credentials, client.phone, {
      name: template.name,
      language: template.language,
      bodyParams: [client.name, services, when],
      quickReplyPayloads: [ids.confirm, ids.cancel],
    });
    await saveOutgoingMessage(db, businessId, conversation.id, {
      content: `📅 Recordatorio de cita (plantilla "${template.name}"): ${services}, ${when}.`,
      at: now,
    });
    await incrementAiUsage(db, businessId, { messagesOut: 1, utilityTemplates: 1 }, now);
    return "sent_template";
  } catch (e) {
    // Meta caído un rato: la cola reintenta. Rechazo permanente: queda registrado.
    if (isTransientError(e) && !ctx.isLastAttempt) throw e;
    return fail(e instanceof GraphError && e.tokenInvalid ? "whatsapp_token_invalid" : "whatsapp_send_failed");
  }
}
