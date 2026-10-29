import { and, asc, count, desc, eq, gte, inArray, lt, max, min, or, type SQL } from "drizzle-orm";
import { hasPgCode } from "../../platform/db/errors";
import { isTenantId, withTenant, type Executor, type Tx } from "../../platform/db/scope";
import { HttpError, ValidationError } from "../../platform/http/errors";
import { getBusinessContext, listLocations, type Terminology } from "../business";
import { getClient, getClientsByIds, refreshClientStats } from "../clients";
import { listStaff } from "../team";
import {
  bookingMinLeadMin,
  checkStart,
  loadAvailabilityInputs,
  loadCandidates,
  loadScheduleContext,
  locationForSchedule,
  normalizeServiceIds,
  type AvailabilityInputs,
  type StaffCandidate,
  type StartProblem,
} from "./availability";
import { cancelPendingReminders, syncAppointmentReminders } from "./reminders";
import {
  ACTIVE_APPOINTMENT_STATUSES,
  appointments,
  appointmentServices,
  type Appointment,
  type AppointmentChannel,
  type AppointmentStatus,
} from "./schema";
import { MINUTE_MS } from "./time";

// ─────────────────────────────────────────────────────────────────────────────
// Servicio de citas: UNO solo para el panel y el agente de WhatsApp (PLAN-GESTION.md §2).
//
//   • Reservar (`bookAppointment`): valida sucursal, cliente y servicios, elige
//     profesional (uno o "cualquiera"), y DENTRO de la transacción vuelve a chequear el
//     horario y las ausencias con lo que hay en la base en ese momento. El solape con otra
//     cita lo frena la base (EXCLUDE por profesional y rango, error 23P01) y se traduce a
//     409 `slot_taken`: dos reservas simultáneas al mismo horario, una gana. Con
//     "cualquiera", si a uno se lo ganaron se prueba con el siguiente libre.
//   • Las líneas copian nombre, duración y precio; `total_cents` es su suma.
//   • Estados: pending → confirmed → completed | cancelled | no_show (pending también
//     puede ir directo a completed, cancelled o no_show). Los finales no se mueven.
//     Completar o marcar no-show exige que la cita ya haya empezado.
//   • Completar refresca la caché de visitas del cliente en la MISMA transacción
//     (`refreshClientStats` con valores absolutos calculados desde las citas completadas).
//   • Reservar/reprogramar programa los recordatorios; cancelar, completar o no-show
//     invalida los pendientes (./reminders.ts).
//   • Margen mínimo (`BOOKING_MIN_LEAD_MIN`) para lo que agenda el cliente (agente, web);
//     el equipo del panel puede tomar el próximo horario libre, y con `allowOutsideHours`
//     anotar una cita fuera de horario o ya pasada (el walk-in de la mañana anotado a la
//     tarde), pero nunca encimar dos citas del mismo profesional.
//
// Permisos (rol, sucursal, "solo mis citas") los aplica la ruta: estas funciones son del
// negocio y las llama también el agente.
// ─────────────────────────────────────────────────────────────────────────────

/** Transiciones válidas de estado. */
export const APPOINTMENT_TRANSITIONS: Readonly<Record<AppointmentStatus, readonly AppointmentStatus[]>> = {
  pending: ["confirmed", "completed", "cancelled", "no_show"],
  confirmed: ["completed", "cancelled", "no_show"],
  completed: [],
  cancelled: [],
  no_show: [],
};

export function canTransition(from: AppointmentStatus, to: AppointmentStatus): boolean {
  return APPOINTMENT_TRANSITIONS[from]?.includes(to) ?? false;
}

export const isActiveStatus = (status: string): boolean => (ACTIVE_APPOINTMENT_STATUSES as readonly string[]).includes(status);

/** Canales del cliente final: a estos se les exige el margen mínimo y servicios "en línea". */
const CLIENT_CHANNELS: readonly AppointmentChannel[] = ["whatsapp_ai", "web"];

// ── Vistas ──────────────────────────────────────────────────────────────────

export interface AppointmentLineView {
  id: string;
  serviceId: string | null;
  name: string;
  durationMin: number;
  priceCents: number;
  position: number;
}

/** Cita tal como la ven el panel y el agente. Instantes en ISO 8601 (UTC). */
export interface AppointmentView {
  id: string;
  locationId: string;
  clientId: string;
  staffId: string;
  startsAt: string;
  /** Fin de lo que ocupa al profesional (incluye el buffer del último servicio). */
  endsAt: string;
  status: AppointmentStatus;
  channel: AppointmentChannel;
  totalCents: number;
  notes: string | null;
  createdBy: string | null;
  confirmedAt: string | null;
  cancelledAt: string | null;
  cancellationReason: string | null;
  createdAt: string;
  updatedAt: string;
  client: { id: string; name: string; phone: string | null; email: string | null } | null;
  staff: { id: string; name: string; color: string | null } | null;
  location: { id: string; name: string; timezone: string } | null;
  services: AppointmentLineView[];
}

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

/** Arma las vistas (líneas, cliente, profesional y sucursal) de un lote de filas, en su orden. */
async function toViews(executor: Executor, businessId: string, rows: readonly Appointment[]): Promise<AppointmentView[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const lines = await withTenant(executor, businessId, (tx) =>
    tx
      .select()
      .from(appointmentServices)
      .where(and(eq(appointmentServices.businessId, businessId), inArray(appointmentServices.appointmentId, ids)))
      .orderBy(asc(appointmentServices.position)),
  );
  const clients = await getClientsByIds(executor, businessId, [...new Set(rows.map((r) => r.clientId))]);
  const staff = await listStaff(executor, businessId);
  const locations = await listLocations(executor, businessId);
  const clientById = new Map(clients.map((c) => [c.id, c]));
  const staffById = new Map(staff.map((s) => [s.id, s]));
  const locationById = new Map(locations.map((l) => [l.id, l]));
  const linesBy = new Map<string, AppointmentLineView[]>();
  for (const l of lines) {
    const list = linesBy.get(l.appointmentId) ?? [];
    list.push({ id: l.id, serviceId: l.serviceId, name: l.name, durationMin: l.durationMin, priceCents: l.priceCents, position: l.position });
    linesBy.set(l.appointmentId, list);
  }
  return rows.map((r) => {
    const c = clientById.get(r.clientId);
    const s = staffById.get(r.staffId);
    const l = locationById.get(r.locationId);
    return {
      id: r.id,
      locationId: r.locationId,
      clientId: r.clientId,
      staffId: r.staffId,
      startsAt: r.startsAt.toISOString(),
      endsAt: r.endsAt.toISOString(),
      status: r.status as AppointmentStatus,
      channel: r.channel as AppointmentChannel,
      totalCents: r.totalCents,
      notes: r.notes,
      createdBy: r.createdBy,
      confirmedAt: iso(r.confirmedAt),
      cancelledAt: iso(r.cancelledAt),
      cancellationReason: r.cancellationReason,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
      client: c ? { id: c.id, name: c.name, phone: c.phone, email: c.email } : null,
      staff: s ? { id: s.id, name: s.name, color: s.color } : null,
      location: l ? { id: l.id, name: l.name, timezone: l.timezone } : null,
      services: linesBy.get(r.id) ?? [],
    };
  });
}

// ── Errores ─────────────────────────────────────────────────────────────────

async function terminology(executor: Executor, businessId: string): Promise<Terminology> {
  const ctx = await getBusinessContext(executor, businessId);
  if (!ctx) throw new HttpError(404, "Negocio no encontrado.", "not_found");
  return ctx.terminology;
}

const notFound = (t: Terminology) => new HttpError(404, `No encontramos esa ${t.appointment}.`, "not_found");
const slotTaken = () => new HttpError(409, "Ese horario ya no está disponible. Elegí otro.", "slot_taken");

const STATUS_LABEL: Record<AppointmentStatus, string> = {
  pending: "sin confirmar",
  confirmed: "confirmada",
  completed: "completada",
  cancelled: "cancelada",
  no_show: "marcada como no asistió",
};

function invalidTransition(t: Terminology, from: AppointmentStatus, action: string): HttpError {
  return new HttpError(409, `No se puede ${action} una ${t.appointment} ${STATUS_LABEL[from]}.`, "invalid_transition");
}

/** 400 por campo según el problema del horario. */
function startProblemError(problem: StartProblem, t: Terminology): HttpError {
  switch (problem) {
    case "busy":
      return slotTaken();
    case "staff_unavailable":
      return new ValidationError({
        staffId: `Ese ${t.staffMember} no hace alguno de los servicios o no atiende en esta ${t.location}.`,
      });
    case "outside_hours":
      return new ValidationError({ startsAt: `A esa hora no hay atención (horario de la ${t.location} o del ${t.staffMember}).` });
    case "time_off":
      return new ValidationError({ startsAt: `Ese horario cae en una ausencia o un cierre.` });
    case "too_soon":
      return new ValidationError({ startsAt: "Ese horario ya pasó o es demasiado pronto para reservarlo." });
  }
}

/** ¿Es el 23P01 del EXCLUDE anti-solape? */
export function isOverlapViolation(error: unknown): boolean {
  return hasPgCode(error, "23P01");
}

// ── Lectura ─────────────────────────────────────────────────────────────────

/** Una cita del negocio (con cliente, profesional, sucursal y líneas), o null. */
export async function getAppointment(executor: Executor, businessId: string, appointmentId: string): Promise<AppointmentView | null> {
  if (!isTenantId(appointmentId)) return null;
  const rows = await withTenant(executor, businessId, (tx) =>
    tx
      .select()
      .from(appointments)
      .where(and(eq(appointments.businessId, businessId), eq(appointments.id, appointmentId)))
      .limit(1),
  );
  const [view] = await toViews(executor, businessId, rows);
  return view ?? null;
}

/** Varias citas del negocio por id, en el orden pedido (las que no existen se omiten). */
export async function getAppointmentsByIds(executor: Executor, businessId: string, ids: readonly string[]): Promise<AppointmentView[]> {
  const wanted = [...new Set(ids.filter(isTenantId).map((id) => id.toLowerCase()))];
  if (wanted.length === 0) return [];
  const rows = await withTenant(executor, businessId, (tx) =>
    tx
      .select()
      .from(appointments)
      .where(and(eq(appointments.businessId, businessId), inArray(appointments.id, wanted))),
  );
  const order = new Map(wanted.map((id, i) => [id, i]));
  rows.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
  return toViews(executor, businessId, rows);
}

async function getOrThrow(executor: Executor, businessId: string, appointmentId: string): Promise<AppointmentView> {
  const view = await getAppointment(executor, businessId, appointmentId);
  if (!view) throw notFound(await terminology(executor, businessId));
  return view;
}

export interface ListAppointmentsFilter {
  /** Citas que EMPIEZAN en [from, to). */
  from: Date;
  to: Date;
  /** null/ausente = todas las sucursales. */
  locationIds?: readonly string[] | null;
  staffId?: string | null;
  clientId?: string | null;
  statuses?: readonly AppointmentStatus[];
  /** Tope de filas (default 2000). */
  limit?: number;
}

/** Citas de un rango (agenda día/semana), por hora de inicio. */
export async function listAppointments(executor: Executor, businessId: string, filter: ListAppointmentsFilter): Promise<AppointmentView[]> {
  const conditions: SQL[] = [eq(appointments.businessId, businessId), gte(appointments.startsAt, filter.from), lt(appointments.startsAt, filter.to)];
  if (filter.locationIds) {
    if (filter.locationIds.length === 0) return [];
    conditions.push(inArray(appointments.locationId, [...filter.locationIds]));
  }
  if (filter.staffId) conditions.push(eq(appointments.staffId, filter.staffId));
  if (filter.clientId) conditions.push(eq(appointments.clientId, filter.clientId));
  if (filter.statuses?.length) conditions.push(inArray(appointments.status, [...filter.statuses]));
  const rows = await withTenant(executor, businessId, (tx) =>
    tx
      .select()
      .from(appointments)
      .where(and(...conditions))
      .orderBy(asc(appointments.startsAt), asc(appointments.id))
      .limit(filter.limit ?? 2000),
  );
  return toViews(executor, businessId, rows);
}

/** Próximas citas vivas de un cliente (agente: "¿cuándo es mi cita?"), de la más cercana a la más lejana. */
export async function listUpcomingAppointmentsForClient(
  executor: Executor,
  businessId: string,
  clientId: string,
  options: { now?: Date; limit?: number } = {},
): Promise<AppointmentView[]> {
  if (!isTenantId(clientId)) return [];
  const rows = await withTenant(executor, businessId, (tx) =>
    tx
      .select()
      .from(appointments)
      .where(
        and(
          eq(appointments.businessId, businessId),
          eq(appointments.clientId, clientId),
          inArray(appointments.status, [...ACTIVE_APPOINTMENT_STATUSES]),
          gte(appointments.startsAt, options.now ?? new Date()),
        ),
      )
      .orderBy(asc(appointments.startsAt))
      .limit(Math.min(Math.max(options.limit ?? 10, 1), 50)),
  );
  return toViews(executor, businessId, rows);
}

export interface ClientHistoryPage {
  items: AppointmentView[];
  nextCursor: string | null;
}

function encodeCursor(row: Pick<Appointment, "startsAt" | "id">): string {
  return Buffer.from(`${row.startsAt.toISOString()}|${row.id}`, "utf8").toString("base64url");
}

function decodeCursor(cursor: string): { startsAt: Date; id: string } | null {
  const [when, id] = Buffer.from(cursor, "base64url").toString("utf8").split("|");
  const startsAt = new Date(when ?? "");
  return Number.isNaN(startsAt.getTime()) || !isTenantId(id) ? null : { startsAt, id };
}

/**
 * Historial de citas de un cliente para su ficha: de la más nueva a la más vieja, con
 * paginación por cursor. `staffId` / `locationIds` acotan (rol profesional, recepción).
 */
export async function listClientAppointments(
  executor: Executor,
  businessId: string,
  clientId: string,
  options: { limit?: number; cursor?: string | null; staffId?: string | null; locationIds?: readonly string[] | null } = {},
): Promise<ClientHistoryPage> {
  const limit = Math.min(Math.max(options.limit ?? 20, 1), 100);
  if (!isTenantId(clientId)) return { items: [], nextCursor: null };
  const conditions: SQL[] = [eq(appointments.businessId, businessId), eq(appointments.clientId, clientId)];
  if (options.staffId) conditions.push(eq(appointments.staffId, options.staffId));
  if (options.locationIds) {
    if (options.locationIds.length === 0) return { items: [], nextCursor: null };
    conditions.push(inArray(appointments.locationId, [...options.locationIds]));
  }
  if (options.cursor) {
    const c = decodeCursor(options.cursor);
    if (!c) throw new ValidationError({ cursor: "Cursor inválido." });
    const older = or(lt(appointments.startsAt, c.startsAt), and(eq(appointments.startsAt, c.startsAt), lt(appointments.id, c.id)));
    if (older) conditions.push(older);
  }
  const rows = await withTenant(executor, businessId, (tx) =>
    tx
      .select()
      .from(appointments)
      .where(and(...conditions))
      .orderBy(desc(appointments.startsAt), desc(appointments.id))
      .limit(limit + 1),
  );
  const page = rows.slice(0, limit);
  return { items: await toViews(executor, businessId, page), nextCursor: rows.length > limit ? encodeCursor(page[page.length - 1]) : null };
}

// ── Reserva ─────────────────────────────────────────────────────────────────

export interface BookAppointmentInput {
  locationId: string;
  clientId: string;
  serviceIds: readonly string[];
  /** Un profesional, o "any"/null/ausente = el primero libre (el preferido del cliente primero). */
  staffId?: string | "any" | null;
  startsAt: Date;
  channel: AppointmentChannel;
  notes?: string | null;
  /** Usuario del panel que la crea (null = el agente o el sistema). */
  createdBy?: string | null;
  /** Solo el equipo: cita fuera de horario o ya pasada (sigue sin poder encimarse). */
  allowOutsideHours?: boolean;
  /** Margen mínimo en minutos; default según el canal (cliente: `BOOKING_MIN_LEAD_MIN`; equipo: 0). */
  minLeadMin?: number;
  /** Reloj (tests). */
  now?: Date;
}

interface StartRules {
  now: Date;
  minLeadMin: number;
  ignoreHours: boolean;
  allowPast: boolean;
}

function startRules(input: { channel: AppointmentChannel; allowOutsideHours?: boolean; minLeadMin?: number; now?: Date }): StartRules {
  const fromClient = CLIENT_CHANNELS.includes(input.channel);
  const outside = Boolean(input.allowOutsideHours) && !fromClient;
  return {
    now: input.now ?? new Date(),
    minLeadMin: input.minLeadMin ?? (fromClient ? bookingMinLeadMin() : 0),
    ignoreHours: outside,
    allowPast: outside,
  };
}

/** Re-chequeo dentro de la transacción: horario y ausencias con lo que hay ahora en la base (el solape lo frena el EXCLUDE). */
async function recheck(
  tx: Tx,
  businessId: string,
  location: AvailabilityInputs["location"],
  candidate: StaffCandidate,
  startsAt: Date,
  rules: StartRules,
  excludeAppointmentId?: string,
): Promise<StartProblem | null> {
  const context = await loadScheduleContext(tx, businessId, {
    locationId: location.id,
    staffIds: [candidate.id],
    from: startsAt,
    to: new Date(startsAt.getTime() + 1),
    excludeAppointmentId,
  });
  const inputs: AvailabilityInputs = { location, services: [], candidates: [candidate], ...context, from: startsAt, to: startsAt };
  return checkStart(inputs, candidate.id, startsAt, { ...rules, ignoreBusy: true });
}

/** Inserta la cita y sus líneas en un savepoint (si choca, se deshace solo esto). */
async function insertAppointment(
  tx: Tx,
  businessId: string,
  input: BookAppointmentInput,
  candidate: StaffCandidate,
  locationId: string,
): Promise<Appointment> {
  return tx.transaction(async (sp) => {
    const endsAt = new Date(input.startsAt.getTime() + (candidate.workMin + candidate.trailingBufferMin) * MINUTE_MS);
    const [row] = await sp
      .insert(appointments)
      .values({
        businessId,
        locationId,
        clientId: input.clientId.toLowerCase(),
        staffId: candidate.id,
        startsAt: input.startsAt,
        endsAt,
        status: "pending",
        channel: input.channel,
        totalCents: candidate.totalCents,
        notes: input.notes?.trim() || null,
        createdBy: input.createdBy ?? null,
      })
      .returning();
    await sp.insert(appointmentServices).values(
      candidate.terms.map((t, position) => ({
        businessId,
        appointmentId: row.id,
        serviceId: t.serviceId,
        name: t.name,
        durationMin: t.durationMin,
        priceCents: t.priceCents,
        position,
      })),
    );
    return row;
  });
}

/**
 * Reserva una cita (API pública: panel y agente). Devuelve la cita creada (`pending`).
 * Errores: 400 por campo (sucursal, cliente, servicios, profesional, horario fuera de
 * atención o en una ausencia, demasiado pronto), 409 `slot_taken` si el horario ya no está.
 */
export async function bookAppointment(executor: Executor, businessId: string, input: BookAppointmentInput): Promise<AppointmentView> {
  const t = await terminology(executor, businessId);
  if (Number.isNaN(input.startsAt.getTime())) throw new ValidationError({ startsAt: "Fecha y hora inválidas." });
  normalizeServiceIds(input.serviceIds);
  const client = isTenantId(input.clientId) ? await getClient(executor, businessId, input.clientId) : null;
  if (!client) throw new ValidationError({ clientId: `Ese ${t.client} no existe.` });
  if (client.anonymized) throw new ValidationError({ clientId: `Los datos de este ${t.client} se eliminaron: no se le pueden agendar ${t.appointments}.` });

  const rules = startRules(input);
  const fromClient = CLIENT_CHANNELS.includes(input.channel);
  // Primera pasada (fuera de la transacción): quién puede y está libre a esa hora.
  const inputs = await loadAvailabilityInputs(executor, businessId, {
    locationId: input.locationId,
    serviceIds: input.serviceIds,
    staffId: input.staffId,
    from: input.startsAt,
    to: new Date(input.startsAt.getTime() + 1),
    onlineOnly: fromClient,
  });
  if (!inputs.location.active) throw new ValidationError({ locationId: `Esa ${t.location} está desactivada.` });
  const specific = input.staffId && input.staffId !== "any" ? input.staffId.toLowerCase() : null;
  if (inputs.candidates.length === 0) {
    throw specific
      ? startProblemError("staff_unavailable", t)
      : new ValidationError({ serviceIds: `Ningún ${t.staffMember} de esta ${t.location} hace esos servicios.` });
  }
  const problems = new Map(inputs.candidates.map((c) => [c.id, checkStart(inputs, c.id, input.startsAt, rules)]));
  let ordered = inputs.candidates.filter((c) => problems.get(c.id) === null);
  if (ordered.length === 0) {
    const first = specific ? problems.get(specific) : [...problems.values()].find((p) => p === "busy") ?? [...problems.values()][0];
    throw startProblemError(first ?? "outside_hours", t);
  }
  // Con "cualquiera", el preferido del cliente primero; después el orden de la agenda.
  if (!specific && client.preferredStaffId) {
    ordered = [...ordered.filter((c) => c.id === client.preferredStaffId), ...ordered.filter((c) => c.id !== client.preferredStaffId)];
  }

  const id = await withTenant(executor, businessId, async (tx) => {
    let lastProblem: StartProblem | null = null;
    for (const candidate of ordered) {
      const problem = await recheck(tx, businessId, inputs.location, candidate, input.startsAt, rules);
      if (problem) {
        lastProblem = problem;
        continue;
      }
      let row: Appointment;
      try {
        row = await insertAppointment(tx, businessId, input, candidate, inputs.location.id);
      } catch (error) {
        if (!isOverlapViolation(error)) throw error;
        lastProblem = "busy";
        continue;
      }
      await syncAppointmentReminders(tx, businessId, row, { now: rules.now });
      return row.id;
    }
    throw startProblemError(lastProblem ?? "busy", t);
  });
  return getOrThrow(executor, businessId, id);
}

// ── Mover (reprogramar / reasignar) ─────────────────────────────────────────

export interface MoveInput {
  /** Nuevo inicio (default: el actual). */
  startsAt?: Date;
  /** Nuevo profesional (default: el actual). */
  staffId?: string;
  allowOutsideHours?: boolean;
  /** Canal de quien mueve (default "panel"): define el margen mínimo. */
  channel?: AppointmentChannel;
  minLeadMin?: number;
  now?: Date;
}

/**
 * Profesional "sintético" a partir de las líneas guardadas: misma persona, mismos servicios
 * y precios copiados; la duración de lo que ocupa se conserva (trabajo = Σ duraciones; el
 * resto es buffer).
 */
function candidateFromLines(row: Appointment, lines: AppointmentLineView[]): StaffCandidate {
  const occupied = Math.round((row.endsAt.getTime() - row.startsAt.getTime()) / MINUTE_MS);
  const work = Math.min(occupied, lines.reduce((n, l) => n + l.durationMin, 0) || occupied);
  return {
    id: row.staffId,
    name: "",
    color: null,
    position: 0,
    terms: lines.map((l) => ({
      serviceId: l.serviceId ?? "",
      name: l.name,
      durationMin: l.durationMin,
      bufferMin: 0,
      priceCents: l.priceCents,
      variablePrice: false,
    })),
    workMin: work,
    trailingBufferMin: occupied - work,
    totalCents: row.totalCents,
  };
}

async function moveAppointment(executor: Executor, businessId: string, appointmentId: string, move: MoveInput, action: string): Promise<AppointmentView> {
  const t = await terminology(executor, businessId);
  const current = await getOrThrow(executor, businessId, appointmentId);
  if (!isActiveStatus(current.status)) throw invalidTransition(t, current.status, action);
  const startsAt = move.startsAt ?? new Date(current.startsAt);
  if (Number.isNaN(startsAt.getTime())) throw new ValidationError({ startsAt: "Fecha y hora inválidas." });
  const staffId = (move.staffId ?? current.staffId).toLowerCase();
  const sameStaff = staffId === current.staffId;
  const rules = startRules({ channel: move.channel ?? "panel", allowOutsideHours: move.allowOutsideHours, minLeadMin: move.minLeadMin, now: move.now });
  const location = await locationForSchedule(executor, businessId, current.locationId);

  // Otra persona: duración y precio de ESA persona según el catálogo de hoy.
  let recomputed: StaffCandidate | null = null;
  if (!sameStaff) {
    if (current.services.some((l) => !l.serviceId)) {
      throw new HttpError(409, `Alguno de los servicios de esta ${t.appointment} ya no existe: cancelala y agendá una nueva.`, "services_unavailable");
    }
    let found: StaffCandidate[];
    try {
      ({ candidates: found } = await loadCandidates(executor, businessId, {
        locationId: location.id,
        serviceIds: current.services.map((l) => l.serviceId as string),
        staffId,
      }));
    } catch (error) {
      if (error instanceof ValidationError && error.fields.serviceIds) {
        throw new HttpError(409, `Alguno de los servicios de esta ${t.appointment} ya no se ofrece: cancelala y agendá una nueva.`, "services_unavailable");
      }
      throw error;
    }
    recomputed = found[0] ?? null;
    if (!recomputed) throw startProblemError("staff_unavailable", t);
  }

  const id = await withTenant(executor, businessId, async (tx) => {
    const [row] = await tx
      .select()
      .from(appointments)
      .where(and(eq(appointments.businessId, businessId), eq(appointments.id, current.id)))
      .limit(1)
      .for("update");
    if (!row) throw notFound(t);
    if (!isActiveStatus(row.status)) throw invalidTransition(t, row.status as AppointmentStatus, action);
    const candidate = recomputed ?? candidateFromLines(row, current.services);
    const problem = await recheck(tx, businessId, location, candidate, startsAt, rules, row.id);
    if (problem) throw startProblemError(problem, t);
    const endsAt = new Date(startsAt.getTime() + (candidate.workMin + candidate.trailingBufferMin) * MINUTE_MS);
    try {
      await tx.transaction(async (sp) => {
        await sp
          .update(appointments)
          .set({ staffId: candidate.id, startsAt, endsAt, totalCents: candidate.totalCents })
          .where(and(eq(appointments.businessId, businessId), eq(appointments.id, row.id)));
        if (recomputed) {
          await sp.delete(appointmentServices).where(and(eq(appointmentServices.businessId, businessId), eq(appointmentServices.appointmentId, row.id)));
          await sp.insert(appointmentServices).values(
            recomputed.terms.map((term, position) => ({
              businessId,
              appointmentId: row.id,
              serviceId: term.serviceId,
              name: term.name,
              durationMin: term.durationMin,
              priceCents: term.priceCents,
              position,
            })),
          );
        }
      });
    } catch (error) {
      if (isOverlapViolation(error)) throw slotTaken();
      throw error;
    }
    if (startsAt.getTime() !== row.startsAt.getTime()) {
      await syncAppointmentReminders(tx, businessId, { ...row, startsAt }, { now: rules.now });
    }
    return row.id;
  });
  return getOrThrow(executor, businessId, id);
}

/** Cambia el horario de una cita viva (y opcionalmente el profesional). */
export function rescheduleAppointment(
  executor: Executor,
  businessId: string,
  appointmentId: string,
  input: MoveInput & { startsAt: Date },
): Promise<AppointmentView> {
  return moveAppointment(executor, businessId, appointmentId, input, "reprogramar");
}

/** Pasa una cita viva a otro profesional (misma hora; duración y precio de esa persona). */
export function reassignStaff(
  executor: Executor,
  businessId: string,
  appointmentId: string,
  staffId: string,
  options: Omit<MoveInput, "staffId" | "startsAt"> = {},
): Promise<AppointmentView> {
  return moveAppointment(executor, businessId, appointmentId, { ...options, staffId }, "reasignar");
}

// ── Estados ─────────────────────────────────────────────────────────────────

async function transition(
  executor: Executor,
  businessId: string,
  appointmentId: string,
  to: AppointmentStatus,
  action: string,
  apply: (tx: Tx, row: Appointment, t: Terminology) => Promise<Partial<Appointment>>,
): Promise<AppointmentView> {
  const t = await terminology(executor, businessId);
  if (!isTenantId(appointmentId)) throw notFound(t);
  await withTenant(executor, businessId, async (tx) => {
    const [row] = await tx
      .select()
      .from(appointments)
      .where(and(eq(appointments.businessId, businessId), eq(appointments.id, appointmentId)))
      .limit(1)
      .for("update");
    if (!row) throw notFound(t);
    const from = row.status as AppointmentStatus;
    if (!canTransition(from, to)) throw invalidTransition(t, from, action);
    const changes = await apply(tx, row, t);
    await tx
      .update(appointments)
      .set({ ...changes, status: to })
      .where(and(eq(appointments.businessId, businessId), eq(appointments.id, row.id)));
    if (!isActiveStatus(to)) await cancelPendingReminders(tx, businessId, row.id);
    if (to === "completed") await refreshVisits(tx, businessId, row.clientId);
  });
  return getOrThrow(executor, businessId, appointmentId);
}

/** Caché de visitas del cliente con valores ABSOLUTOS desde sus citas completadas. */
async function refreshVisits(tx: Tx, businessId: string, clientId: string): Promise<void> {
  const [stats] = await tx
    .select({ visits: count(), first: min(appointments.startsAt), last: max(appointments.startsAt) })
    .from(appointments)
    .where(and(eq(appointments.businessId, businessId), eq(appointments.clientId, clientId), eq(appointments.status, "completed")));
  const toDate = (v: unknown): Date | null => (v === null || v === undefined ? null : v instanceof Date ? v : new Date(String(v)));
  await refreshClientStats(tx, businessId, clientId, {
    visitCount: Number(stats?.visits ?? 0),
    firstVisitAt: toDate(stats?.first),
    lastVisitAt: toDate(stats?.last),
  });
}

function assertStarted(row: Appointment, now: Date, t: Terminology, what: string): void {
  if (row.startsAt.getTime() > now.getTime()) {
    throw new HttpError(409, `La ${t.appointment} todavía no empezó: no se puede marcar como ${what}.`, "too_early");
  }
}

export function confirmAppointment(executor: Executor, businessId: string, appointmentId: string, options: { now?: Date } = {}) {
  return transition(executor, businessId, appointmentId, "confirmed", "confirmar", async () => ({ confirmedAt: options.now ?? new Date() }));
}

export function completeAppointment(executor: Executor, businessId: string, appointmentId: string, options: { now?: Date } = {}) {
  return transition(executor, businessId, appointmentId, "completed", "completar", async (_tx, row, t) => {
    assertStarted(row, options.now ?? new Date(), t, "completada");
    return {};
  });
}

export function markNoShow(executor: Executor, businessId: string, appointmentId: string, options: { now?: Date } = {}) {
  return transition(executor, businessId, appointmentId, "no_show", "marcar como no asistió", async (_tx, row, t) => {
    assertStarted(row, options.now ?? new Date(), t, "no asistió");
    return {};
  });
}

export function cancelAppointment(
  executor: Executor,
  businessId: string,
  appointmentId: string,
  reason: string | null,
  options: { now?: Date } = {},
) {
  return transition(executor, businessId, appointmentId, "cancelled", "cancelar", async () => ({
    cancelledAt: options.now ?? new Date(),
    cancellationReason: reason?.trim().slice(0, 500) || null,
  }));
}

/** Notas de la cita (en cualquier estado: también sirven para lo que se hizo). */
export async function updateAppointmentNotes(
  executor: Executor,
  businessId: string,
  appointmentId: string,
  notes: string | null,
): Promise<AppointmentView> {
  const t = await terminology(executor, businessId);
  if (!isTenantId(appointmentId)) throw notFound(t);
  const rows = await withTenant(executor, businessId, (tx) =>
    tx
      .update(appointments)
      .set({ notes: notes?.trim() || null })
      .where(and(eq(appointments.businessId, businessId), eq(appointments.id, appointmentId)))
      .returning({ id: appointments.id }),
  );
  if (rows.length === 0) throw notFound(t);
  return getOrThrow(executor, businessId, appointmentId);
}
