import { z } from "zod";
import type { Role } from "../../platform/auth/sessionToken";
import type { Executor } from "../../platform/db/scope";
import { assertLocationAccess } from "../../platform/http/access";
import { HttpError, ValidationError } from "../../platform/http/errors";
import { created, route } from "../../platform/http/router";
import type { Route, Session } from "../../platform/http/routeTypes";
import { assertFullClients, type ClientsTierHook } from "../../platform/plan/planHooks";
import { CustomDataInput, getLocation } from "../business";
import { getClient } from "../clients";
import { getStaffIdForUser } from "../team";
import {
  bookAppointment,
  cancelAppointment,
  completeAppointment,
  confirmAppointment,
  getAppointment,
  listAppointments,
  listClientAppointments,
  markNoShow,
  reassignStaff,
  rescheduleAppointment,
  updateAppointmentDetails,
  type AppointmentBookedHook,
  type AppointmentCompletedHook,
  type AppointmentView,
} from "./appointments";
import { findSlots, MAX_SERVICES_PER_APPOINTMENT, type Slot } from "./availability";
import { getHomeToday, type ConversationsWaitingCounter } from "./home";
import { localDayBounds } from "./time";

// ─────────────────────────────────────────────────────────────────────────────
// Rutas de la Agenda y del Inicio básico (I1):
//
//   GET   /availability                    ?locationId&date&serviceIds&staffId[&excludeAppointmentId] (todos)
//   GET   /appointments                    ?from&to[&staffId&clientId] (todos; sucursal por X-Location-Id)
//   POST  /appointments                    (todos; el profesional, solo en su carril)
//   GET   /appointments/:id                (todos)
//   PATCH /appointments/:id                notas y campos personalizados (todos; campos: Pro)
//   POST  /appointments/:id/confirm        (todos)
//   POST  /appointments/:id/complete       (todos)
//   POST  /appointments/:id/cancel         { reason } (todos)
//   POST  /appointments/:id/no-show        (todos)
//   POST  /appointments/:id/reschedule     { startsAt, staffId?, allowOutsideHours? } (todos; staffId: no el profesional)
//   POST  /appointments/:id/assign         { staffId } (dueño, admin, recepción)
//   GET   /clients/:id/appointments        historial para la ficha (todos)
//   GET   /home/today                      Inicio básico (dueño, admin, recepción; X-Location-Id o todas)
//
// Sin `module`: la Agenda viene en los dos planes (núcleo). Los campos personalizados de la
// cita (`customData`, al crearla o en el PATCH) son del CRM completo (plan Pro): sin el
// nivel `full` de clientes, 403 `module_not_in_plan`. Acceso:
//   • Sucursal: una sesión limitada a algunas sucursales solo ve y opera citas de esas
//     (403 `location_forbidden`).
//   • Rol `staff`: solo sus citas (las del profesional vinculado a su usuario), en
//     cualquier operación; 403 `own_appointments_only` si intenta otra. Sin profesional
//     vinculado no ve ninguna.
// ─────────────────────────────────────────────────────────────────────────────

export interface SchedulingRouteDeps {
  db: Executor;
  /** Conversaciones esperando a una persona para el Inicio (lo inyecta la composición desde whatsapp). */
  countConversationsWaiting?: ConversationsWaitingCounter;
  /** Nivel de clientes del plan (campos personalizados de la cita = CRM completo). Sin él, no se aceptan. */
  plans?: ClientsTierHook;
  /** Efectos internos de completar una cita, en su transacción (la composición inyecta las comisiones). */
  onAppointmentCompleted?: AppointmentCompletedHook;
  /** Aviso de cita creada desde el panel, ya confirmada (la composición cuenta el uso en `daily_usage`). */
  onAppointmentBooked?: AppointmentBookedHook;
}

const DESK: readonly Role[] = ["owner", "admin", "front_desk"];
const DAY_MS = 24 * 60 * 60 * 1000;
/** Rango máximo de `GET /appointments` (una vista de mes con márgenes). */
const MAX_LIST_RANGE_DAYS = 62;

/** Canales que el equipo puede elegir al cargar una cita desde el panel. */
const PANEL_CHANNELS = ["panel", "phone", "walk_in"] as const;

const Instant = z.iso
  .datetime({ offset: true, error: "Fecha y hora inválidas (ISO 8601 con zona)." })
  .transform((s) => new Date(s));
const IdParams = z.object({ id: z.uuid() });
const StaffChoice = z.union([z.literal("any"), z.uuid()]);

/** `serviceIds` en la query: separados por coma o repetidos. */
const ServiceIdsQuery = z.preprocess(
  (v) => (typeof v === "string" ? v.split(",").map((s) => s.trim()).filter(Boolean) : v),
  z.array(z.uuid()).min(1, "Elegí al menos un servicio.").max(MAX_SERVICES_PER_APPOINTMENT),
);

const Notes = z
  .string()
  .trim()
  .max(2000)
  .nullable()
  .transform((s) => (s ? s : null));

const AvailabilityQuery = z.object({
  locationId: z.uuid(),
  date: z.iso.date("Fecha inválida (formato AAAA-MM-DD)."),
  serviceIds: ServiceIdsQuery,
  staffId: StaffChoice.optional(),
  excludeAppointmentId: z.uuid().optional(),
});

const ListQuery = z
  .object({ from: Instant, to: Instant, staffId: z.uuid().optional(), clientId: z.uuid().optional() })
  .superRefine((q, ctx) => {
    if (!(q.from instanceof Date) || !(q.to instanceof Date)) return;
    const range = q.to.getTime() - q.from.getTime();
    if (range <= 0) ctx.addIssue({ code: "custom", message: "El fin tiene que ser después del inicio.", path: ["to"] });
    else if (range > MAX_LIST_RANGE_DAYS * DAY_MS) {
      ctx.addIssue({ code: "custom", message: `El rango puede ser de a lo sumo ${MAX_LIST_RANGE_DAYS} días.`, path: ["to"] });
    }
  });

const CreateBody = z
  .object({
    locationId: z.uuid(),
    clientId: z.uuid(),
    serviceIds: z.array(z.uuid()).min(1, "Elegí al menos un servicio.").max(MAX_SERVICES_PER_APPOINTMENT),
    staffId: StaffChoice.nullable().optional(),
    startsAt: Instant,
    channel: z.enum(PANEL_CHANNELS).default("panel"),
    notes: Notes.optional(),
    customData: CustomDataInput.optional(),
    allowOutsideHours: z.boolean().optional(),
  })
  .strict();

const DetailsBody = z
  .object({ notes: Notes.optional(), customData: CustomDataInput.optional() })
  .strict()
  .refine((b) => b.notes !== undefined || b.customData !== undefined, { message: "Indicá qué cambiar." });
const CancelBody = z.object({ reason: z.string().trim().max(500).nullable().optional() }).strict();
const RescheduleBody = z.object({ startsAt: Instant, staffId: z.uuid().optional(), allowOutsideHours: z.boolean().optional() }).strict();
const AssignBody = z.object({ staffId: z.uuid() }).strict();
const HistoryQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().max(500).optional(),
});

// ── Acceso ──────────────────────────────────────────────────────────────────

const ownOnly = () => new HttpError(403, "Solo podés ver y operar tus propias citas.", "own_appointments_only");

/** Profesional propio del rol `staff` (null = no tiene); undefined para los demás roles. */
async function ownStaffId(db: Executor, session: Session): Promise<string | null | undefined> {
  if (session.role !== "staff") return undefined;
  return getStaffIdForUser(db, session.businessId, session.userId);
}

/** Sucursales que ve la sesión: la del header, o todas las suyas (null = todas las del negocio). */
function visibleLocations(session: Session, headerLocation: string | null): readonly string[] | null {
  if (headerLocation) return [headerLocation];
  return session.locationIds === "all" ? null : session.locationIds;
}

/** La cita, si la sesión la puede ver y operar (404 si no existe; 403 si no es suya o de otra sucursal). */
async function accessibleAppointment(db: Executor, session: Session, id: string): Promise<AppointmentView> {
  const appointment = await getAppointment(db, session.businessId, id);
  if (!appointment) throw new HttpError(404, "No encontramos esa cita.", "not_found");
  assertLocationAccess(session, appointment.locationId);
  const own = await ownStaffId(db, session);
  if (own !== undefined && appointment.staffId !== own) throw ownOnly();
  return appointment;
}

function slotJson(slot: Slot) {
  return {
    startsAt: slot.startsAt.toISOString(),
    staff: slot.staff.map((s) => ({ ...s, endsAt: s.endsAt.toISOString() })),
  };
}

export function schedulingRoutes({ db, countConversationsWaiting, plans, onAppointmentCompleted, onAppointmentBooked }: SchedulingRouteDeps): Route[] {
  /** Campos personalizados de la cita: CRM completo (sin el hook del plan, nunca). */
  async function assertCustomFieldsAllowed(businessId: string): Promise<void> {
    await assertFullClients(plans ?? { clientsTier: async () => "basic" }, businessId);
  }

  return [
    route({ method: "GET", path: "/availability", auth: "user", query: AvailabilityQuery }, async ({ session, query }) => {
      assertLocationAccess(session, query.locationId);
      const location = await getLocation(db, session.businessId, query.locationId);
      if (!location) throw new ValidationError({ "query.locationId": "Esa sucursal no existe." });
      let staffId = query.staffId;
      const own = await ownStaffId(db, session);
      if (own !== undefined) {
        if (!own) throw ownOnly();
        if (staffId && staffId !== "any" && staffId !== own) throw ownOnly();
        staffId = own;
      }
      const { start, end } = localDayBounds(query.date, location.timezone);
      // El equipo puede tomar el próximo horario libre (sin el margen del cliente final).
      const slots = await findSlots(db, session.businessId, {
        locationId: location.id,
        serviceIds: query.serviceIds,
        staffId,
        from: start,
        to: end,
        excludeAppointmentId: query.excludeAppointmentId,
        minLeadMin: 0,
      });
      return { date: query.date, timezone: location.timezone, locationId: location.id, slots: slots.map(slotJson) };
    }),

    route(
      { method: "GET", path: "/appointments", auth: "user", location: "optional", query: ListQuery },
      async ({ session, query, locationId }) => {
        const own = await ownStaffId(db, session);
        if (own === null) return [];
        if (own && query.staffId && query.staffId !== own) throw ownOnly();
        return listAppointments(db, session.businessId, {
          from: query.from,
          to: query.to,
          locationIds: visibleLocations(session, locationId),
          staffId: own ?? query.staffId ?? null,
          clientId: query.clientId ?? null,
        });
      },
    ),

    route({ method: "POST", path: "/appointments", auth: "user", body: CreateBody }, async ({ session, body }) => {
      assertLocationAccess(session, body.locationId);
      if (body.customData !== undefined) await assertCustomFieldsAllowed(session.businessId);
      let staffId = body.staffId ?? "any";
      const own = await ownStaffId(db, session);
      if (own !== undefined) {
        if (!own || (staffId !== "any" && staffId !== own)) throw ownOnly();
        staffId = own;
      }
      return created(
        await bookAppointment(db, session.businessId, {
          locationId: body.locationId,
          clientId: body.clientId,
          serviceIds: body.serviceIds,
          staffId,
          startsAt: body.startsAt,
          channel: body.channel,
          notes: body.notes ?? null,
          customData: body.customData,
          createdBy: session.userId,
          allowOutsideHours: body.allowOutsideHours,
          onBooked: onAppointmentBooked,
        }),
      );
    }),

    route({ method: "GET", path: "/appointments/:id", auth: "user", params: IdParams }, ({ session, params }) =>
      accessibleAppointment(db, session, params.id),
    ),

    route({ method: "PATCH", path: "/appointments/:id", auth: "user", params: IdParams, body: DetailsBody }, async ({ session, params, body }) => {
      await accessibleAppointment(db, session, params.id);
      if (body.customData !== undefined) await assertCustomFieldsAllowed(session.businessId);
      return updateAppointmentDetails(db, session.businessId, params.id, { notes: body.notes, customData: body.customData });
    }),

    route({ method: "POST", path: "/appointments/:id/confirm", auth: "user", params: IdParams }, async ({ session, params }) => {
      await accessibleAppointment(db, session, params.id);
      return confirmAppointment(db, session.businessId, params.id);
    }),

    route({ method: "POST", path: "/appointments/:id/complete", auth: "user", params: IdParams }, async ({ session, params }) => {
      await accessibleAppointment(db, session, params.id);
      return completeAppointment(db, session.businessId, params.id, { onCompleted: onAppointmentCompleted });
    }),

    route({ method: "POST", path: "/appointments/:id/no-show", auth: "user", params: IdParams }, async ({ session, params }) => {
      await accessibleAppointment(db, session, params.id);
      return markNoShow(db, session.businessId, params.id);
    }),

    route(
      { method: "POST", path: "/appointments/:id/cancel", auth: "user", params: IdParams, body: CancelBody },
      async ({ session, params, body }) => {
        await accessibleAppointment(db, session, params.id);
        return cancelAppointment(db, session.businessId, params.id, body.reason ?? null);
      },
    ),

    route(
      { method: "POST", path: "/appointments/:id/reschedule", auth: "user", params: IdParams, body: RescheduleBody },
      async ({ session, params, body }) => {
        const current = await accessibleAppointment(db, session, params.id);
        if (session.role === "staff" && body.staffId && body.staffId !== current.staffId) throw ownOnly();
        return rescheduleAppointment(db, session.businessId, params.id, {
          startsAt: body.startsAt,
          staffId: body.staffId,
          allowOutsideHours: body.allowOutsideHours,
        });
      },
    ),

    route(
      { method: "POST", path: "/appointments/:id/assign", auth: "user", roles: DESK, params: IdParams, body: AssignBody },
      async ({ session, params, body }) => {
        await accessibleAppointment(db, session, params.id);
        return reassignStaff(db, session.businessId, params.id, body.staffId);
      },
    ),

    route(
      { method: "GET", path: "/clients/:id/appointments", auth: "user", params: IdParams, query: HistoryQuery },
      async ({ session, params, query }) => {
        const client = await getClient(db, session.businessId, params.id);
        if (!client) throw new HttpError(404, "No encontramos ese cliente.", "not_found");
        const own = await ownStaffId(db, session);
        if (own === null) return { items: [], nextCursor: null };
        return listClientAppointments(db, session.businessId, params.id, {
          limit: query.limit,
          cursor: query.cursor ?? null,
          staffId: own ?? null,
          locationIds: session.locationIds === "all" ? null : session.locationIds,
        });
      },
    ),

    route({ method: "GET", path: "/home/today", auth: "user", roles: DESK, location: "optional" }, ({ session, locationId }) =>
      getHomeToday(db, session.businessId, { locationIds: visibleLocations(session, locationId), locationId, countConversationsWaiting }),
    ),
  ];
}
