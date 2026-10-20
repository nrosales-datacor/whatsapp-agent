import { z } from "zod";
import type { Executor } from "../../platform/db/scope";
import { MANAGER_ROLES } from "../../platform/http/access";
import { created, noContent, route } from "../../platform/http/router";
import type { Route } from "../../platform/http/routeTypes";
import {
  createStaff,
  deleteStaff,
  listStaffViews,
  NewStaffInput,
  reorderStaff,
  replaceStaffHours,
  StaffHoursInput,
  StaffOrderInput,
  StaffPatch,
  updateStaff,
} from "./staff";
import { createTimeOff, deleteTimeOff, listTimeOff, NewTimeOffInput, TimeOffPatch, TimeOffQuery, updateTimeOff } from "./timeOff";

// ─────────────────────────────────────────────────────────────────────────────
// Rutas de Configuración > Equipo (I1): profesionales, su horario por sucursal y las
// ausencias. Leen todos los roles; editan dueño y administración.
//
//   GET    /settings/staff                 equipo con horario y usuario vinculado
//   POST   /settings/staff                 dueño, admin
//   PUT    /settings/staff/order           dueño, admin (orden de las columnas de la agenda)
//   PATCH  /settings/staff/:id             dueño, admin
//   PUT    /settings/staff/:id/hours       dueño, admin ({ locationId, hours }: una sucursal)
//   DELETE /settings/staff/:id             dueño, admin (con historial: se desactiva)
//   GET    /settings/time-off              ?from&to&locationId&staffId (default: hace 30 días → 1 año)
//   POST   /settings/time-off              dueño, admin
//   PATCH  /settings/time-off/:id          dueño, admin
//   DELETE /settings/time-off/:id          dueño, admin
//
// Los servicios que hace cada profesional (`/settings/staff/:id/services`) son tablas
// del catálogo: sus rutas viven en modules/catalog.
// ─────────────────────────────────────────────────────────────────────────────

export interface StaffRouteDeps {
  db: Executor;
}

const IdParams = z.object({ id: z.uuid() });
const DAY_MS = 24 * 60 * 60 * 1000;

export function staffRoutes({ db }: StaffRouteDeps): Route[] {
  return [
    route({ method: "GET", path: "/settings/staff", auth: "user" }, ({ session }) => listStaffViews(db, session.businessId)),

    route(
      { method: "POST", path: "/settings/staff", auth: "user", roles: MANAGER_ROLES, body: NewStaffInput },
      async ({ session, body }) => created(await createStaff(db, session, body)),
    ),

    route(
      { method: "PUT", path: "/settings/staff/order", auth: "user", roles: MANAGER_ROLES, body: StaffOrderInput },
      ({ session, body }) => reorderStaff(db, session, body.ids),
    ),

    route(
      { method: "PATCH", path: "/settings/staff/:id", auth: "user", roles: MANAGER_ROLES, params: IdParams, body: StaffPatch },
      ({ session, params, body }) => updateStaff(db, session, params.id, body),
    ),

    route(
      { method: "PUT", path: "/settings/staff/:id/hours", auth: "user", roles: MANAGER_ROLES, params: IdParams, body: StaffHoursInput },
      ({ session, params, body }) => replaceStaffHours(db, session, params.id, body),
    ),

    route(
      { method: "DELETE", path: "/settings/staff/:id", auth: "user", roles: MANAGER_ROLES, params: IdParams },
      ({ session, params }) => deleteStaff(db, session, params.id),
    ),

    route({ method: "GET", path: "/settings/time-off", auth: "user", query: TimeOffQuery }, ({ session, query }) => {
      const now = Date.now();
      return listTimeOff(db, session.businessId, {
        from: query.from ?? new Date(now - 30 * DAY_MS),
        to: query.to ?? new Date(now + 366 * DAY_MS),
        locationId: query.locationId,
        staffId: query.staffId,
      });
    }),

    route(
      { method: "POST", path: "/settings/time-off", auth: "user", roles: MANAGER_ROLES, body: NewTimeOffInput },
      async ({ session, body }) => created(await createTimeOff(db, session, body)),
    ),

    route(
      { method: "PATCH", path: "/settings/time-off/:id", auth: "user", roles: MANAGER_ROLES, params: IdParams, body: TimeOffPatch },
      ({ session, params, body }) => updateTimeOff(db, session, params.id, body),
    ),

    route(
      { method: "DELETE", path: "/settings/time-off/:id", auth: "user", roles: MANAGER_ROLES, params: IdParams },
      async ({ session, params }) => {
        await deleteTimeOff(db, session, params.id);
        return noContent();
      },
    ),
  ];
}
