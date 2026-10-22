import { adminRoutes } from "./admin/routes";
import type { PlanService } from "./modules/billing";
import { businessRoutes, clientSettingsRoutes, type LocationReferenceCheck } from "./modules/business";
import { clientsRoutes } from "./modules/clients";
import { catalogRoutes, isLocationRestrictingServices } from "./modules/catalog";
import { clientIdsWithStaffAppointments, schedulingRoutes } from "./modules/scheduling";
import { isLocationAssigned, staffRoutes, teamRoutes } from "./modules/team";
import {
  countConversationsWaiting,
  createWhatsAppDeps,
  whatsappClientEraser,
  whatsappRoutes,
  whatsappSettingsRoutes,
  type WhatsAppDeps,
} from "./modules/whatsapp";
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
  /**
   * Planes (src/modules/billing): el núcleo lo recibe como `PlanHooks` (cupos, marca
   * propia, `me.plan`) sin importar billing; el superadmin usa el servicio completo.
   */
  plans: PlanService;
  /** Dependencias del módulo WhatsApp (Graph, Storage, push…). Default: las reales. */
  whatsapp?: WhatsAppDeps;
}

/**
 * Borrar una sucursal: business no ve las tablas de team ni de catalog, así que se le
 * pregunta acá si un miembro está limitado a ella o un servicio se ofrece solo ahí (en
 * ese caso se desactiva en vez de borrarse).
 */
const isLocationReferenced: LocationReferenceCheck = async (executor, businessId, locationId) =>
  (await isLocationAssigned(executor, businessId, locationId)) || (await isLocationRestrictingServices(executor, businessId, locationId));

export function panelRoutes(deps: RouteDeps): Route[] {
  const whatsapp = deps.whatsapp ?? createWhatsAppDeps(deps.db);
  return [
    ...systemRoutes(),
    // Identidad y equipo: /auth/* y /team/*.
    ...teamRoutes(deps),
    // Configuración (I1): /settings/business, /settings/locations, /settings/services,
    // /settings/service-categories, /settings/staff y /settings/time-off.
    ...businessRoutes({ db: deps.db, isLocationReferenced, plans: deps.plans }),
    // Configuración del CRM de clientes (I3, Pro): /settings/client-rules y /settings/custom-fields.
    ...clientSettingsRoutes({ db: deps.db, plans: deps.plans }),
    ...catalogRoutes(deps),
    ...staffRoutes(deps),
    // Superadmin: /admin/*.
    ...adminRoutes(deps),
    // Clientes: /clients/*. Los módulos de afuera del núcleo suman acá sus borradores de
    // datos personales para la anonimización (WhatsApp: conversaciones y mensajes). "Mis
    // clientes" del profesional: la subconsulta de sus citas la arma scheduling.
    ...clientsRoutes({
      db: deps.db,
      plans: deps.plans,
      clientErasers: [whatsappClientEraser],
      staffClients: clientIdsWithStaffAppointments,
    }),
    // Agenda e Inicio básico (I1): /availability, /appointments/*, /clients/:id/appointments
    // y /home/today (con las conversaciones esperando a una persona, del módulo WhatsApp).
    ...schedulingRoutes({ db: deps.db, countConversationsWaiting, plans: deps.plans }),
    // WhatsApp IA (I2): canales, bandeja, resumen, métricas y push (/whatsapp/*, /push/*) y
    // el alta manual de un número del superadmin (/admin/businesses/:id/whatsapp).
    ...whatsappRoutes({ db: deps.db, deps: whatsapp }),
    // WhatsApp IA > Configuración del agente (I2): /whatsapp/settings.
    ...whatsappSettingsRoutes(deps),
  ];
}
