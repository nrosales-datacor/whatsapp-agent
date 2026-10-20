import { adminRoutes } from "./admin/routes";
import { teamRoutes, type EnabledModules } from "./modules/team";
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

export function panelRoutes(deps: RouteDeps): Route[] {
  return [
    ...systemRoutes(),
    // Identidad y equipo: /auth/* y /team/*.
    ...teamRoutes(deps),
    // Superadmin: /admin/*.
    ...adminRoutes(deps),
  ];
}
