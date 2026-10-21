import { and, eq, gt, inArray, lt, ne, type SQL } from "drizzle-orm";
import { withTenant, type Executor } from "../../platform/db/scope";
import { ValidationError } from "../../platform/http/errors";
import { getLocation, minutesOfDay, type LocationView, type WeeklyBlock } from "../business";
import { getServices, listBookableStaff, type ServiceView } from "../catalog";
import { getStaffWeeklyHours, listTimeOff, type StaffWeeklyBlock, type TimeOffEntry } from "../team";
import { ACTIVE_APPOINTMENT_STATUSES, appointments } from "./schema";
import { DAY_MS, isKnownTimeZone, localDatesBetween, MINUTE_MS, weekdayOf, zonedInstant } from "./time";

// ─────────────────────────────────────────────────────────────────────────────
// Disponibilidad (PLAN-GESTION.md §2: UN solo cálculo para el panel y el agente).
//
// Un profesional puede empezar a las T en una sucursal si:
//   1. hace TODOS los servicios pedidos (catalog: `listBookableStaff`, sin filas = todos)
//      y los servicios están activos y se ofrecen en esa sucursal;
//   2. el TRABAJO [T, T + trabajo) cae entero dentro de una ventana abierta: horario de la
//      sucursal (con sus descansos) ∩ horario del profesional EN ESA sucursal, ese día;
//   3. ninguna ausencia que lo afecte (del negocio, de la sucursal o suya) pisa el trabajo;
//   4. lo que lo OCUPA [T, T + trabajo + buffer final) no pisa otra cita viva suya (en
//      cualquier sucursal: no puede estar en dos lugares);
//   5. T respeta el margen mínimo de reserva (`BOOKING_MIN_LEAD_MIN`, default 30 min).
//
// Varios servicios = uno detrás del otro con el mismo profesional (v1): trabajo =
// Σ duración efectiva + los buffers ENTRE servicios; el buffer del último (limpieza o
// preparación después) ocupa al profesional y entra en `ends_at` (lo que compara el
// EXCLUDE de la base) pero puede pasarse del cierre: la última cita del día no pierde su
// lugar por la limpieza.
//
// Los horarios de inicio salen de una grilla anclada a la medianoche local (cada 15 min
// por default), todo en la zona horaria de la sucursal: un día local puede durar 23 o 25 h
// con horario de verano y la conversión lo respeta.
//
// La parte pesada es pura (`computeSlots`, `checkStart`): se prueba sin base y la usan
// igual la búsqueda de horarios y el re-chequeo de la reserva dentro de su transacción.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Intervalo de la grilla de horarios, en minutos.
 * TODO: guardarlo por negocio cuando el esquema tenga dónde (hoy `businesses` no tiene
 * una columna para reglas de reserva); mientras, el mismo para todos.
 */
export const DEFAULT_SLOT_INTERVAL_MIN = 15;

/** Tope de servicios en una cita. */
export const MAX_SERVICES_PER_APPOINTMENT = 10;

/** Rango máximo de una búsqueda de horarios. */
export const MAX_AVAILABILITY_RANGE_DAYS = 31;

/**
 * Margen mínimo entre "ahora" y el primer horario que se le ofrece a un cliente (nadie
 * agenda para dentro de 5 minutos: tiene que llegar). `BOOKING_MIN_LEAD_MIN`, default 30.
 */
export function bookingMinLeadMin(): number {
  const raw = process.env.BOOKING_MIN_LEAD_MIN;
  const n = Number(raw);
  return raw !== undefined && raw.trim() !== "" && Number.isInteger(n) && n >= 0 ? n : 30;
}

/** Condiciones de UN servicio para un profesional (overrides aplicados). */
export interface ServiceTerms {
  serviceId: string;
  name: string;
  durationMin: number;
  bufferMin: number;
  priceCents: number;
  variablePrice: boolean;
}

/** Profesional que hace todos los servicios pedidos, con lo que le toma y cuesta. */
export interface StaffCandidate {
  id: string;
  name: string;
  color: string | null;
  position: number;
  /** Una por servicio, en el orden pedido. */
  terms: ServiceTerms[];
  /** Trabajo: Σ duración + buffers entre servicios (lo que tiene que caer en horario). */
  workMin: number;
  /** Buffer del último servicio (ocupa al profesional después del trabajo). */
  trailingBufferMin: number;
  totalCents: number;
}

/** Intervalo ocupado por una cita viva de un profesional. */
export interface BusyInterval {
  appointmentId: string;
  staffId: string;
  startsAt: Date;
  endsAt: Date;
}

/** Todo lo que hace falta para calcular horarios (lo junta `loadAvailabilityInputs`). */
export interface AvailabilityInputs {
  location: Pick<LocationView, "id" | "name" | "timezone" | "active"> & { hours: readonly WeeklyBlock[] };
  services: ServiceView[];
  candidates: StaffCandidate[];
  staffHours: readonly StaffWeeklyBlock[];
  timeOff: readonly TimeOffEntry[];
  busy: readonly BusyInterval[];
  /** Rango de horarios de INICIO buscado, [from, to). */
  from: Date;
  to: Date;
}

/** Profesional que puede tomar un horario. */
export interface SlotStaff {
  id: string;
  name: string;
  color: string | null;
  /** Fin de la cita con este profesional (incluye el buffer final). */
  endsAt: Date;
  /** Trabajo en minutos (sin el buffer final). */
  durationMin: number;
  totalCents: number;
}

/** Horario libre y quiénes lo pueden tomar (en el orden de la agenda). */
export interface Slot {
  startsAt: Date;
  staff: SlotStaff[];
}

export interface SlotOptions {
  /** Reloj (tests). Default: ahora. */
  now?: Date;
  /** Margen mínimo en minutos. Default `bookingMinLeadMin()`. */
  minLeadMin?: number;
  /** Grilla en minutos. Default `DEFAULT_SLOT_INTERVAL_MIN`. */
  intervalMin?: number;
}

/** Por qué un profesional no puede empezar a esa hora (null = puede). */
export type StartProblem = "staff_unavailable" | "outside_hours" | "time_off" | "busy" | "too_soon";

// ── Armado de candidatos (puro) ─────────────────────────────────────────────

/** Trabajo, buffer final y total de una lista de servicios en orden. */
export function summarizeTerms(terms: readonly Pick<ServiceTerms, "durationMin" | "bufferMin" | "priceCents">[]): {
  workMin: number;
  trailingBufferMin: number;
  totalCents: number;
} {
  let workMin = 0;
  terms.forEach((t, i) => {
    workMin += t.durationMin + (i < terms.length - 1 ? t.bufferMin : 0);
  });
  return {
    workMin,
    trailingBufferMin: terms.length > 0 ? terms[terms.length - 1].bufferMin : 0,
    totalCents: terms.reduce((n, t) => n + t.priceCents, 0),
  };
}

// ── Cálculo (puro) ──────────────────────────────────────────────────────────

interface Window {
  start: number;
  end: number;
}

/** Ventanas abiertas (minutos del día) = tramos de la sucursal ∩ tramos del profesional. */
function intersectBlocks(a: readonly WeeklyBlock[], b: readonly WeeklyBlock[]): Window[] {
  const out: Window[] = [];
  for (const x of a) {
    for (const y of b) {
      const start = Math.max(minutesOfDay(x.start), minutesOfDay(y.start));
      const end = Math.min(minutesOfDay(x.end), minutesOfDay(y.end));
      if (end > start) out.push({ start, end });
    }
  }
  return out.sort((p, q) => p.start - q.start);
}

/** ¿La ausencia afecta a este profesional en esta sucursal? (`listTimeOff` ya filtró la sucursal). */
function affects(entry: TimeOffEntry, staffId: string, locationId: string): boolean {
  if (entry.staffId && entry.staffId !== staffId) return false;
  return !entry.locationId || entry.locationId === locationId;
}

const overlaps = (aStart: number, aEnd: number, bStart: number, bEnd: number) => aStart < bEnd && bStart < aEnd;

/** Ventanas abiertas, como instantes, de un profesional un día local. */
function openWindows(inputs: AvailabilityInputs, staffId: string, date: string): Array<{ start: number; end: number }> {
  const weekday = weekdayOf(date);
  const tz = inputs.location.timezone;
  const loc = inputs.location.hours.filter((h) => h.weekday === weekday);
  const own = inputs.staffHours.filter((h) => h.staffId === staffId && h.weekday === weekday);
  return intersectBlocks(loc, own).map((w) => ({
    start: zonedInstant(date, w.start, tz).getTime(),
    end: zonedInstant(date, w.end, tz).getTime(),
  }));
}

interface CheckOptions {
  /** Saltea el horario y las ausencias (cita cargada a mano fuera de horario). */
  ignoreHours?: boolean;
  /** Saltea el chequeo contra otras citas (la reserva deja que lo haga el EXCLUDE de la base). */
  ignoreBusy?: boolean;
  /** Instante mínimo de inicio (ahora + margen); null = sin mínimo. */
  earliest: number | null;
}

function problemFor(
  inputs: AvailabilityInputs,
  candidate: StaffCandidate,
  start: number,
  windows: Array<{ start: number; end: number }>,
  options: CheckOptions,
): StartProblem | null {
  if (options.earliest !== null && start < options.earliest) return "too_soon";
  const workEnd = start + candidate.workMin * MINUTE_MS;
  const occupiedEnd = workEnd + candidate.trailingBufferMin * MINUTE_MS;
  if (!options.ignoreHours) {
    if (!windows.some((w) => w.start <= start && workEnd <= w.end)) return "outside_hours";
    const away = inputs.timeOff.some(
      (t) => affects(t, candidate.id, inputs.location.id) && overlaps(start, workEnd, t.startsAt.getTime(), t.endsAt.getTime()),
    );
    if (away) return "time_off";
  }
  if (!options.ignoreBusy) {
    const taken = inputs.busy.some(
      (b) => b.staffId === candidate.id && overlaps(start, occupiedEnd, b.startsAt.getTime(), b.endsAt.getTime()),
    );
    if (taken) return "busy";
  }
  return null;
}

function slotStaff(candidate: StaffCandidate, start: number): SlotStaff {
  return {
    id: candidate.id,
    name: candidate.name,
    color: candidate.color,
    endsAt: new Date(start + (candidate.workMin + candidate.trailingBufferMin) * MINUTE_MS),
    durationMin: candidate.workMin,
    totalCents: candidate.totalCents,
  };
}

/**
 * Horarios libres en [from, to) con los profesionales que pueden tomar cada uno. Pura: los
 * datos los trae `loadAvailabilityInputs`.
 */
export function computeSlots(inputs: AvailabilityInputs, options: SlotOptions = {}): Slot[] {
  const tz = inputs.location.timezone;
  if (!inputs.location.active || inputs.candidates.length === 0) return [];
  const now = (options.now ?? new Date()).getTime();
  const earliest = now + (options.minLeadMin ?? bookingMinLeadMin()) * MINUTE_MS;
  const interval = Math.max(5, Math.floor(options.intervalMin ?? DEFAULT_SLOT_INTERVAL_MIN));
  const from = inputs.from.getTime();
  const to = inputs.to.getTime();

  const slots: Slot[] = [];
  for (const date of localDatesBetween(inputs.from, inputs.to, tz)) {
    const windows = new Map(inputs.candidates.map((c) => [c.id, openWindows(inputs, c.id, date)]));
    if ([...windows.values()].every((w) => w.length === 0)) continue;
    let previous = Number.NEGATIVE_INFINITY;
    for (let minute = 0; minute < 24 * 60; minute += interval) {
      const start = zonedInstant(date, minute, tz).getTime();
      // Con el atraso de hora del otoño, dos minutos locales pueden dar el mismo instante.
      if (start <= previous) continue;
      previous = start;
      if (start < from || start >= to || start < earliest) continue;
      const staff = inputs.candidates
        .filter((c) => problemFor(inputs, c, start, windows.get(c.id) ?? [], { earliest: null }) === null)
        .map((c) => slotStaff(c, start));
      if (staff.length > 0) slots.push({ startsAt: new Date(start), staff });
    }
  }
  return slots;
}

/**
 * ¿Puede `staffId` empezar en `startsAt`? Mismas reglas que `computeSlots`, sin grilla.
 * La usa la reserva (dentro de su transacción) y la reprogramación.
 */
export function checkStart(
  inputs: AvailabilityInputs,
  staffId: string,
  startsAt: Date,
  options: { now?: Date; minLeadMin?: number; ignoreHours?: boolean; ignoreBusy?: boolean; allowPast?: boolean } = {},
): StartProblem | null {
  const candidate = inputs.candidates.find((c) => c.id === staffId);
  if (!candidate) return "staff_unavailable";
  const start = startsAt.getTime();
  const now = (options.now ?? new Date()).getTime();
  const earliest = options.allowPast ? null : now + (options.minLeadMin ?? bookingMinLeadMin()) * MINUTE_MS;
  // El trabajo puede cruzar la medianoche solo si el horario lo permite ("24:00"): se miran
  // las ventanas del día local del inicio y del anterior.
  const tz = inputs.location.timezone;
  const days = localDatesBetween(new Date(start - DAY_MS), new Date(start + 1), tz);
  const windows = days.flatMap((date) => openWindows(inputs, staffId, date));
  return problemFor(inputs, candidate, start, windows, { earliest, ignoreHours: options.ignoreHours, ignoreBusy: options.ignoreBusy });
}

// ── Carga de datos (API pública de los otros módulos, nunca sus tablas) ─────

export interface LoadAvailabilityInput {
  locationId: string;
  serviceIds: readonly string[];
  /** Un profesional, o "any"/ausente = cualquiera que pueda. */
  staffId?: string | "any" | null;
  from: Date;
  to: Date;
  /** Cita que no cuenta como ocupada (la que se está reprogramando). */
  excludeAppointmentId?: string;
  /** Solo servicios que el agente o la reserva web pueden agendar. */
  onlineOnly?: boolean;
}

const servicesError = (message: string) => new ValidationError({ serviceIds: message });

/** Valida la lista de servicios: 1 a 10, sin repetir. Devuelve los ids en minúsculas. */
export function normalizeServiceIds(serviceIds: readonly string[]): string[] {
  const ids = serviceIds.map((id) => id.toLowerCase());
  if (ids.length === 0) throw servicesError("Elegí al menos un servicio.");
  if (ids.length > MAX_SERVICES_PER_APPOINTMENT) throw servicesError(`Máximo ${MAX_SERVICES_PER_APPOINTMENT} servicios por cita.`);
  if (new Set(ids).size !== ids.length) throw servicesError("Cada servicio va una sola vez.");
  return ids;
}

/** Citas vivas de esos profesionales que se cruzan con [from, to). */
export async function loadBusy(
  executor: Executor,
  businessId: string,
  staffIds: readonly string[],
  from: Date,
  to: Date,
  excludeAppointmentId?: string,
): Promise<BusyInterval[]> {
  if (staffIds.length === 0) return [];
  const conditions: SQL[] = [
    eq(appointments.businessId, businessId),
    inArray(appointments.staffId, [...staffIds]),
    inArray(appointments.status, [...ACTIVE_APPOINTMENT_STATUSES]),
    lt(appointments.startsAt, to),
    gt(appointments.endsAt, from),
  ];
  if (excludeAppointmentId) conditions.push(ne(appointments.id, excludeAppointmentId));
  const rows = await withTenant(executor, businessId, (tx) =>
    tx
      .select({ appointmentId: appointments.id, staffId: appointments.staffId, startsAt: appointments.startsAt, endsAt: appointments.endsAt })
      .from(appointments)
      .where(and(...conditions)),
  );
  return rows;
}

/** Sucursal para el cálculo (del caché del contexto). 400 si no existe. */
export async function locationForSchedule(executor: Executor, businessId: string, locationId: string): Promise<AvailabilityInputs["location"]> {
  const location = await getLocation(executor, businessId, locationId);
  if (!location) throw new ValidationError({ locationId: "Esa sucursal no existe." });
  if (!isKnownTimeZone(location.timezone)) throw new Error(`scheduling: la sucursal ${location.id} tiene una zona horaria inválida`);
  return { id: location.id, name: location.name, timezone: location.timezone, active: location.active, hours: location.hours };
}

/**
 * Profesionales ACTIVOS con horario en la sucursal que hacen todos los servicios pedidos,
 * con sus condiciones (catalog). 400 por campo si algún servicio no sirve.
 */
export async function loadCandidates(
  executor: Executor,
  businessId: string,
  input: { locationId: string; serviceIds: readonly string[]; staffId?: string | "any" | null; onlineOnly?: boolean },
): Promise<{ services: ServiceView[]; candidates: StaffCandidate[] }> {
  const serviceIds = normalizeServiceIds(input.serviceIds);
  const offered = await getServices(executor, businessId, { activeOnly: true, locationId: input.locationId, onlineOnly: input.onlineOnly });
  const byId = new Map(offered.map((s) => [s.id, s]));
  const services = serviceIds.map((id) => byId.get(id));
  if (services.some((s) => !s)) {
    throw servicesError(
      input.onlineOnly
        ? "Alguno de los servicios no existe, no se ofrece en esta sucursal o no se puede agendar en línea."
        : "Alguno de los servicios no existe, está desactivado o no se ofrece en esta sucursal.",
    );
  }
  const chosen = services as ServiceView[];

  // Quién hace cada servicio (con sus condiciones); se queda quien hace todos. En serie: el
  // executor puede ser una transacción (una sola conexión).
  const perService = [];
  for (const s of chosen) perService.push(await listBookableStaff(executor, businessId, { locationId: input.locationId, serviceId: s.id }));
  const wanted = input.staffId && input.staffId !== "any" ? input.staffId.toLowerCase() : null;
  const candidates: StaffCandidate[] = [];
  for (const staff of perService[0] ?? []) {
    if (wanted && staff.id !== wanted) continue;
    const terms: ServiceTerms[] = [];
    for (let i = 0; i < chosen.length; i++) {
      const match = perService[i].find((s) => s.id === staff.id)?.service;
      if (!match) break;
      terms.push({
        serviceId: chosen[i].id,
        name: chosen[i].name,
        durationMin: match.durationMin,
        bufferMin: match.bufferMin,
        priceCents: match.priceCents,
        variablePrice: match.variablePrice,
      });
    }
    if (terms.length !== chosen.length) continue;
    candidates.push({ id: staff.id, name: staff.name, color: staff.color, position: staff.position, terms, ...summarizeTerms(terms) });
  }
  return { services: chosen, candidates };
}

/**
 * Horarios de esos profesionales en la sucursal, ausencias que los afectan y sus citas
 * vivas alrededor de [from, to) (lo que pasa después de `to` también importa: una cita que
 * empieza al final del rango puede terminar al día siguiente).
 */
export async function loadScheduleContext(
  executor: Executor,
  businessId: string,
  input: { locationId: string; staffIds: readonly string[]; from: Date; to: Date; excludeAppointmentId?: string },
): Promise<Pick<AvailabilityInputs, "staffHours" | "timeOff" | "busy">> {
  const ids = [...input.staffIds];
  if (ids.length === 0) return { staffHours: [], timeOff: [], busy: [] };
  const since = new Date(input.from.getTime() - DAY_MS);
  const until = new Date(input.to.getTime() + DAY_MS);
  const staffHours = (await getStaffWeeklyHours(executor, businessId, { locationId: input.locationId })).filter((h) => ids.includes(h.staffId));
  const timeOff = await listTimeOff(executor, businessId, { from: since, to: until, locationId: input.locationId });
  const busy = await loadBusy(executor, businessId, ids, since, until, input.excludeAppointmentId);
  return { staffHours, timeOff, busy };
}

/**
 * Junta lo que necesita el cálculo: sucursal y su horario (business), servicios y quién
 * los hace con qué duración y precio (catalog), horarios y ausencias (team) y las citas
 * vivas de esas personas (de acá). Lanza 400 por campo si la sucursal o algún servicio no
 * sirven. Una sucursal desactivada o sin nadie que pueda devuelve candidatos vacíos.
 */
export async function loadAvailabilityInputs(
  executor: Executor,
  businessId: string,
  input: LoadAvailabilityInput,
): Promise<AvailabilityInputs> {
  normalizeServiceIds(input.serviceIds);
  const location = await locationForSchedule(executor, businessId, input.locationId);
  const { services, candidates } = await loadCandidates(executor, businessId, { ...input, locationId: location.id });
  const context = await loadScheduleContext(executor, businessId, {
    locationId: location.id,
    staffIds: candidates.map((c) => c.id),
    from: input.from,
    to: input.to,
    excludeAppointmentId: input.excludeAppointmentId,
  });
  return { location, services, candidates, ...context, from: input.from, to: input.to };
}

export interface FindSlotsInput extends LoadAvailabilityInput, SlotOptions {}

/**
 * Horarios libres para reservar `serviceIds` en la sucursal, con quién puede tomar cada
 * uno (API pública: Agenda y agente de WhatsApp). `staffId` = uno en particular, o "any"
 * (o ausente) = cualquiera. [from, to) es el rango de horarios de INICIO (máx. 31 días).
 */
export async function findSlots(executor: Executor, businessId: string, input: FindSlotsInput): Promise<Slot[]> {
  const range = input.to.getTime() - input.from.getTime();
  if (!(range > 0)) throw new ValidationError({ to: "El fin del rango tiene que ser después del inicio." });
  if (range > MAX_AVAILABILITY_RANGE_DAYS * DAY_MS) {
    throw new ValidationError({ to: `Se pueden buscar horarios de a lo sumo ${MAX_AVAILABILITY_RANGE_DAYS} días.` });
  }
  const inputs = await loadAvailabilityInputs(executor, businessId, input);
  return computeSlots(inputs, input);
}
