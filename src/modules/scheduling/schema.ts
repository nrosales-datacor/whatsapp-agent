import { sql } from "drizzle-orm";
import { bigint, check, index, integer, jsonb, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { instant, oneOf, timestamps, uuidPk } from "../../platform/db/columns";
import { tenantPolicy } from "../../platform/db/rls";
import { businesses, locations } from "../business/schema";
import { services } from "../catalog/schema";
import { clients } from "../clients/schema";
import { staff, users } from "../team/schema";

// ─────────────────────────────────────────────────────────────────────────────
// Módulo scheduling: citas, sus líneas de servicio y sus recordatorios
// (PLAN-GESTION.md §4).
//
// Anti-solape en la BASE (no solo en la app): `appointments` lleva
//   EXCLUDE USING gist (staff_id WITH =, tstzrange(starts_at, ends_at, '[)') WITH &&)
//   WHERE (status IN ('pending', 'confirmed'))
// Dos citas vivas del mismo profesional no pueden pisarse ni un minuto; las canceladas,
// completadas y no-show no bloquean. '[)': una cita que termina 10:00 y otra que empieza
// 10:00 no chocan. Drizzle no expresa EXCLUDE: está en SQL a mano en la migración
// 0002_domain_constraints.sql (btree_gist lo crea la migración base). Si se regeneran
// las migraciones, ese archivo se conserva tal cual; test/reliability/appointmentOverlap
// falla si el constraint se pierde.
//
// Borrados: las citas son registro contable (pagos, comisiones), así que sus FKs a
// sucursal, cliente y profesional son NO ACTION (borrar uno de esos con citas falla; se
// desactiva o, para el derecho de supresión, se anonimiza). NO ACTION y no RESTRICT: el
// chequeo corre al final de la sentencia, así la baja de un negocio (cascada desde
// `businesses` a todo) no choca con el orden en que se borran las tablas.
// ─────────────────────────────────────────────────────────────────────────────

export const APPOINTMENT_STATUSES = ["pending", "confirmed", "completed", "cancelled", "no_show"] as const;
export type AppointmentStatus = (typeof APPOINTMENT_STATUSES)[number];

/** Estados que ocupan la agenda del profesional (los del EXCLUDE). */
export const ACTIVE_APPOINTMENT_STATUSES = ["pending", "confirmed"] as const satisfies readonly AppointmentStatus[];

export const APPOINTMENT_CHANNELS = ["whatsapp_ai", "panel", "phone", "walk_in", "web"] as const;
export type AppointmentChannel = (typeof APPOINTMENT_CHANNELS)[number];

export const REMINDER_KINDS = ["day_before", "same_day"] as const;
export type ReminderKind = (typeof REMINDER_KINDS)[number];

export const REMINDER_DELIVERY_CHANNELS = ["whatsapp", "email"] as const;
export type ReminderDeliveryChannel = (typeof REMINDER_DELIVERY_CHANNELS)[number];

export const REMINDER_STATUSES = ["pending", "sent", "failed", "cancelled", "skipped"] as const;
export type ReminderStatus = (typeof REMINDER_STATUSES)[number];

const businessId = () =>
  uuid("business_id")
    .notNull()
    .references(() => businesses.id, { onDelete: "cascade" });

export const appointments = pgTable(
  "appointments",
  {
    id: uuidPk(),
    businessId: businessId(),
    locationId: uuid("location_id")
      .notNull()
      .references(() => locations.id),
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id),
    staffId: uuid("staff_id")
      .notNull()
      .references(() => staff.id),
    // Rango [starts_at, ends_at): incluye el buffer de los servicios (es lo que ocupa al
    // profesional y lo que compara el EXCLUDE).
    startsAt: instant("starts_at").notNull(),
    endsAt: instant("ends_at").notNull(),
    status: text("status").notNull().default("pending"),
    channel: text("channel").notNull().default("panel"),
    // Total de las líneas (copia, para saldos y reportes sin sumar en cada consulta).
    // Saldo = total_cents − pagos de la cita.
    totalCents: bigint("total_cents", { mode: "number" }).notNull().default(0),
    notes: text("notes"),
    // Valores de los campos personalizados de cita (definiciones en `custom_fields`).
    customData: jsonb("custom_data").$type<Record<string, unknown>>().notNull().default({}),
    // Usuario del panel que la creó; null = el agente IA o un proceso del sistema.
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    confirmedAt: instant("confirmed_at"),
    cancelledAt: instant("cancelled_at"),
    cancellationReason: text("cancellation_reason"),
    ...timestamps(),
  },
  (t) => [
    // Agenda de una sucursal por rango (vista día/semana).
    index("appointments_location_starts_idx").on(t.businessId, t.locationId, t.startsAt),
    // Agenda de todas las sucursales por rango (dueño con "Todas", Inicio, reportes).
    index("appointments_business_starts_idx").on(t.businessId, t.startsAt),
    // Agenda de un profesional por rango ("Mi agenda", disponibilidad).
    index("appointments_staff_starts_idx").on(t.staffId, t.startsAt),
    // Historial de un cliente (ficha, agente).
    index("appointments_client_starts_idx").on(t.clientId, t.startsAt),
    // Citas CREADAS en un rango (lo que agendó cada canal, Inicio y reportes de canales).
    index("appointments_business_created_idx").on(t.businessId, t.createdAt),
    check("appointments_range_check", sql`${t.endsAt} > ${t.startsAt}`),
    check("appointments_status_check", oneOf(t.status, APPOINTMENT_STATUSES)),
    check("appointments_channel_check", oneOf(t.channel, APPOINTMENT_CHANNELS)),
    check("appointments_total_check", sql`${t.totalCents} >= 0`),
    tenantPolicy(),
  ],
).enableRLS();

// ─────────────────────────────────────────────────────────────────────────────
// Líneas de servicio de una cita (mani + pedi = dos líneas). Copian nombre, duración y
// precio al agendar: renombrar o cambiar el precio de un servicio no reescribe el
// histórico. Las comisiones se calculan por línea.
// ─────────────────────────────────────────────────────────────────────────────
export const appointmentServices = pgTable(
  "appointment_services",
  {
    id: uuidPk(),
    businessId: businessId(),
    appointmentId: uuid("appointment_id")
      .notNull()
      .references(() => appointments.id, { onDelete: "cascade" }),
    // SET NULL: la línea conserva su copia aunque el servicio desaparezca.
    serviceId: uuid("service_id").references(() => services.id, { onDelete: "set null" }),
    name: text("name").notNull(),
    durationMin: integer("duration_min").notNull(),
    priceCents: bigint("price_cents", { mode: "number" }).notNull(),
    position: integer("position").notNull().default(0),
    ...timestamps(),
  },
  (t) => [
    index("appointment_services_appointment_idx").on(t.appointmentId, t.position),
    // Reportes por servicio.
    index("appointment_services_service_idx").on(t.serviceId),
    check("appointment_services_duration_check", sql`${t.durationMin} > 0`),
    check("appointment_services_price_check", sql`${t.priceCents} >= 0`),
    tenantPolicy(),
  ],
).enableRLS();

// ─────────────────────────────────────────────────────────────────────────────
// Recordatorios programados de una cita, por WhatsApp o correo (§4, "Canal del
// recordatorio"). Uno por tipo y cita (idempotencia del scheduler). El envío real va por
// la cola (efecto externo).
// ─────────────────────────────────────────────────────────────────────────────
export const reminders = pgTable(
  "reminders",
  {
    id: uuidPk(),
    businessId: businessId(),
    appointmentId: uuid("appointment_id")
      .notNull()
      .references(() => appointments.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    channel: text("channel").notNull(),
    scheduledFor: instant("scheduled_for").notNull(),
    sentAt: instant("sent_at"),
    status: text("status").notNull().default("pending"),
    error: text("error"),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("reminders_appointment_kind_uq").on(t.appointmentId, t.kind),
    // Barrido del scheduler (contexto de sistema): pendientes que ya tocan, más viejos primero.
    index("reminders_due_idx").on(t.scheduledFor).where(sql`${t.status} = 'pending'`),
    check("reminders_kind_check", oneOf(t.kind, REMINDER_KINDS)),
    check("reminders_channel_check", oneOf(t.channel, REMINDER_DELIVERY_CHANNELS)),
    check("reminders_status_check", oneOf(t.status, REMINDER_STATUSES)),
    tenantPolicy(),
  ],
).enableRLS();

export type Appointment = typeof appointments.$inferSelect;
export type NewAppointment = typeof appointments.$inferInsert;
export type AppointmentService = typeof appointmentServices.$inferSelect;
export type NewAppointmentService = typeof appointmentServices.$inferInsert;
export type Reminder = typeof reminders.$inferSelect;
export type NewReminder = typeof reminders.$inferInsert;
