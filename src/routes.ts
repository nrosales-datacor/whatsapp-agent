import { adminRoutes } from "./admin/routes";
import { businessRoutes, type LocationReferenceCheck } from "./modules/business";
import { clientsRoutes } from "./modules/clients";
import { catalogRoutes, isLocationRestrictingServices } from "./modules/catalog";
import { schedulingRoutes } from "./modules/scheduling";
import { isLocationAssigned, staffRoutes, teamRoutes, type EnabledModules } from "./modules/team";
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
 * Borrar una sucursal: business no ve las tablas de team ni de catalog, así que se le
 * pregunta acá si un miembro está limitado a ella o un servicio se ofrece solo ahí (en
 * ese caso se desactiva en vez de borrarse).
 */
const isLocationReferenced: LocationReferenceCheck = async (executor, businessId, locationId) =>
  (await isLocationAssigned(executor, businessId, locationId)) || (await isLocationRestrictingServices(executor, businessId, locationId));

export function panelRoutes(deps: RouteDeps): Route[] {
  return [
    ...systemRoutes(),
    // Identidad y equipo: /auth/* y /team/*.
    ...teamRoutes(deps),
    // Configuración (I1): /settings/business, /settings/locations, /settings/services,
    // /settings/service-categories, /settings/staff y /settings/time-off.
    ...businessRoutes({ db: deps.db, isLocationReferenced }),
    ...catalogRoutes(deps),
    ...staffRoutes(deps),
    // Superadmin: /admin/*.
    ...adminRoutes(deps),
    // Clientes: /clients/*. Los módulos de afuera del núcleo suman acá sus borradores de
    // datos personales para la anonimización (WhatsApp en I2).
    ...clientsRoutes({ db: deps.db, clientErasers: [] }),
    // Agenda e Inicio básico (I1): /availability, /appointments/*, /clients/:id/appointments
    // y /home/today.
    ...schedulingRoutes(deps),
  ];
}
