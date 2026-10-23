import type { ChatCompletionFunctionTool } from "openai/resources/chat/completions";
import { z } from "zod";
import type { Executor } from "../../../platform/db/scope";
import { HttpError, ValidationError } from "../../../platform/http/errors";
import { listBookableStaff } from "../../catalog";
import {
  bookAppointment,
  cancelAppointment,
  findSlots,
  listUpcomingAppointmentsForClient,
  rescheduleAppointment,
  type AppointmentBookedHook,
  type AppointmentView,
  type Slot,
} from "../../scheduling";
import type { AgentAction, AgentReply, AgentTurnInput } from "../agentContract";
import { maxUpcomingAppointments } from "./config";
import { priceText, type AgentContext, type AgentLocation, type AgentService } from "./context";
import { hoursText } from "./prompt";
import { agentText } from "./texts";
import { addDays, isLocalDate, isLocalTime, localDate, localDayRange, localTime, readableDate, shortDate, zonedInstant } from "./time";

// ─────────────────────────────────────────────────────────────────────────────
// Herramientas del agente (OpenAI function calling, `strict: true`). Operan la agenda con
// los MISMOS servicios del núcleo que usa el panel (PLAN-GESTION.md §2): `findSlots`,
// `bookAppointment`, `rescheduleAppointment`, `cancelAppointment`…
//
// Lecciones de la auditoría (ROADMAP H12) aplicadas acá:
//   • Esquemas estrictos + validación con Zod de lo que manda el modelo (nunca se confía).
//   • Errores del dominio (HttpError: horario tomado, fuera de horario…) → mensaje corto y
//     seguro para el modelo. Cualquier otro error → genérico al modelo y el detalle a
//     Sentry/log (`reportError`): un stack trace o un mensaje de Postgres nunca llega al
//     prompt (ni, parafraseado, al cliente).
//   • Solo se tocan las citas DEL cliente de la conversación: reprogramar y cancelar
//     resuelven la cita entre sus próximas, no por un id cualquiera.
//   • Solo se agenda en horarios de la grilla de `findSlots` (los mismos que se ofrecen).
//
// Efectos laterales del turno (acciones del contrato, botones, traspaso) se anotan en
// `TurnEffects`; el bucle (./runner.ts) arma con eso el resultado.
// ─────────────────────────────────────────────────────────────────────────────

/** Lo que el turno dejó hecho o pendiente de mostrar. */
export interface TurnEffects {
  actions: AgentAction[];
  /** Confirmación fija de cada acción guardada (red de seguridad si el turno no termina bien). */
  confirmations: string[];
  /** Botones de horarios de la última `offer_slots` (se pegan a la respuesta final). */
  buttons: NonNullable<AgentReply["buttons"]> | null;
  handoff: { reason: string } | null;
}

export function emptyEffects(): TurnEffects {
  return { actions: [], confirmations: [], buttons: null, handoff: null };
}

export interface ToolRuntime {
  executor: Executor;
  ctx: AgentContext;
  input: AgentTurnInput;
  effects: TurnEffects;
  /** Aviso de cita agendada (métricas de uso que inyecta la composición). */
  onAppointmentBooked?: AppointmentBookedHook;
}

export type ToolResult = { ok: boolean } & Record<string, unknown>;

/** Mensaje al modelo cuando falla algo interno (el detalle va a Sentry/log, no acá). */
export const GENERIC_TOOL_ERROR =
  "No se pudo completar por un problema técnico. Disculpate con el cliente y ofrecé pasar la conversación a una persona del equipo.";

/** Días hacia adelante que el agente puede agendar. */
export const MAX_DAYS_AHEAD = 90;
/** Horarios que se listan como máximo en una respuesta de disponibilidad. */
const MAX_LISTED_TIMES = 16;
/** WhatsApp permite hasta 3 botones de respuesta rápida; el título, hasta 20 caracteres. */
const MAX_BUTTONS = 3;
const MAX_BUTTON_TITLE = 20;
export const MAX_FREE_TEXT = 300;

/**
 * Normaliza un texto libre que viene del modelo (y, detrás, del cliente) antes de guardarlo
 * o mostrarlo en el panel: sin caracteres de control ni invisibles, espacios colapsados y
 * cortado a `max` caracteres sin partir un emoji. "" si no queda nada.
 */
export function freeText(value: unknown, max: number): string {
  if (value == null) return "";
  const clean = String(value)
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return Array.from(clean).slice(0, max).join("").trim();
}

// ── Esquemas para OpenAI (strict: todo requerido, opcionales como null) ──────

type JsonSchema = Record<string, unknown>;

const str = (description: string, extra: JsonSchema = {}): JsonSchema => ({ type: "string", description, ...extra });
const nullableStr = (description: string): JsonSchema => ({ type: ["string", "null"], description });

function tool(name: string, description: string, properties: Record<string, JsonSchema>): ChatCompletionFunctionTool {
  return {
    type: "function",
    function: {
      name,
      description,
      strict: true,
      parameters: { type: "object", properties, required: Object.keys(properties), additionalProperties: false },
    },
  };
}

const LOCATION_ID = nullableStr("id de la sucursal (de la lista del negocio). null si el número atiende una sola o el negocio tiene una sola.");
const SERVICE_IDS: JsonSchema = {
  type: "array",
  items: { type: "string" },
  description: "ids de los servicios (de la lista), en el orden en que se hacen. Uno o más.",
};
const DATE = str("Fecha local en formato AAAA-MM-DD.", { pattern: "^\\d{4}-\\d{2}-\\d{2}$" });
const TIME = str("Hora local en formato HH:MM de 24 h (exactamente una de las que devolvió la disponibilidad).", { pattern: "^\\d{2}:\\d{2}$" });
const STAFF_ID = nullableStr("id de la persona que el cliente pidió; null si le da igual.");
const PART_OF_DAY: JsonSchema = {
  type: "string",
  enum: ["morning", "afternoon", "evening", "any"],
  description: "Franja: morning (antes de 12:00), afternoon (12:00–18:00), evening (desde 18:00) o any.",
};

export const TOOL_DEFINITIONS: ChatCompletionFunctionTool[] = [
  tool("list_services", "Lista los servicios que se pueden agendar por acá, con duración y precio de lista. Con sucursal, solo los que se ofrecen ahí.", {
    location_id: LOCATION_ID,
  }),
  tool("list_locations", "Lista las sucursales activas con dirección y horario de atención. Usala para preguntarle al cliente en cuál quiere atenderse.", {}),
  tool(
    "check_availability",
    "Consulta los horarios libres de uno o más servicios en una fecha (y sucursal, y opcionalmente una persona). Devuelve las horas exactas que se pueden agendar; si ese día no hay, las próximas fechas con espacio. No le muestra nada al cliente.",
    { location_id: LOCATION_ID, service_ids: SERVICE_IDS, date: DATE, staff_id: STAFF_ID, part_of_day: PART_OF_DAY },
  ),
  tool(
    "offer_slots",
    "Igual que check_availability, pero además le muestra al cliente hasta 3 horarios como BOTONES de WhatsApp para que elija con un toque. Después escribí una frase corta que nombre el servicio, el día y la sucursal; no repitas los horarios en texto.",
    { location_id: LOCATION_ID, service_ids: SERVICE_IDS, date: DATE, staff_id: STAFF_ID, part_of_day: PART_OF_DAY },
  ),
  tool("list_staff", "Lista quiénes atienden en una sucursal (y, si se indica, quiénes hacen un servicio, con su precio y duración).", {
    location_id: LOCATION_ID,
    service_id: nullableStr("id de un servicio para filtrar quién lo hace; null para todos."),
  }),
  tool(
    "book_appointment",
    "Agenda una cita para el cliente de esta conversación. Llamala SOLO después de que el cliente confirmó con un sí el servicio, el día, la hora y la sucursal, y con una hora que devolvió la disponibilidad.",
    {
      location_id: LOCATION_ID,
      service_ids: SERVICE_IDS,
      date: DATE,
      time: TIME,
      staff_id: STAFF_ID,
      client_name: nullableStr("Nombre del cliente si no estaba registrado y te lo dio; null si no."),
      notes: nullableStr("Nota breve para el equipo (p. ej. 'primera vez'); null si no hay."),
    },
  ),
  tool("get_my_appointments", "Devuelve las próximas citas del cliente de esta conversación (se identifica por su WhatsApp).", {}),
  tool(
    "reschedule_appointment",
    "Cambia el día y la hora de una cita próxima del cliente (con la misma persona). Llamala SOLO después de que el cliente confirmó el nuevo horario y de verificarlo con la disponibilidad.",
    {
      appointment_id: nullableStr("id de la cita (de get_my_appointments); null si el cliente tiene una sola."),
      date: DATE,
      time: TIME,
    },
  ),
  tool("cancel_appointment", "Cancela una cita próxima del cliente. Llamala SOLO después de que el cliente confirmó que quiere cancelar.", {
    appointment_id: nullableStr("id de la cita (de get_my_appointments); null si el cliente tiene una sola."),
    reason: nullableStr("Motivo que dio el cliente; null si no dio."),
  }),
  tool(
    "handoff_to_human",
    "Pasa la conversación a una persona del equipo cuando no podés resolver: una duda del negocio que no está en tu información, un reclamo, un caso especial o de salud, o el cliente pide una persona. No la uses para pedidos ajenos al negocio.",
    { reason: str("Una frase breve con lo que necesita el cliente, para que la persona entre en contexto.") },
  ),
];

/** Nombres de las tools (para validar las evals y los tests). */
export const TOOL_NAMES = TOOL_DEFINITIONS.map((t) => t.function.name);

// ── Validación de argumentos (Zod) ──────────────────────────────────────────

const Id = z.string().trim().min(1).max(100);
const NullableId = Id.nullable();
const DateArg = z.string().refine(isLocalDate, "fecha inválida: usá AAAA-MM-DD");
const TimeArg = z.string().refine(isLocalTime, "hora inválida: usá HH:MM de 24 h");
const ServiceIdsArg = z.array(Id).min(1).max(5);
const PartOfDayArg = z.enum(["morning", "afternoon", "evening", "any"]);
const FreeTextArg = z.string().max(2000).nullable();

const AvailabilityArgs = z.object({
  location_id: NullableId,
  service_ids: ServiceIdsArg,
  date: DateArg,
  staff_id: NullableId,
  part_of_day: PartOfDayArg,
});

const ARGS = {
  list_services: z.object({ location_id: NullableId }),
  list_locations: z.object({}),
  check_availability: AvailabilityArgs,
  offer_slots: AvailabilityArgs,
  list_staff: z.object({ location_id: NullableId, service_id: NullableId }),
  book_appointment: z.object({
    location_id: NullableId,
    service_ids: ServiceIdsArg,
    date: DateArg,
    time: TimeArg,
    staff_id: NullableId,
    client_name: FreeTextArg,
    notes: FreeTextArg,
  }),
  get_my_appointments: z.object({}),
  reschedule_appointment: z.object({ appointment_id: NullableId, date: DateArg, time: TimeArg }),
  cancel_appointment: z.object({ appointment_id: NullableId, reason: FreeTextArg }),
  handoff_to_human: z.object({ reason: z.string().max(2000) }),
} satisfies Record<string, z.ZodType>;

type ToolName = keyof typeof ARGS;

// ── Resolución de sucursal, servicios y persona ─────────────────────────────

/** Error del dominio para el modelo (no es una excepción interna). */
class ToolFailure extends Error {
  constructor(readonly result: ToolResult) {
    super(String(result.error ?? "tool failure"));
  }
}

const fail = (error: string, extra: Record<string, unknown> = {}): never => {
  throw new ToolFailure({ ok: false, error, ...extra });
};

const sameId = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

function locationList(ctx: AgentContext) {
  return ctx.locations.map((l) => ({ id: l.id, name: l.name, address: l.address }));
}

/** Sucursal para la operación: la del canal, la pedida o la única del negocio. */
function resolveLocation(rt: ToolRuntime, requested: string | null): AgentLocation {
  const { ctx, input } = rt;
  const t = ctx.terminology;
  if (input.locationId) {
    const channel = ctx.locations.find((l) => sameId(l.id, input.locationId as string));
    if (!channel) fail(`La ${t.location} de este número no está disponible ahora. Ofrecé pasar la conversación a una persona.`);
    if (requested && !sameId(requested, channel!.id)) {
      fail(`Este número atiende solo la ${t.location} ${channel!.name}.`, { location: { id: channel!.id, name: channel!.name } });
    }
    return channel!;
  }
  if (requested) {
    const found = ctx.locations.find((l) => sameId(l.id, requested));
    if (!found) fail(`Esa ${t.location} no existe o no está activa.`, { locations: locationList(ctx) });
    return found!;
  }
  if (ctx.locations.length === 1) return ctx.locations[0];
  if (ctx.locations.length === 0) fail(`El negocio no tiene ${t.locations} activas. Ofrecé pasar la conversación a una persona.`);
  return fail(`Falta la ${t.location}: preguntale al cliente en cuál quiere atenderse.`, { locations: locationList(ctx) });
}

function resolveServices(rt: ToolRuntime, ids: readonly string[], location: AgentLocation): AgentService[] {
  const { ctx } = rt;
  const t = ctx.terminology;
  const chosen: AgentService[] = [];
  for (const id of ids) {
    const service = ctx.services.find((s) => sameId(s.id, id));
    if (!service) {
      fail("Alguno de los servicios no existe o no se agenda por este medio.", {
        services: ctx.services.map((s) => ({ id: s.id, name: s.name })),
      });
    }
    if (service!.locationIds.length > 0 && !service!.locationIds.some((l) => sameId(l, location.id))) {
      const where = ctx.locations.filter((l) => service!.locationIds.some((id2) => sameId(id2, l.id))).map((l) => l.name);
      fail(`${service!.name} no se ofrece en la ${t.location} ${location.name}${where.length ? ` (sí en: ${where.join(", ")})` : ""}.`);
    }
    if (chosen.some((s) => s.id === service!.id)) fail(`${service!.name} va una sola vez.`);
    chosen.push(service!);
  }
  return chosen;
}

function resolveStaff(rt: ToolRuntime, requested: string | null, location: AgentLocation): { id: string; name: string } | null {
  if (!requested || requested.toLowerCase() === "any") return null;
  const t = rt.ctx.terminology;
  const person = rt.ctx.staff.find((s) => sameId(s.id, requested));
  if (!person) fail(`Ese ${t.staffMember} no existe.`, { staff: rt.ctx.staff.map((s) => ({ id: s.id, name: s.name })) });
  if (!person!.locationIds.some((l) => sameId(l, location.id))) {
    fail(`${person!.name} no atiende en la ${t.location} ${location.name}.`);
  }
  return { id: person!.id, name: person!.name };
}

function assertBookableDate(rt: ToolRuntime, date: string, location: AgentLocation): void {
  const today = localDate(rt.input.now, location.timezone);
  if (date < today) fail(`Esa fecha ya pasó (hoy es ${today}).`);
  if (date > addDays(today, MAX_DAYS_AHEAD)) fail(`Solo se puede agendar hasta ${MAX_DAYS_AHEAD} días adelante.`);
}

// ── Disponibilidad ──────────────────────────────────────────────────────────

type PartOfDay = z.infer<typeof PartOfDayArg>;

function inPartOfDay(time: string, part: PartOfDay): boolean {
  if (part === "morning") return time < "12:00";
  if (part === "afternoon") return time >= "12:00" && time < "18:00";
  if (part === "evening") return time >= "18:00";
  return true;
}

interface DaySlot {
  time: string;
  staff: string[];
}

function daySlots(slots: readonly Slot[], date: string, tz: string, part: PartOfDay): DaySlot[] {
  return slots
    .filter((s) => localDate(s.startsAt, tz) === date)
    .map((s) => ({ time: localTime(s.startsAt, tz), staff: s.staff.map((p) => p.name) }))
    .filter((s) => inPartOfDay(s.time, part));
}

interface AvailabilityQuery {
  location: AgentLocation;
  services: AgentService[];
  staff: { id: string; name: string } | null;
  date: string;
  part: PartOfDay;
  excludeAppointmentId?: string;
  onlineOnly?: boolean;
}

async function slotsBetween(rt: ToolRuntime, q: AvailabilityQuery, from: Date, to: Date): Promise<Slot[]> {
  return findSlots(rt.executor, rt.input.businessId, {
    locationId: q.location.id,
    serviceIds: q.services.map((s) => s.id),
    staffId: q.staff?.id ?? "any",
    from,
    to,
    now: rt.input.now,
    onlineOnly: q.onlineOnly ?? true,
    excludeAppointmentId: q.excludeAppointmentId,
  });
}

/** Horarios del día pedido y, si no hay, las próximas fechas con espacio (hasta 14 días). */
async function availability(rt: ToolRuntime, q: AvailabilityQuery): Promise<{ times: DaySlot[]; nextAvailable: { date: string; readable: string; times: string[] }[] }> {
  const tz = q.location.timezone;
  const { from, to } = localDayRange(q.date, tz);
  const times = daySlots(await slotsBetween(rt, q, from, to), q.date, tz, q.part);
  if (times.length > 0) return { times, nextAvailable: [] };
  const later = await slotsBetween(rt, q, to, localDayRange(addDays(q.date, 14), tz).to);
  const nextAvailable: { date: string; readable: string; times: string[] }[] = [];
  for (let d = 1; d <= 14 && nextAvailable.length < 3; d++) {
    const date = addDays(q.date, d);
    const found = daySlots(later, date, tz, q.part);
    if (found.length) nextAvailable.push({ date, readable: readableDate(date), times: found.slice(0, 4).map((s) => s.time) });
  }
  return { times, nextAvailable };
}

/** Hasta `n` horarios repartidos en el día (el primero, el último y los del medio). */
function spread<T>(items: readonly T[], n: number): T[] {
  if (items.length <= n) return [...items];
  return Array.from({ length: n }, (_, i) => items[Math.round((i * (items.length - 1)) / (n - 1))]);
}

async function availabilityTool(rt: ToolRuntime, args: z.infer<typeof AvailabilityArgs>, withButtons: boolean): Promise<ToolResult> {
  const location = resolveLocation(rt, args.location_id);
  const services = resolveServices(rt, args.service_ids, location);
  const staff = resolveStaff(rt, args.staff_id, location);
  assertBookableDate(rt, args.date, location);
  const { times, nextAvailable } = await availability(rt, { location, services, staff, date: args.date, part: args.part_of_day });
  const base = {
    location: location.name,
    date: args.date,
    readable_date: readableDate(args.date),
    services: services.map((s) => s.name),
    staff: staff?.name ?? null,
  };
  if (times.length === 0) {
    return {
      ok: true,
      ...base,
      available: [],
      next_available: nextAvailable,
      note: nextAvailable.length
        ? "Ese día no hay horarios libres (en esa franja). Ofrecé alguna de las próximas fechas."
        : "No hay horarios libres en las próximas dos semanas con esos filtros. Ofrecé otra persona, otra sucursal o pasar a una persona.",
    };
  }
  const listed = times.slice(0, MAX_LISTED_TIMES);
  const result: ToolResult = { ok: true, ...base, available: listed, more: times.length - listed.length };
  if (withButtons) {
    const shown = spread(times, MAX_BUTTONS);
    rt.effects.buttons = shown.map((s) => ({
      id: `slot:${args.date}T${s.time}`,
      title: `${shortDate(args.date)} · ${s.time}`.slice(0, MAX_BUTTON_TITLE),
    }));
    result.shown_as_buttons = shown.map((s) => s.time);
    result.note =
      "Le mostré al cliente esos horarios como botones. Escribí UNA frase corta que nombre el servicio, el día y la sucursal, invitándolo a elegir (si ninguno le sirve, que te diga otra hora de la lista). No repitas los horarios en texto.";
  }
  return result;
}

// ── Citas ───────────────────────────────────────────────────────────────────

interface AppointmentSummary {
  appointment_id: string;
  services: string;
  date: string;
  readable_date: string;
  time: string;
  staff: string | null;
  location: string | null;
  price: string;
  status: string;
}

function summarize(rt: ToolRuntime, view: AppointmentView): AppointmentSummary {
  const tz = view.location?.timezone ?? rt.ctx.timezone;
  const start = new Date(view.startsAt);
  const date = localDate(start, tz);
  const variable = view.services.some((l) => rt.ctx.services.find((s) => s.id === l.serviceId)?.variablePrice);
  return {
    appointment_id: view.id,
    services: view.services.map((l) => l.name).join(" + "),
    date,
    readable_date: readableDate(date),
    time: localTime(start, tz),
    staff: view.staff?.name ?? null,
    location: view.location?.name ?? null,
    price: priceText(view.totalCents, variable, rt.ctx.currency),
    status: view.status === "confirmed" ? "confirmada" : "sin confirmar",
  };
}

function upcoming(rt: ToolRuntime, limit = 10): Promise<AppointmentView[]> {
  return listUpcomingAppointmentsForClient(rt.executor, rt.input.businessId, rt.input.clientId, { now: rt.input.now, limit });
}

/** La cita del cliente a la que se refiere: por id entre SUS próximas, o la única. */
async function resolveClientAppointment(rt: ToolRuntime, appointmentId: string | null): Promise<AppointmentView> {
  const t = rt.ctx.terminology;
  const list = await upcoming(rt);
  if (list.length === 0) fail(`El ${t.client} no tiene ${t.appointments} próximas.`);
  if (appointmentId) {
    const found = list.find((a) => sameId(a.id, appointmentId));
    if (!found) fail(`No encontré esa ${t.appointment} entre las próximas del ${t.client}.`, { appointments: list.map((a) => summarize(rt, a)) });
    return found!;
  }
  if (list.length > 1) {
    fail(`El ${t.client} tiene varias ${t.appointments} próximas: preguntale cuál y pasá el appointment_id.`, {
      appointments: list.map((a) => summarize(rt, a)),
    });
  }
  return list[0];
}

function confirmationVars(rt: ToolRuntime, s: AppointmentSummary): Record<string, string> {
  return {
    appointment: rt.ctx.terminology.appointment,
    services: s.services,
    date: s.readable_date,
    time: s.time,
    location: s.location ?? "",
  };
}

const UNNAMED = new Set(["", "sin nombre"]);

async function bookTool(rt: ToolRuntime, args: z.infer<(typeof ARGS)["book_appointment"]>): Promise<ToolResult> {
  const t = rt.ctx.terminology;
  const location = resolveLocation(rt, args.location_id);
  const services = resolveServices(rt, args.service_ids, location);
  const staff = resolveStaff(rt, args.staff_id, location);
  assertBookableDate(rt, args.date, location);

  const max = maxUpcomingAppointments();
  const existing = await upcoming(rt, max + 1);
  if (existing.length >= max) {
    fail(
      `El ${t.client} ya tiene ${existing.length} ${t.appointments} próximas y el máximo por ${t.client} es ${max}. Ofrecé reprogramar o cancelar alguna, o pasar a una persona.`,
      { appointments: existing.map((a) => summarize(rt, a)) },
    );
  }

  // Solo horas de la grilla que se ofrece (las mismas de check_availability / offer_slots).
  const startsAt = zonedInstant(args.date, args.time, location.timezone);
  const query: AvailabilityQuery = { location, services, staff, date: args.date, part: "any" };
  const exact = await slotsBetween(rt, query, startsAt, new Date(startsAt.getTime() + 60_000));
  if (!exact.some((s) => s.startsAt.getTime() === startsAt.getTime())) {
    const { times, nextAvailable } = await availability(rt, query);
    fail("Esa hora no está disponible. Ofrecé una de las disponibles.", {
      available: times.slice(0, MAX_LISTED_TIMES).map((s) => s.time),
      next_available: nextAvailable,
    });
  }

  const givenName = freeText(args.client_name, 80);
  const noteParts = [
    givenName && UNNAMED.has((rt.input.clientName ?? "").trim().toLocaleLowerCase("es")) ? `Nombre dado por WhatsApp: ${givenName}.` : "",
    freeText(args.notes, MAX_FREE_TEXT),
  ].filter(Boolean);

  const view = await bookAppointment(rt.executor, rt.input.businessId, {
    locationId: location.id,
    clientId: rt.input.clientId,
    serviceIds: services.map((s) => s.id),
    staffId: staff?.id ?? "any",
    startsAt,
    channel: "whatsapp_ai",
    notes: noteParts.join(" ") || null,
    createdBy: null,
    now: rt.input.now,
    onBooked: rt.onAppointmentBooked,
  });
  const summary = summarize(rt, view);
  rt.effects.actions.push({ type: "appointment_booked", appointmentId: view.id });
  rt.effects.confirmations.push(agentText(rt.ctx.settings, "appointmentBooked", confirmationVars(rt, summary)));
  rt.effects.buttons = null;
  return { ok: true, appointment: summary, note: `Quedó agendada. Confirmale al ${t.client} en una frase corta.` };
}

async function rescheduleTool(rt: ToolRuntime, args: z.infer<(typeof ARGS)["reschedule_appointment"]>): Promise<ToolResult> {
  const t = rt.ctx.terminology;
  const target = await resolveClientAppointment(rt, args.appointment_id);
  const location = rt.ctx.locations.find((l) => sameId(l.id, target.locationId));
  if (!location) fail(`La ${t.location} de esa ${t.appointment} ya no está activa: ofrecé pasar a una persona.`);
  if (target.services.some((l) => !l.serviceId)) {
    fail(`Alguno de los servicios de esa ${t.appointment} ya no existe: ofrecé cancelarla y agendar otra, o pasar a una persona.`);
  }
  assertBookableDate(rt, args.date, location!);
  const startsAt = zonedInstant(args.date, args.time, location!.timezone);
  const services = target.services.map((l) => rt.ctx.services.find((s) => s.id === l.serviceId) ?? ({ id: l.serviceId as string, name: l.name } as AgentService));
  const staff = target.staff ? { id: target.staff.id, name: target.staff.name } : null;
  // Se mueve CON su persona: los horarios son los de ella, sin contar la propia cita.
  const query: AvailabilityQuery = { location: location!, services, staff, date: args.date, part: "any", excludeAppointmentId: target.id, onlineOnly: false };
  const exact = await slotsBetween(rt, query, startsAt, new Date(startsAt.getTime() + 60_000));
  if (!exact.some((s) => s.startsAt.getTime() === startsAt.getTime())) {
    const { times, nextAvailable } = await availability(rt, query);
    fail(`${staff?.name ?? `Ese ${t.staffMember}`} no tiene libre esa hora. Ofrecé otra de las disponibles.`, {
      available: times.slice(0, MAX_LISTED_TIMES).map((s) => s.time),
      next_available: nextAvailable,
    });
  }
  const view = await rescheduleAppointment(rt.executor, rt.input.businessId, target.id, { startsAt, channel: "whatsapp_ai", now: rt.input.now });
  const summary = summarize(rt, view);
  rt.effects.actions.push({ type: "appointment_rescheduled", appointmentId: view.id });
  rt.effects.confirmations.push(agentText(rt.ctx.settings, "appointmentRescheduled", confirmationVars(rt, summary)));
  rt.effects.buttons = null;
  return { ok: true, appointment: summary };
}

async function cancelTool(rt: ToolRuntime, args: z.infer<(typeof ARGS)["cancel_appointment"]>): Promise<ToolResult> {
  const target = await resolveClientAppointment(rt, args.appointment_id);
  const reason = freeText(args.reason, MAX_FREE_TEXT) || "Cancelada por el cliente por WhatsApp.";
  const view = await cancelAppointment(rt.executor, rt.input.businessId, target.id, reason, { now: rt.input.now });
  const summary = summarize(rt, view);
  rt.effects.actions.push({ type: "appointment_cancelled", appointmentId: view.id });
  rt.effects.confirmations.push(agentText(rt.ctx.settings, "appointmentCancelled", confirmationVars(rt, summary)));
  rt.effects.buttons = null;
  return { ok: true, cancelled: { ...summary, status: "cancelada" } };
}

// ── Despacho ────────────────────────────────────────────────────────────────

const HANDLERS: { [K in ToolName]: (rt: ToolRuntime, args: z.infer<(typeof ARGS)[K]>) => Promise<ToolResult> } = {
  async list_services(rt, args) {
    const location = args.location_id || rt.input.locationId || rt.ctx.locations.length === 1 ? resolveLocation(rt, args.location_id) : null;
    const names = new Map(rt.ctx.locations.map((l) => [l.id, l.name]));
    const services = rt.ctx.services
      .filter((s) => !location || s.locationIds.length === 0 || s.locationIds.some((id) => sameId(id, location.id)))
      .map((s) => ({
        id: s.id,
        name: s.name,
        duration_min: s.durationMin,
        price: priceText(s.priceCents, s.variablePrice, rt.ctx.currency),
        ...(location || s.locationIds.length === 0 ? {} : { only_at: s.locationIds.map((id) => names.get(id)).filter(Boolean) }),
      }));
    return { ok: true, location: location?.name ?? null, services };
  },

  async list_locations(rt) {
    const channel = rt.input.locationId ? rt.ctx.locations.filter((l) => sameId(l.id, rt.input.locationId as string)) : rt.ctx.locations;
    return {
      ok: true,
      locations: channel.map((l) => ({ id: l.id, name: l.name, address: l.address, phone: l.phone, hours: hoursText(l) })),
      ...(rt.input.locationId ? { note: `Este número atiende solo esta ${rt.ctx.terminology.location}.` } : {}),
    };
  },

  check_availability: (rt, args) => availabilityTool(rt, args, false),
  offer_slots: (rt, args) => availabilityTool(rt, args, true),

  async list_staff(rt, args) {
    const location = resolveLocation(rt, args.location_id);
    let serviceId: string | undefined;
    if (args.service_id) serviceId = resolveServices(rt, [args.service_id], location)[0].id;
    const staff = await listBookableStaff(rt.executor, rt.input.businessId, { locationId: location.id, serviceId });
    return {
      ok: true,
      location: location.name,
      staff: staff.map((s) => ({
        id: s.id,
        name: s.name,
        ...(s.service ? { price: priceText(s.service.priceCents, s.service.variablePrice, rt.ctx.currency), duration_min: s.service.durationMin } : {}),
      })),
    };
  },

  book_appointment: bookTool,

  async get_my_appointments(rt) {
    const list = await upcoming(rt);
    return {
      ok: true,
      count: list.length,
      appointments: list.map((a) => summarize(rt, a)),
      note: list.length ? undefined : `El ${rt.ctx.terminology.client} no tiene ${rt.ctx.terminology.appointments} próximas.`,
    };
  },

  reschedule_appointment: rescheduleTool,
  cancel_appointment: cancelTool,

  async handoff_to_human(rt, args) {
    rt.effects.handoff = { reason: freeText(args.reason, MAX_FREE_TEXT) || "El agente no pudo resolver la consulta." };
    return { ok: true };
  },
};

/** Mensaje seguro de un error del dominio (lo que el núcleo ya escribe para mostrar). */
export function domainErrorMessage(error: HttpError): string {
  const fields = error instanceof ValidationError ? [...new Set(Object.values(error.fields))] : [];
  const message = fields.length ? fields.join(" ") : error.message;
  return freeText(message, MAX_FREE_TEXT) || "No se pudo completar.";
}

export type ErrorReporter = (error: unknown, context: Record<string, unknown>) => void;

/**
 * Ejecuta una tool pedida por el modelo y devuelve su resultado (para el mensaje `tool`).
 * Nunca lanza: los errores del dominio vuelven como `{ ok: false, error }` legible y los
 * internos como un genérico (con el detalle a `reportError`).
 */
export async function executeTool(name: string, rawArgs: string, rt: ToolRuntime, reportError: ErrorReporter): Promise<ToolResult> {
  if (!Object.prototype.hasOwnProperty.call(ARGS, name)) return { ok: false, error: `Herramienta desconocida: ${freeText(name, 64)}.` };
  const toolName = name as ToolName;
  let json: unknown;
  try {
    json = JSON.parse(rawArgs || "{}");
  } catch {
    return { ok: false, error: "Argumentos inválidos (no es JSON)." };
  }
  const parsed = ARGS[toolName].safeParse(json);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join(".") || "argumentos"}: ${i.message}`).join("; ");
    return { ok: false, error: `Argumentos inválidos: ${freeText(detail, MAX_FREE_TEXT)}` };
  }
  try {
    const handler = HANDLERS[toolName] as (rt: ToolRuntime, args: unknown) => Promise<ToolResult>;
    return await handler(rt, parsed.data);
  } catch (error) {
    if (error instanceof ToolFailure) return error.result;
    if (error instanceof HttpError) {
      const result: ToolResult = { ok: false, error: domainErrorMessage(error) };
      if (error.code === "slot_taken") result.note = "Ese horario se acaba de ocupar. Disculpate y ofrecé otro con check_availability u offer_slots.";
      return result;
    }
    reportError(error, { tool: toolName, businessId: rt.input.businessId, conversationId: rt.input.conversationId });
    return { ok: false, error: GENERIC_TOOL_ERROR };
  }
}
