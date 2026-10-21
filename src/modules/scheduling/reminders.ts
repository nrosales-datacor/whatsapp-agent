import { and, asc, eq, inArray, isNull, lte, sql } from "drizzle-orm";
import { rowsOf } from "../../platform/db/rows";
import { isTenantId, withSystem, withTenant, type Executor, type Tx } from "../../platform/db/scope";
import { appointmentReminderEmail } from "../../platform/email/templates";
import { queueEmail } from "../../platform/email/enqueue";
import { startLeaderLoop } from "../../platform/net/leaderLease";
import type { Loop } from "../../platform/net/scheduler";
import { msFromEnv } from "../../platform/net/timeouts";
import { log } from "../../platform/observability/log";
import { captureError } from "../../platform/observability/sentry";
import { enqueue, PermanentJobError } from "../../platform/queue";
import { getBusinessContext, type ReminderChannel } from "../business";
import { getClient, type ClientChannel } from "../clients";
import { getStaffMember } from "../team";
import {
  ACTIVE_APPOINTMENT_STATUSES,
  appointments,
  appointmentServices,
  REMINDER_KINDS,
  reminders,
  type ReminderDeliveryChannel,
  type ReminderKind,
} from "./schema";
import { addDays, MINUTE_MS, wallClock, zonedInstant } from "./time";

// ─────────────────────────────────────────────────────────────────────────────
// Recordatorios de cita (PLAN-GESTION.md §4, "Canal del recordatorio").
//
//   1. Al reservar o reprogramar se programan filas en `reminders` (una por tipo y cita),
//      en la zona horaria de la SUCURSAL:
//        • day_before: el día anterior a las 17:00;
//        • same_day: 2 h antes, nunca antes de las 07:00 (y se omite si eso queda a menos
//          de 30 min de la cita).
//      Lo que ya pasó al reservar no se programa. Cancelar invalida los pendientes;
//      reprogramar los vuelve a programar (aunque ya se hubiera mandado el de la hora vieja).
//   2. Un loop con lease (`startReminderScheduler`, una sola réplica) encola las vencidas
//      como job `reminder.send` (dedupe por recordatorio y hora programada) y da por
//      vencidas (`skipped`) las de citas que ya empezaron o dejaron de estar vivas.
//   3. El job (efecto externo → por la cola) elige el canal AL ENVIAR: el preferido del
//      cliente si el negocio lo tiene activo; si no, los del negocio en su orden. Correo
//      solo si el cliente tiene correo; WhatsApp solo si el negocio tiene un número
//      conectado. El correo sale con `appointmentReminderEmail` por `queueEmail` dentro de
//      la misma transacción que marca el recordatorio como enviado (outbox): o las dos
//      cosas o ninguna. Repetir el job no duplica nada (lock + estado + dedupe del correo).
//
// WhatsApp: el núcleo no importa el módulo whatsapp; la composición (src/jobs.ts) le
// inyecta `isWhatsAppConnected` y `queueWhatsAppReminder`. Con número conectado, el
// recordatorio se marca enviado y en la MISMA transacción se encola el envío del módulo
// whatsapp (outbox, igual que el correo); si ese envío falla sin remedio, el módulo lo
// registra con `recordReminderDeliveryFailure`. Sin inyección (o sin número), uno que solo
// puede salir por WhatsApp queda `pending` con `error = 'whatsapp_pending'` (el loop no
// lo vuelve a tomar).
// ─────────────────────────────────────────────────────────────────────────────

export const REMINDER_SEND_JOB = "reminder.send";

/** Hora local del recordatorio del día anterior. */
const DAY_BEFORE_AT_MIN = 17 * 60;
/** Anticipación del recordatorio del mismo día. */
const SAME_DAY_BEFORE_MIN = 2 * 60;
/** Nunca antes de esta hora local el mismo día. */
const SAME_DAY_EARLIEST_MIN = 7 * 60;
/** Si el del mismo día queda más pegado que esto a la cita, no se manda. */
const SAME_DAY_MIN_GAP_MIN = 30;

/** Marca de "solo puede salir por WhatsApp y todavía no hay número conectado". */
export const WHATSAPP_PENDING = "whatsapp_pending";

export interface PlannedReminder {
  kind: ReminderKind;
  scheduledFor: Date;
}

/** Cuándo mandar cada recordatorio de una cita que empieza en `startsAt` (zona de la sucursal). */
export function planReminders(startsAt: Date, timeZone: string, now: Date): PlannedReminder[] {
  const start = startsAt.getTime();
  const { date } = wallClock(startsAt, timeZone);
  const out: PlannedReminder[] = [];
  const dayBefore = zonedInstant(addDays(date, -1), DAY_BEFORE_AT_MIN, timeZone);
  if (dayBefore.getTime() > now.getTime() && dayBefore.getTime() < start) out.push({ kind: "day_before", scheduledFor: dayBefore });
  const earliest = zonedInstant(date, SAME_DAY_EARLIEST_MIN, timeZone).getTime();
  const sameDay = Math.max(start - SAME_DAY_BEFORE_MIN * MINUTE_MS, earliest);
  if (sameDay <= start - SAME_DAY_MIN_GAP_MIN * MINUTE_MS && sameDay > now.getTime()) {
    out.push({ kind: "same_day", scheduledFor: new Date(sameDay) });
  }
  return out;
}

/** Canales candidatos en orden: el preferido del cliente (si el negocio lo tiene activo) y después los del negocio. */
function candidateChannels(businessChannels: readonly ReminderChannel[], preferred: ClientChannel | null): ReminderChannel[] {
  const list = preferred && businessChannels.includes(preferred) ? [preferred, ...businessChannels] : [...businessChannels];
  return [...new Set(list)];
}

/** Canal con el que se programa (se vuelve a decidir al enviar). null = el negocio no manda recordatorios. */
export function initialReminderChannel(
  businessChannels: readonly ReminderChannel[],
  preferred: ClientChannel | null,
): ReminderDeliveryChannel | null {
  return candidateChannels(businessChannels, preferred)[0] ?? null;
}

export type ChannelDecision = "email" | "whatsapp" | typeof WHATSAPP_PENDING | "none";

/** Regla de §4 al momento de enviar. */
export function resolveReminderChannel(input: {
  businessChannels: readonly ReminderChannel[];
  preferred: ClientChannel | null;
  hasEmail: boolean;
  whatsappConnected: boolean;
}): ChannelDecision {
  const candidates = candidateChannels(input.businessChannels, input.preferred);
  for (const channel of candidates) {
    if (channel === "email" && input.hasEmail) return "email";
    if (channel === "whatsapp" && input.whatsappConnected) return "whatsapp";
  }
  return candidates.includes("whatsapp") ? WHATSAPP_PENDING : "none";
}

// ── Programación (dentro de la transacción de la cita) ──────────────────────

/**
 * Programa (o reprograma) los recordatorios de una cita viva. `tx` es la transacción de la
 * reserva (abierta con `withTenant` del negocio). Idempotente: si la hora programada no
 * cambió, uno ya enviado no se repite.
 */
export async function syncAppointmentReminders(
  tx: Tx,
  businessId: string,
  appointment: { id: string; startsAt: Date; clientId: string; locationId: string },
  options: { now?: Date } = {},
): Promise<void> {
  const now = options.now ?? new Date();
  const ctx = await getBusinessContext(tx, businessId);
  const location = ctx?.locations.find((l) => l.id === appointment.locationId);
  const client = await getClient(tx, businessId, appointment.clientId);
  const channel = ctx ? initialReminderChannel(ctx.reminderChannels, client?.preferredChannel ?? null) : null;
  const planned = channel && location ? planReminders(appointment.startsAt, location.timezone, now) : [];

  for (const p of planned) {
    await tx
      .insert(reminders)
      .values({ businessId, appointmentId: appointment.id, kind: p.kind, channel: channel as ReminderDeliveryChannel, scheduledFor: p.scheduledFor })
      .onConflictDoUpdate({
        target: [reminders.appointmentId, reminders.kind],
        set: { scheduledFor: p.scheduledFor, channel: channel as ReminderDeliveryChannel, status: "pending", sentAt: null, error: null, updatedAt: new Date() },
        // Uno ya enviado para ESTA misma hora no se reabre.
        setWhere: sql`${reminders.status} <> 'sent' OR ${reminders.scheduledFor} <> excluded.scheduled_for`,
      });
  }
  const keep = new Set(planned.map((p) => p.kind));
  const drop = REMINDER_KINDS.filter((k) => !keep.has(k));
  if (drop.length > 0) {
    await tx
      .update(reminders)
      .set({ status: "cancelled", error: null })
      .where(
        and(
          eq(reminders.businessId, businessId),
          eq(reminders.appointmentId, appointment.id),
          inArray(reminders.kind, drop),
          eq(reminders.status, "pending"),
        ),
      );
  }
}

/** Invalida los recordatorios pendientes de una cita (cancelada, completada, no-show). */
export async function cancelPendingReminders(tx: Tx, businessId: string, appointmentId: string): Promise<void> {
  await tx
    .update(reminders)
    .set({ status: "cancelled" })
    .where(and(eq(reminders.businessId, businessId), eq(reminders.appointmentId, appointmentId), eq(reminders.status, "pending")));
}

// ── Barrido (loop con lease, contexto de sistema) ───────────────────────────

/** Recordatorios por tick como máximo (el resto sale en el siguiente). */
const SWEEP_BATCH = 200;

export interface SweepResult {
  expired: number;
  enqueued: number;
}

/**
 * Un tick del scheduler: vence lo que ya no tiene sentido y encola lo que toca. Cross-tenant
 * por diseño (`withSystem`); cada job lleva su negocio.
 */
export async function sweepDueReminders(db: Executor, options: { now?: Date; limit?: number } = {}): Promise<SweepResult> {
  const now = options.now ?? new Date();
  const limit = options.limit ?? SWEEP_BATCH;
  return withSystem(db, async (tx) => {
    const expired = rowsOf(
      await tx.execute(sql`
        UPDATE reminders r
           SET status = 'skipped', error = 'expired', updated_at = now()
          FROM appointments a
         WHERE a.id = r.appointment_id
           AND r.status = 'pending'
           AND (a.starts_at <= ${now.toISOString()}::timestamptz OR a.status NOT IN ('pending', 'confirmed'))
        RETURNING r.id
      `),
    ).length;
    const due = await tx
      .select({ id: reminders.id, businessId: reminders.businessId, scheduledFor: reminders.scheduledFor })
      .from(reminders)
      .where(and(eq(reminders.status, "pending"), isNull(reminders.error), lte(reminders.scheduledFor, now)))
      .orderBy(asc(reminders.scheduledFor))
      .limit(limit);
    let enqueued = 0;
    for (const r of due) {
      const result = await enqueue<ReminderJobPayload>(tx, {
        type: REMINDER_SEND_JOB,
        businessId: r.businessId,
        payload: { reminderId: r.id, scheduledFor: r.scheduledFor.toISOString() },
        dedupeKey: `reminder:${r.id}:${r.scheduledFor.getTime()}`,
      });
      if (result.created) enqueued++;
    }
    return { expired, enqueued };
  });
}

/**
 * Loop de recordatorios (procesos `ROLE=worker|all`): un tick cada `REMINDERS_INTERVAL_MS`
 * (default 60 s) en la réplica que tiene el lease.
 */
export function startReminderScheduler(options: { db: Executor; intervalMs?: number }): Loop {
  const intervalMs = options.intervalMs ?? msFromEnv("REMINDERS_INTERVAL_MS", 60_000);
  return startLeaderLoop({
    db: options.db,
    label: "reminders",
    intervalMs,
    tick: async () => {
      const result = await sweepDueReminders(options.db);
      if (result.enqueued > 0 || result.expired > 0) log.info("reminders_sweep", { ...result });
    },
    onError: (e, phase) => {
      log.error("reminders_sweep_failed", { phase, error: e instanceof Error ? e.message : String(e) });
      captureError(e, { scheduler: "reminders", phase });
    },
    scalingHint: "Bajá REMINDERS_INTERVAL_MS o revisá índices de `reminders`.",
  });
}

// ── Job `reminder.send` ─────────────────────────────────────────────────────

export interface ReminderJobPayload {
  reminderId: string;
  /** Hora programada con la que se encoló (si la cita se reprogramó, el job viejo no hace nada). */
  scheduledFor: string;
}

/** Lo que el módulo whatsapp necesita para mandar un recordatorio (ids, sin datos personales). */
export interface WhatsAppReminderRequest {
  businessId: string;
  reminderId: string;
  appointmentId: string;
  clientId: string;
  kind: ReminderKind;
  /** Hora programada (ISO): clave de idempotencia del envío. */
  scheduledFor: string;
}

export interface ReminderJobDeps {
  /**
   * ¿El negocio tiene un número de WhatsApp conectado? Lo inyecta la composición
   * (src/jobs.ts): el núcleo no importa el módulo whatsapp. Default: no.
   */
  isWhatsAppConnected?: (db: Executor, businessId: string) => Promise<boolean>;
  /**
   * Encola el envío por WhatsApp DENTRO de la transacción que marca el recordatorio como
   * enviado (outbox). Lo inyecta la composición; sin él, queda `whatsapp_pending`.
   */
  queueWhatsAppReminder?: (tx: Tx, request: WhatsAppReminderRequest) => Promise<void>;
  now?: () => Date;
}

export type ReminderOutcome = "sent_email" | "sent_whatsapp" | typeof WHATSAPP_PENDING | "skipped" | "noop";

/** Corre un recordatorio vencido. Idempotente: un reintento o un job viejo no duplica nada. */
export async function handleReminderJob(
  payload: ReminderJobPayload,
  ctx: { db: Executor; businessId: string | null },
  deps: ReminderJobDeps = {},
): Promise<ReminderOutcome> {
  const businessId = ctx.businessId;
  const reminderId = (payload as Partial<ReminderJobPayload> | null)?.reminderId;
  const scheduledMs = Date.parse(String((payload as Partial<ReminderJobPayload> | null)?.scheduledFor ?? ""));
  if (!businessId || !isTenantId(reminderId) || Number.isNaN(scheduledMs)) {
    throw new PermanentJobError(`Job ${REMINDER_SEND_JOB} con payload inválido`);
  }
  const now = deps.now?.() ?? new Date();
  // Fuera de la transacción: el contexto sale del caché (con la base, no con la transacción).
  const business = await getBusinessContext(ctx.db, businessId);
  if (!business) return "noop";
  const whatsappConnected = (await deps.isWhatsAppConnected?.(ctx.db, businessId)) ?? false;

  return withTenant(ctx.db, businessId, async (tx): Promise<ReminderOutcome> => {
    const [reminder] = await tx
      .select()
      .from(reminders)
      .where(and(eq(reminders.businessId, businessId), eq(reminders.id, reminderId)))
      .limit(1)
      .for("update");
    if (!reminder || reminder.status !== "pending" || reminder.error || reminder.scheduledFor.getTime() !== scheduledMs) return "noop";

    const mark = (changes: Partial<typeof reminders.$inferInsert>) =>
      tx.update(reminders).set(changes).where(and(eq(reminders.businessId, businessId), eq(reminders.id, reminder.id)));

    const [appointment] = await tx
      .select()
      .from(appointments)
      .where(and(eq(appointments.businessId, businessId), eq(appointments.id, reminder.appointmentId)))
      .limit(1);
    const alive = appointment && (ACTIVE_APPOINTMENT_STATUSES as readonly string[]).includes(appointment.status);
    if (!appointment || !alive || appointment.startsAt.getTime() <= now.getTime()) {
      await mark({ status: "skipped", error: "expired" });
      return "skipped";
    }

    const client = await getClient(tx, businessId, appointment.clientId);
    const email = client && !client.anonymized ? client.email : null;
    const decision = resolveReminderChannel({
      businessChannels: business.reminderChannels,
      preferred: client?.preferredChannel ?? null,
      hasEmail: Boolean(email),
      whatsappConnected,
    });

    if (decision === "email" && client && email) {
      const location = business.locations.find((l) => l.id === appointment.locationId);
      if (!location) {
        await mark({ status: "skipped", error: "location_missing" });
        return "skipped";
      }
      const lines = await tx
        .select({ name: appointmentServices.name })
        .from(appointmentServices)
        .where(and(eq(appointmentServices.businessId, businessId), eq(appointmentServices.appointmentId, appointment.id)))
        .orderBy(asc(appointmentServices.position));
      const staff = await getStaffMember(tx, businessId, appointment.staffId);
      const content = appointmentReminderEmail({
        businessName: business.business.name,
        brandColor: business.business.branding.accentColor ?? null,
        clientName: client.name,
        services: lines.map((l) => l.name),
        startsAt: appointment.startsAt,
        timeZone: location.timezone,
        locationName: location.name,
        locationAddress: location.address,
        staffName: staff?.name ?? null,
      });
      await queueEmail(
        tx,
        { to: email, ...content, tags: { kind: "appointment_reminder", business_id: businessId } },
        { businessId, dedupeKey: `reminder-email:${reminder.id}:${scheduledMs}` },
      );
      await mark({ status: "sent", sentAt: now, channel: "email", error: null });
      return "sent_email";
    }

    if (decision === "whatsapp" && client && deps.queueWhatsAppReminder) {
      // El módulo whatsapp elige plantilla o texto con botones según la ventana de 24 h.
      await deps.queueWhatsAppReminder(tx, {
        businessId,
        reminderId: reminder.id,
        appointmentId: appointment.id,
        clientId: client.id,
        kind: reminder.kind as ReminderKind,
        scheduledFor: reminder.scheduledFor.toISOString(),
      });
      await mark({ status: "sent", sentAt: now, channel: "whatsapp", error: null });
      return "sent_whatsapp";
    }

    if (decision === "whatsapp" || decision === WHATSAPP_PENDING) {
      // Sin número conectado (o sin el módulo inyectado): queda pendiente y el barrido no
      // lo vuelve a tomar.
      await mark({ channel: "whatsapp", error: WHATSAPP_PENDING });
      return WHATSAPP_PENDING;
    }

    await mark({ status: "skipped", error: "no_channel" });
    return "skipped";
  });
}

/**
 * El canal no pudo entregar un recordatorio que ya se había dado por enviado (p. ej. el
 * negocio no tiene plantilla aprobada y el cliente está fuera de la ventana de 24 h de
 * WhatsApp, o Meta lo rechazó). Lo llama el módulo que hizo el envío. `error` es un código
 * corto, sin datos personales.
 */
export async function recordReminderDeliveryFailure(
  executor: Executor,
  businessId: string,
  reminderId: string,
  error: string,
): Promise<boolean> {
  if (!isTenantId(reminderId)) return false;
  const rows = await withTenant(executor, businessId, (tx) =>
    tx
      .update(reminders)
      .set({ status: "failed", error: error.slice(0, 120) })
      .where(and(eq(reminders.businessId, businessId), eq(reminders.id, reminderId)))
      .returning({ id: reminders.id }),
  );
  return rows.length > 0;
}

/** Recordatorios de una cita (tests y diagnóstico). */
export function listAppointmentReminders(db: Executor, businessId: string, appointmentId: string) {
  return withTenant(db, businessId, (tx) =>
    tx
      .select()
      .from(reminders)
      .where(and(eq(reminders.businessId, businessId), eq(reminders.appointmentId, appointmentId)))
      .orderBy(asc(reminders.scheduledFor)),
  );
}
