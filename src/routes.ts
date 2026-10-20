import { adminRoutes } from "./admin/routes";
import { businessRoutes, type LocationReferenceCheck } from "./modules/business";
import { isLocationAssigned, teamRoutes, type EnabledModules } from "./modules/team";
import type { Executor } from "./platform/db/scope";
import type { Route } from "./platform/http/routeTypes";
import { systemRoutes } from "./platform/http/systemRoutes";

// ─────────────────────────────────────────────────────────────────────────────
// Punto ÚNICO de composición de la API del panel (/api/panel/*).
//
// Cada módulo exporta una función que recibe sus dependencias y devuelve su lista de
// rutas declaradas con `route()` (src/platform/http/router.ts), con rutas relativas al
// prefijo (`/appointments/:id`, no `/api/panel/appointments/:id`). Acá se juntan todas;
// `createRouter` rechaza al arrancar dos rutas con el mismo método y forma.
//
//   // src/modules/scheduling/routes.ts
//   export function schedulingRoutes({ db }: RouteDeps): Route[] {
//     return [route({ method: "GET", path: "/appointments", auth: "user", location: "required" }, …)];
//   }
//
//   // acá
//   ...schedulingRoutes(deps),
// ─────────────────────────────────────────────────────────────────────────────

/** Dependencias que reciben las rutas de los módulos. */
export interface RouteDeps {
  db: Executor;
  /** Módulos del plan de un negocio (provisional hasta I2, ver src/planModules.ts). */
  enabledModules: EnabledModules;
}

/**
 * Borrar una sucursal: business no ve las tablas de team, así que se le pregunta acá si un
 * miembro está limitado a ella (en ese caso se desactiva en vez de borrarse).
 */
const isLocationReferenced: LocationReferenceCheck = (executor, businessId, locationId) =>
  isLocationAssigned(executor, businessId, locationId);

export function panelRoutes(deps: RouteDeps): Route[] {
  return [
    ...systemRoutes(),
    // Identidad y equipo: /auth/* y /team/*.
    ...teamRoutes(deps),
    // Configuración (I1): /settings/business y /settings/locations.
    ...businessRoutes({ db: deps.db, isLocationReferenced }),
    // Superadmin: /admin/*.
    ...adminRoutes(deps),
  ];
}
