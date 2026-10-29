import type { TransportRequest, TransportResponse } from "../../lib/api";
import type { Role } from "../../lib/contract";
import { readStorage, writeStorage } from "../../lib/storage";
import type { MockAgendaSetup } from "../settings/settingsMock";
import type { StaffView } from "../settings/settingsApi";
import { isoToZoned, zonedToIso } from "../settings/zonedTime";
import { addDays, hhmm, weekdayOf, workingWindows } from "./agendaLayout";
import type { Appointment, AppointmentChannel, AppointmentLine, AppointmentStatus, HomeToday, Slot } from "./schedulingApi";

// ─────────────────────────────────────────────────────────────────────────────
// Agenda e Inicio en la API simulada (VITE_MOCK_API=1): mismas rutas, sobre, códigos y
// reglas que src/modules/scheduling (disponibilidad con horarios, ausencias, buffers y
// overrides por profesional; reserva con 409 slot_taken; transiciones; permisos por rol y
// sucursal; historial de la ficha; /home/today). Los horarios, el equipo y el catálogo
// salen de la Configuración simulada y los clientes de la de Clientes. El estado vive en
// sessionStorage; las citas de ejemplo se siembran alrededor de HOY.
//
// Simplificaciones: sin margen mínimo (es el del panel), la rejilla de minutos ignora el
// cambio de horario de verano y no hay recordatorios.
// ─────────────────────────────────────────────────────────────────────────────

export interface MockSchedulingSession {
  businessId: string;
  userId: string;
  role: Role;
  /** Sin valor = todas las sucursales. */
  locationIds?: string[];
  /** Profesional vinculado al usuario (rol staff). */
  staffId: string | null;
  setup: MockAgendaSetup;
  clients: Array<{ id: string; name: string; phone: string | null; email: string | null; anonymized: boolean }>;
}

type Stored = Omit<Appointment, "client" | "staff" | "location">;

interface State {
  seq: number;
  businesses: Record<string, Stored[]>;
}

const STATE_KEY = "selyon.mock.scheduling";
const SLOT_STEP_MIN = 15;
const DAY_MS = 86_400_000;
const ACTIVE: AppointmentStatus[] = ["pending", "confirmed"];
const TRANSITIONS: Record<AppointmentStatus, AppointmentStatus[]> = {
  pending: ["confirmed", "completed", "cancelled", "no_show"],
  confirmed: ["completed", "cancelled", "no_show"],
  completed: [],
  cancelled: [],
  no_show: [],
};

function loadState(): State {
  try {
    const raw = readStorage(STATE_KEY, "session");
    if (raw) return JSON.parse(raw) as State;
  } catch {
    // estado roto: se arranca de cero
  }
  return { seq: 0, businesses: {} };
}

function saveState(state: State): void {
  writeStorage(STATE_KEY, JSON.stringify(state), "session");
}

function nextId(state: State, prefix = "a"): string {
  state.seq += 1;
  const hex = prefix === "l" ? "b" : "a";
  return `${hex}0000000-0000-4000-8000-${String(state.seq).padStart(12, "0")}`;
}

// ── Respuestas ──────────────────────────────────────────────────────────────

const ok = (data: unknown, status = 200): TransportResponse => ({ status, payload: { ok: true, data } });
const fail = (status: number, code: string, error: string, fields?: Record<string, string>): TransportResponse => ({
  status,
  payload: { ok: false, error, code, ...(fields ? { fields } : {}) },
});
const invalid = (fields: Record<string, string>) => fail(400, "validation_error", "Datos inválidos: revisá los campos marcados.", fields);
const notFound = () => fail(404, "not_found", "No encontramos esa cita.");
const slotTaken = () => fail(409, "slot_taken", "Ese horario ya no está disponible. Elegí otro.");
const ownOnly = () => fail(403, "own_appointments_only", "Solo podés ver y operar tus propias citas.");
const locationForbidden = () => fail(403, "location_forbidden", "No tenés acceso a esta sucursal.");

type Body = Record<string, unknown>;
const asBody = (body: unknown): Body => (typeof body === "object" && body !== null ? (body as Body) : {});
const text = (b: Body, key: string) => (typeof b[key] === "string" ? (b[key] as string).trim() : "");

// ── Reglas ──────────────────────────────────────────────────────────────────

interface Candidate {
  staff: StaffView;
  lines: Omit<AppointmentLine, "id">[];
  workMin: number;
  trailingMin: number;
  totalCents: number;
}

/** Condiciones de los servicios para un profesional (overrides; sin filas = hace todos). null = no los hace. */
function candidateFor(setup: MockAgendaSetup, staff: StaffView, serviceIds: string[]): Candidate | null {
  const own = setup.staffServices[staff.id] ?? [];
  const lines: Omit<AppointmentLine, "id">[] = [];
  let workMin = 0;
  let trailingMin = 0;
  for (const [position, id] of serviceIds.entries()) {
    const service = setup.services.find((s) => s.id === id);
    if (!service) return null;
    const override = own.find((o) => o.serviceId === id);
    if (own.length > 0 && !override) return null;
    const durationMin = override?.durationMin ?? service.durationMin;
    lines.push({ serviceId: id, name: service.name, durationMin, priceCents: override?.priceCents ?? service.priceCents, position });
    const last = position === serviceIds.length - 1;
    workMin += durationMin + (last ? 0 : service.bufferMin);
    if (last) trailingMin = service.bufferMin;
  }
  return { staff, lines, workMin, trailingMin, totalCents: lines.reduce((n, l) => n + l.priceCents, 0) };
}

function offeredServices(setup: MockAgendaSetup, locationId: string) {
  return setup.services.filter((s) => s.active && (s.locationIds.length === 0 || s.locationIds.includes(locationId)));
}

function candidates(setup: MockAgendaSetup, locationId: string, serviceIds: string[], staffId?: string | null): Candidate[] {
  return setup.staff
    .filter((s) => s.active && s.hours.some((h) => h.locationId === locationId) && (!staffId || staffId === "any" || s.id === staffId))
    .flatMap((s) => {
      const c = candidateFor(setup, s, serviceIds);
      return c ? [c] : [];
    });
}

type Problem = "outside_hours" | "time_off" | "busy" | "too_soon";

function problemFor(
  session: MockSchedulingSession,
  list: Stored[],
  c: Candidate,
  locationId: string,
  startsAt: string,
  options: { excludeId?: string; ignoreHours?: boolean; allowPast?: boolean } = {},
): Problem | null {
  const location = session.setup.locations.find((l) => l.id === locationId);
  if (!location) return "outside_hours";
  const tz = location.timezone;
  const start = Date.parse(startsAt);
  if (!options.allowPast && start < Date.now()) return "too_soon";
  const workEnd = start + c.workMin * 60_000;
  const occupiedEnd = workEnd + c.trailingMin * 60_000;
  if (!options.ignoreHours) {
    const local = isoToZoned(startsAt, tz);
    const minute = Number(local.time.slice(0, 2)) * 60 + Number(local.time.slice(3, 5));
    const windows = workingWindows(location.hours, c.staff.hours.filter((h) => h.locationId === locationId), weekdayOf(local.date));
    if (!windows.some((w) => w.startMin <= minute && minute + c.workMin <= w.endMin)) return "outside_hours";
    const away = session.setup.timeOff.some(
      (t) =>
        (!t.staffId || t.staffId === c.staff.id) &&
        (!t.locationId || t.locationId === locationId) &&
        start < Date.parse(t.endsAt) &&
        Date.parse(t.startsAt) < workEnd,
    );
    if (away) return "time_off";
  }
  const taken = list.some(
    (a) => a.id !== options.excludeId && a.staffId === c.staff.id && ACTIVE.includes(a.status) && start < Date.parse(a.endsAt) && Date.parse(a.startsAt) < occupiedEnd,
  );
  return taken ? "busy" : null;
}

function problemResponse(problem: Problem): TransportResponse {
  switch (problem) {
    case "busy":
      return slotTaken();
    case "outside_hours":
      return invalid({ startsAt: "A esa hora no hay atención (horario de la sucursal o del profesional)." });
    case "time_off":
      return invalid({ startsAt: "Ese horario cae en una ausencia o un cierre." });
    case "too_soon":
      return invalid({ startsAt: "Ese horario ya pasó o es demasiado pronto para reservarlo." });
  }
}

function slotsFor(session: MockSchedulingSession, list: Stored[], locationId: string, date: string, cands: Candidate[], excludeId?: string): Slot[] {
  const tz = session.setup.locations.find((l) => l.id === locationId)?.timezone ?? session.setup.timezone;
  const out: Slot[] = [];
  for (let m = 0; m < 24 * 60; m += SLOT_STEP_MIN) {
    const startsAt = zonedToIso(date, hhmm(m), tz);
    const staff = cands
      .filter((c) => problemFor(session, list, c, locationId, startsAt, { excludeId }) === null)
      .map((c) => ({
        id: c.staff.id,
        name: c.staff.name,
        color: c.staff.color,
        endsAt: new Date(Date.parse(startsAt) + (c.workMin + c.trailingMin) * 60_000).toISOString(),
        durationMin: c.workMin,
        totalCents: c.totalCents,
      }));
    if (staff.length > 0) out.push({ startsAt, staff });
  }
  return out;
}

// ── Vistas y siembra ────────────────────────────────────────────────────────

function view(session: MockSchedulingSession, a: Stored): Appointment {
  const client = session.clients.find((c) => c.id === a.clientId);
  const staff = session.setup.staff.find((s) => s.id === a.staffId);
  const location = session.setup.locations.find((l) => l.id === a.locationId);
  return {
    ...a,
    client: client ? { id: client.id, name: client.anonymized ? "Cliente eliminado" : client.name, phone: client.phone, email: client.email } : null,
    staff: staff ? { id: staff.id, name: staff.name, color: staff.color } : null,
    location: location ? { id: location.id, name: location.name, timezone: location.timezone } : null,
  };
}

/** Citas de ejemplo alrededor de hoy: dos por día y profesional, con estados según la hora. */
function seed(state: State, session: MockSchedulingSession): Stored[] {
  const { setup } = session;
  const clients = session.clients.filter((c) => !c.anonymized).slice(0, 24);
  const services = setup.services.filter((s) => s.active);
  if (clients.length === 0 || services.length === 0) return [];
  const now = Date.now();
  const today = isoToZoned(new Date(now).toISOString(), setup.timezone).date;
  const out: Stored[] = [];
  setup.staff
    .filter((s) => s.active)
    .forEach((staff, si) => {
      for (let d = -3; d <= 6; d++) {
        const date = addDays(today, d);
        for (const location of setup.locations.filter((l) => l.active)) {
          const windows = workingWindows(location.hours, staff.hours.filter((h) => h.locationId === location.id), weekdayOf(date));
          if (windows.length === 0) continue;
          const picks = [windows[0].startMin + 60 * ((si + d + 3) % 2), windows[windows.length - 1].endMin - 120];
          picks.forEach((startMin, k) => {
            const service = services[(si + k + d + 3) % services.length];
            const c = candidateFor(setup, staff, [service.id]);
            if (!c) return;
            const startsAt = zonedToIso(date, hhmm(startMin), location.timezone);
            const endsAt = new Date(Date.parse(startsAt) + (c.workMin + c.trailingMin) * 60_000).toISOString();
            const past = Date.parse(endsAt) <= now;
            const status: AppointmentStatus = past ? (d === 0 && k === 0 ? "no_show" : "completed") : d === 0 || k === 0 ? "confirmed" : "pending";
            const channel: AppointmentChannel = (["whatsapp_ai", "panel", "phone"] as const)[(si + k + d + 3) % 3];
            const createdAt =
              channel === "whatsapp_ai" && d >= 0 ? new Date(now - 3 * 3600_000).toISOString() : new Date(Date.parse(startsAt) - 3 * DAY_MS).toISOString();
            const id = nextId(state);
            out.push({
              id,
              locationId: location.id,
              clientId: clients[(si * 7 + k + (d + 3) * 2) % clients.length].id,
              staffId: staff.id,
              startsAt,
              endsAt,
              status,
              channel,
              totalCents: c.totalCents,
              notes: null,
              createdBy: null,
              confirmedAt: status === "pending" ? null : createdAt,
              cancelledAt: null,
              cancellationReason: null,
              createdAt,
              updatedAt: createdAt,
              services: c.lines.map((l) => ({ ...l, id: nextId(state, "l") })),
            });
          });
        }
      }
    });
  return out;
}

/** Citas del negocio (todas las sucursales) para otros mocks (Ventas); las siembra si hace falta. */
export function mockAppointmentsOf(session: MockSchedulingSession): Appointment[] {
  const state = loadState();
  if (!state.businesses[session.businessId]) {
    state.businesses[session.businessId] = seed(state, session);
    saveState(state);
  }
  return state.businesses[session.businessId].map((a) => view(session, a));
}

// ── Rutas ───────────────────────────────────────────────────────────────────

/** Rutas de la Agenda y del Inicio del mock; null si la ruta no es suya. */
export function routeSchedulingMock(req: TransportRequest, session: MockSchedulingSession): TransportResponse | null {
  const url = new URL(req.path, "http://mock");
  const path = url.pathname;
  const historyMatch = /^\/clients\/([^/]+)\/appointments$/.exec(path);
  const mine = path === "/availability" || path === "/appointments" || path.startsWith("/appointments/") || path === "/home/today" || historyMatch;
  if (!mine) return null;

  const state = loadState();
  const list = (state.businesses[session.businessId] ??= seed(state, session));
  const save = () => saveState(state);
  const body = asBody(req.body);
  const header = req.headers["X-Location-Id"] ?? null;
  const canSee = (locationId: string) => !session.locationIds || session.locationIds.includes(locationId);
  const isStaff = session.role === "staff";
  const visibleLocations = header ? [header] : (session.locationIds ?? null);
  const inScope = (a: Stored) => (!visibleLocations || visibleLocations.includes(a.locationId)) && (!isStaff || a.staffId === session.staffId);

  // ── Disponibilidad ──
  if (req.method === "GET" && path === "/availability") {
    const locationId = url.searchParams.get("locationId") ?? "";
    const date = url.searchParams.get("date") ?? "";
    const serviceIds = (url.searchParams.get("serviceIds") ?? "").split(",").filter(Boolean);
    let staffId = url.searchParams.get("staffId") ?? "any";
    const fields: Record<string, string> = {};
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) fields["query.date"] = "Fecha inválida (formato AAAA-MM-DD).";
    if (serviceIds.length === 0) fields["query.serviceIds"] = "Elegí al menos un servicio.";
    if (Object.keys(fields).length) return invalid(fields);
    if (!canSee(locationId)) return locationForbidden();
    const location = session.setup.locations.find((l) => l.id === locationId);
    if (!location) return invalid({ "query.locationId": "Esa sucursal no existe." });
    if (isStaff) {
      if (!session.staffId || (staffId !== "any" && staffId !== session.staffId)) return ownOnly();
      staffId = session.staffId;
    }
    const offered = offeredServices(session.setup, locationId).map((s) => s.id);
    if (serviceIds.some((id) => !offered.includes(id))) return invalid({ serviceIds: "Alguno de los servicios no existe, está desactivado o no se ofrece en esta sucursal." });
    const cands = candidates(session.setup, locationId, serviceIds, staffId);
    const slots = location.active ? slotsFor(session, list, locationId, date, cands, url.searchParams.get("excludeAppointmentId") ?? undefined) : [];
    return ok({ date, timezone: location.timezone, locationId, slots });
  }

  // ── Lista ──
  if (req.method === "GET" && path === "/appointments") {
    const from = Date.parse(url.searchParams.get("from") ?? "");
    const to = Date.parse(url.searchParams.get("to") ?? "");
    if (Number.isNaN(from) || Number.isNaN(to) || to <= from) return invalid({ "query.to": "El fin tiene que ser después del inicio." });
    if (header && !canSee(header)) return locationForbidden();
    const staffId = url.searchParams.get("staffId");
    const clientId = url.searchParams.get("clientId");
    if (isStaff && !session.staffId) return ok([]);
    if (isStaff && staffId && staffId !== session.staffId) return ownOnly();
    const items = list
      .filter((a) => inScope(a) && Date.parse(a.startsAt) >= from && Date.parse(a.startsAt) < to)
      .filter((a) => (!staffId || a.staffId === staffId) && (!clientId || a.clientId === clientId))
      .sort((x, y) => x.startsAt.localeCompare(y.startsAt));
    return ok(items.map((a) => view(session, a)));
  }

  // ── Alta ──
  if (req.method === "POST" && path === "/appointments") {
    const locationId = text(body, "locationId");
    const clientId = text(body, "clientId");
    const serviceIds = Array.isArray(body.serviceIds) ? (body.serviceIds as unknown[]).filter((x): x is string => typeof x === "string") : [];
    let staffId = text(body, "staffId") || "any";
    const startsAt = text(body, "startsAt");
    if (!canSee(locationId)) return locationForbidden();
    if (isStaff) {
      if (!session.staffId || (staffId !== "any" && staffId !== session.staffId)) return ownOnly();
      staffId = session.staffId;
    }
    const fields: Record<string, string> = {};
    if (!session.clients.some((c) => c.id === clientId && !c.anonymized)) fields.clientId = "Ese cliente no existe.";
    if (serviceIds.length === 0) fields.serviceIds = "Elegí al menos un servicio.";
    if (Number.isNaN(Date.parse(startsAt))) fields["body.startsAt"] = "Fecha y hora inválidas (ISO 8601 con zona).";
    if (Object.keys(fields).length) return invalid(fields);
    const offered = offeredServices(session.setup, locationId).map((s) => s.id);
    if (serviceIds.some((id) => !offered.includes(id))) return invalid({ serviceIds: "Alguno de los servicios no existe, está desactivado o no se ofrece en esta sucursal." });
    const cands = candidates(session.setup, locationId, serviceIds, staffId);
    if (cands.length === 0) return invalid({ staffId: "Ese profesional no hace alguno de los servicios o no atiende en esta sucursal." });
    const allowOutside = body.allowOutsideHours === true;
    const problems = cands.map((c) => problemFor(session, list, c, locationId, startsAt, { ignoreHours: allowOutside, allowPast: allowOutside }));
    const index = problems.findIndex((p) => p === null);
    if (index < 0) return problemResponse(problems.includes("busy") ? "busy" : (problems[0] as Problem));
    const c = cands[index];
    const now = new Date().toISOString();
    const stored: Stored = {
      id: nextId(state),
      locationId,
      clientId,
      staffId: c.staff.id,
      startsAt: new Date(startsAt).toISOString(),
      endsAt: new Date(Date.parse(startsAt) + (c.workMin + c.trailingMin) * 60_000).toISOString(),
      status: "pending",
      channel: (["panel", "phone", "walk_in"] as string[]).includes(text(body, "channel")) ? (text(body, "channel") as AppointmentChannel) : "panel",
      totalCents: c.totalCents,
      notes: text(body, "notes") || null,
      createdBy: session.userId,
      confirmedAt: null,
      cancelledAt: null,
      cancellationReason: null,
      createdAt: now,
      updatedAt: now,
      services: c.lines.map((l) => ({ ...l, id: nextId(state, "l") })),
    };
    list.push(stored);
    save();
    return ok(view(session, stored), 201);
  }

  // ── Una cita ──
  const match = /^\/appointments\/([^/]+)(?:\/([a-z-]+))?$/.exec(path);
  if (match) {
    const appointment = list.find((a) => a.id === match[1]);
    if (!appointment) return notFound();
    if (!canSee(appointment.locationId)) return locationForbidden();
    if (isStaff && appointment.staffId !== session.staffId) return ownOnly();
    const action = match[2];
    const touch = () => {
      appointment.updatedAt = new Date().toISOString();
      save();
      return ok(view(session, appointment));
    };
    if (req.method === "GET" && !action) return ok(view(session, appointment));
    if (req.method === "PATCH" && !action) {
      appointment.notes = text(body, "notes") || null;
      return touch();
    }
    if (req.method !== "POST" || !action) return fail(405, "method_not_allowed", "Método no permitido.");

    const transition = (to: AppointmentStatus, verb: string, needsStart = false) => {
      if (!TRANSITIONS[appointment.status].includes(to)) return fail(409, "invalid_transition", `No se puede ${verb} esta cita.`);
      if (needsStart && Date.parse(appointment.startsAt) > Date.now()) return fail(409, "too_early", "La cita todavía no empezó.");
      appointment.status = to;
      if (to === "confirmed") appointment.confirmedAt = new Date().toISOString();
      if (to === "cancelled") {
        appointment.cancelledAt = new Date().toISOString();
        appointment.cancellationReason = text(body, "reason") || null;
      }
      return touch();
    };
    switch (action) {
      case "confirm":
        return transition("confirmed", "confirmar");
      case "complete":
        return transition("completed", "completar", true);
      case "no-show":
        return transition("no_show", "marcar como no asistió", true);
      case "cancel":
        return transition("cancelled", "cancelar");
      case "reschedule":
      case "assign": {
        if (!ACTIVE.includes(appointment.status)) return fail(409, "invalid_transition", "No se puede mover esta cita.");
        if (action === "assign" && isStaff) return fail(403, "forbidden_role", "No tenés permiso para esta acción.");
        const staffId = text(body, "staffId") || appointment.staffId;
        if (isStaff && staffId !== appointment.staffId) return ownOnly();
        const startsAt = action === "reschedule" ? text(body, "startsAt") : appointment.startsAt;
        if (Number.isNaN(Date.parse(startsAt))) return invalid({ "body.startsAt": "Fecha y hora inválidas (ISO 8601 con zona)." });
        const staff = session.setup.staff.find((s) => s.id === staffId);
        const serviceIds = appointment.services.map((l) => l.serviceId).filter((x): x is string => Boolean(x));
        const c = staff && (staffId === appointment.staffId || staff.hours.some((h) => h.locationId === appointment.locationId)) ? candidateFor(session.setup, staff, serviceIds) : null;
        if (!c) return invalid({ staffId: "Ese profesional no hace alguno de los servicios o no atiende en esta sucursal." });
        const problem = problemFor(session, list, c, appointment.locationId, startsAt, { excludeId: appointment.id });
        if (problem) return problemResponse(problem);
        appointment.startsAt = new Date(startsAt).toISOString();
        appointment.endsAt = new Date(Date.parse(startsAt) + (c.workMin + c.trailingMin) * 60_000).toISOString();
        if (staffId !== appointment.staffId) {
          appointment.staffId = staffId;
          appointment.totalCents = c.totalCents;
          appointment.services = c.lines.map((l) => ({ ...l, id: nextId(state, "l") }));
        }
        return touch();
      }
    }
    return fail(404, "not_found", "Ruta inexistente en el mock.");
  }

  // ── Historial de la ficha ──
  if (req.method === "GET" && historyMatch) {
    const clientId = decodeURIComponent(historyMatch[1]);
    if (!session.clients.some((c) => c.id === clientId)) return fail(404, "not_found", "No encontramos ese cliente.");
    const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 20) || 20, 1), 100);
    const offset = Number(url.searchParams.get("cursor") ?? 0) || 0;
    if (isStaff && !session.staffId) return ok({ items: [], nextCursor: null });
    const items = list
      .filter((a) => a.clientId === clientId && (!session.locationIds || session.locationIds.includes(a.locationId)) && (!isStaff || a.staffId === session.staffId))
      .sort((x, y) => y.startsAt.localeCompare(x.startsAt));
    const page = items.slice(offset, offset + limit);
    return ok({ items: page.map((a) => view(session, a)), nextCursor: offset + limit < items.length ? String(offset + limit) : null });
  }

  // ── Inicio básico ──
  if (req.method === "GET" && path === "/home/today") {
    if (isStaff) return fail(403, "forbidden_role", "No tenés permiso para esta acción.");
    const location = header ? session.setup.locations.find((l) => l.id === header) : null;
    const tz = location?.timezone ?? session.setup.timezone;
    const now = Date.now();
    const date = isoToZoned(new Date(now).toISOString(), tz).date;
    const dayStart = Date.parse(zonedToIso(date, "00:00", tz));
    const dayEnd = Date.parse(zonedToIso(addDays(date, 1), "00:00", tz));
    const tomorrowEnd = Date.parse(zonedToIso(addDays(date, 2), "00:00", tz));
    const monday = addDays(date, -((weekdayOf(date) + 6) % 7));
    const weekStart = Date.parse(zonedToIso(monday, "00:00", tz));
    const scoped = list.filter(inScope).sort((x, y) => x.startsAt.localeCompare(y.startsAt));
    const at = (a: Stored) => Date.parse(a.startsAt);
    const today = scoped.filter((a) => at(a) >= dayStart && at(a) < dayEnd);
    const byStatus = { pending: 0, confirmed: 0, completed: 0, cancelled: 0, no_show: 0 } as Record<AppointmentStatus, number>;
    for (const a of today) byStatus[a.status] += 1;
    const ai = scoped.filter((a) => a.channel === "whatsapp_ai" && Date.parse(a.createdAt) >= weekStart).sort((x, y) => y.createdAt.localeCompare(x.createdAt));
    const home: HomeToday = {
      date,
      timezone: tz,
      locationId: header,
      generatedAt: new Date(now).toISOString(),
      today: { total: today.length, byStatus },
      upcoming: scoped.filter((a) => ACTIVE.includes(a.status) && at(a) >= now && at(a) < now + 7 * DAY_MS).slice(0, 6).map((a) => view(session, a)),
      unconfirmed: scoped.filter((a) => a.status === "pending" && at(a) >= now && at(a) < tomorrowEnd).map((a) => view(session, a)),
      noShowsToday: today.filter((a) => a.status === "no_show").map((a) => view(session, a)),
      aiBookings: { count: ai.length, recent: ai.slice(0, 5).map((a) => view(session, a)) },
      conversationsWaiting: null,
    };
    return ok(home);
  }

  return null;
}
