import { z } from "zod";
import type { Executor } from "../../platform/db/scope";
import { MANAGER_ROLES } from "../../platform/http/access";
import { created, route } from "../../platform/http/router";
import type { Route } from "../../platform/http/routeTypes";
import { BusinessSettingsPatch, getBusinessSettings, updateBusinessSettings } from "./businessSettings";
import {
  createLocation,
  deleteLocation,
  listLocationsForSession,
  LocationHoursInput,
  LocationPatch,
  NewLocationInput,
  replaceLocationHours,
  updateLocation,
  type LocationReferenceCheck,
} from "./locations";

// ─────────────────────────────────────────────────────────────────────────────
// Rutas de Configuración del módulo business (I1):
//
//   GET    /settings/business                negocio (todos los roles; datos legales solo dueño/admin)
//   PATCH  /settings/business                dueño, admin
//   GET    /settings/locations               sucursales con su horario (todos los roles)
//   POST   /settings/locations               dueño, admin (con acceso a todas las sucursales)
//   PATCH  /settings/locations/:id           dueño, admin
//   PUT    /settings/locations/:id/hours     dueño, admin (reemplaza el horario semanal)
//   DELETE /settings/locations/:id           dueño, admin (con historial: se desactiva)
// ─────────────────────────────────────────────────────────────────────────────

export interface BusinessRouteDeps {
  db: Executor;
  /** ¿Otro módulo depende de esta sucursal? (ver `LocationReferenceCheck`). */
  isLocationReferenced: LocationReferenceCheck;
}

const IdParams = z.object({ id: z.uuid() });

export function businessRoutes({ db, isLocationReferenced }: BusinessRouteDeps): Route[] {
  return [
    route({ method: "GET", path: "/settings/business", auth: "user" }, ({ session }) => getBusinessSettings(db, session)),

    route(
      { method: "PATCH", path: "/settings/business", auth: "user", roles: MANAGER_ROLES, body: BusinessSettingsPatch },
      ({ session, body }) => updateBusinessSettings(db, session, body),
    ),

    route({ method: "GET", path: "/settings/locations", auth: "user" }, ({ session }) => listLocationsForSession(db, session)),

    route(
      { method: "POST", path: "/settings/locations", auth: "user", roles: MANAGER_ROLES, body: NewLocationInput },
      async ({ session, body }) => created(await createLocation(db, session, body)),
    ),

    route(
      { method: "PATCH", path: "/settings/locations/:id", auth: "user", roles: MANAGER_ROLES, params: IdParams, body: LocationPatch },
      ({ session, params, body }) => updateLocation(db, session, params.id, body),
    ),

    route(
      { method: "PUT", path: "/settings/locations/:id/hours", auth: "user", roles: MANAGER_ROLES, params: IdParams, body: LocationHoursInput },
      ({ session, params, body }) => replaceLocationHours(db, session, params.id, body.hours),
    ),

    route(
      { method: "DELETE", path: "/settings/locations/:id", auth: "user", roles: MANAGER_ROLES, params: IdParams },
      ({ session, params }) => deleteLocation(db, session, params.id, isLocationReferenced),
    ),
  ];
}
