import { z } from "zod";
import type { Executor } from "../../platform/db/scope";
import { MANAGER_ROLES } from "../../platform/http/access";
import { created, route } from "../../platform/http/router";
import type { Route } from "../../platform/http/routeTypes";
import type { PlanHooks } from "../../platform/plan/planHooks";
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
//
// Plan (inyectado desde modules/billing por la composición): la marca propia solo en Pro
// y el cupo de sucursales activas al crear o reactivar una (403 `plan_limit_reached`).
// ─────────────────────────────────────────────────────────────────────────────

export interface BusinessRouteDeps {
  db: Executor;
  /** ¿Otro módulo depende de esta sucursal? (ver `LocationReferenceCheck`). */
  isLocationReferenced: LocationReferenceCheck;
  /** Plan del negocio: marca propia y cupo de sucursales. */
  plans: Pick<PlanHooks, "quota" | "hasFeature">;
}

const IdParams = z.object({ id: z.uuid() });

export function businessRoutes({ db, isLocationReferenced, plans }: BusinessRouteDeps): Route[] {
  const brandingEditable = (businessId: string) => plans.hasFeature(businessId, "branding");
  return [
    route({ method: "GET", path: "/settings/business", auth: "user" }, async ({ session }) =>
      getBusinessSettings(db, session, await brandingEditable(session.businessId)),
    ),

    route(
      { method: "PATCH", path: "/settings/business", auth: "user", roles: MANAGER_ROLES, body: BusinessSettingsPatch },
      async ({ session, body }) => updateBusinessSettings(db, session, body, await brandingEditable(session.businessId)),
    ),

    route({ method: "GET", path: "/settings/locations", auth: "user" }, ({ session }) => listLocationsForSession(db, session)),

    route(
      { method: "POST", path: "/settings/locations", auth: "user", roles: MANAGER_ROLES, body: NewLocationInput },
      async ({ session, body }) => created(await createLocation(db, session, body, await plans.quota(session.businessId, "locations"))),
    ),

    route(
      { method: "PATCH", path: "/settings/locations/:id", auth: "user", roles: MANAGER_ROLES, params: IdParams, body: LocationPatch },
      async ({ session, params, body }) =>
        updateLocation(db, session, params.id, body, body.active === true ? await plans.quota(session.businessId, "locations") : null),
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
