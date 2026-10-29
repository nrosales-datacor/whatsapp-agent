import { adminRoutes } from "./admin/routes";
import { billingRoutes, type PlanService, type StripeConfig, type StripeGateway } from "./modules/billing";
import { businessRoutes, clientSettingsRoutes, type LocationReferenceCheck } from "./modules/business";
import { campaignsRoutes } from "./modules/campaigns";
import { clientsRoutes } from "./modules/clients";
import { catalogRoutes, isLocationRestrictingServices } from "./modules/catalog";
import { commissionsRoutes, recalculateAppointmentCommissions } from "./modules/commissions";
import { reportsRoutes } from "./modules/reports";
import { salesRoutes } from "./modules/sales";
import { clientIdsWithStaffAppointments, schedulingRoutes, type AppointmentBookedHook } from "./modules/scheduling";
import { isLocationAssigned, staffRoutes, teamRoutes } from "./modules/team";
import {
  closeQuotesForAppointment,
  countConversationsWaiting,
  createWhatsAppDeps,
  whatsappClientEraser,
  whatsappRoutes,
  whatsappSettingsRoutes,
  type WhatsAppDeps,
} from "./modules/whatsapp";
import { onboardingRoutes } from "./onboarding";
import type { Executor } from "./platform/db/scope";
import type { Route } from "./platform/http/routeTypes";
import { systemRoutes } from "./platform/http/systemRoutes";
import { growthFromPlan } from "./plans";
import { signupRoutes } from "./signup";
import { createUsageTracker, type UsageTracker } from "./usage";

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
  /** Métricas de producto en `daily_usage` (src/usage.ts). Default: uno nuevo. */
  usage?: UsageTracker;
  /** Cliente de Stripe (los tests pasan un doble). Default: el SDK real con la clave del entorno. */
  stripeGateway?: (config: StripeConfig) => StripeGateway;
}

/**
 * Borrar una sucursal: business no ve las tablas de team ni de catalog, así que se le
 * pregunta acá si un miembro está limitado a ella o un servicio se ofrece solo ahí (en
 * ese caso se desactiva en vez de borrarse).
 */
const isLocationReferenced: LocationReferenceCheck = async (executor, businessId, locationId) =>
  (await isLocationAssigned(executor, businessId, locationId)) || (await isLocationRestrictingServices(executor, businessId, locationId));

/**
 * Comisiones sobre lo cobrado (I4): se recalculan al completar una cita y con cada cobro o
 * devolución de una cita, en la misma transacción. commissions depende de scheduling y de
 * sales (lee la cita y lo cobrado); ninguno de los dos la conoce, así que el recálculo se
 * les inyecta acá como gancho (sin ciclos entre módulos).
 */
const onCommissionableChange = (tx: Executor, businessId: string, appointmentId: string) =>
  recalculateAppointmentCommissions(tx, businessId, appointmentId);

/**
 * Cita agendada desde el panel: suma a `daily_usage` y cierra las cotizaciones abiertas del
 * cliente por esos servicios (rescate de cotizaciones, I6: si agendó por teléfono o en el
 * mostrador después del toque, el rescate igual cuenta). scheduling no conoce WhatsApp.
 */
function panelBookedHook(usage: UsageTracker): AppointmentBookedHook {
  return async (executor, businessId, appointment) => {
    await usage.appointmentBooked(executor, businessId, appointment);
    await closeQuotesForAppointment(executor, businessId, appointment);
  };
}

export function panelRoutes(deps: RouteDeps): Route[] {
  const whatsapp = deps.whatsapp ?? createWhatsAppDeps(deps.db);
  const usage = deps.usage ?? createUsageTracker();
  return [
    ...systemRoutes(),
    // Identidad y equipo: /auth/* y /team/* (cada login suma a `daily_usage`).
    ...teamRoutes({ db: deps.db, plans: deps.plans, onLogin: usage.login }),
    // Configuración (I1): /settings/business, /settings/locations, /settings/services,
    // /settings/service-categories, /settings/staff y /settings/time-off.
    ...businessRoutes({ db: deps.db, isLocationReferenced, plans: deps.plans }),
    // Configuración del CRM de clientes (I3, Pro): /settings/client-rules y /settings/custom-fields.
    ...clientSettingsRoutes({ db: deps.db, plans: deps.plans }),
    ...catalogRoutes(deps),
    ...staffRoutes(deps),
    // Superadmin: /admin/*.
    ...adminRoutes(deps),
    // Alta self-service (I6.7, detrás de SIGNUP_ENABLED): /auth/signup y su config pública.
    ...signupRoutes({ db: deps.db }),
    // Primeros pasos del Inicio (I6, dueño y admin): /onboarding y /onboarding/dismiss.
    ...onboardingRoutes({ db: deps.db, plans: deps.plans }),
    // Suscripción por Stripe (I6.6, solo el dueño): /billing/status, /billing/checkout y
    // /billing/portal. Sin Stripe configurado, el cobro sigue manual. Con el negocio pausado
    // por falta de pago siguen andando: es como la dueña paga y lo reactiva.
    ...billingRoutes({ db: deps.db, stripeGateway: deps.stripeGateway }),
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
    // Cada cita creada suma a `daily_usage`.
    ...schedulingRoutes({
      db: deps.db,
      countConversationsWaiting,
      plans: deps.plans,
      onAppointmentCompleted: onCommissionableChange,
      onAppointmentBooked: panelBookedHook(usage),
    }),
    // Ventas (I4, Pro): métodos de pago, cobros y señas, devoluciones, pendientes y caja
    // (/settings/payment-methods, /appointments/:id/payments|balance, /sales/*). Cada seña o
    // cobro suma a `daily_usage`.
    ...salesRoutes({ db: deps.db, onPaymentsChanged: onCommissionableChange, onPaymentRecorded: usage.paymentRecorded }),
    // Comisiones (I4, Pro): reglas, movimientos, resumen y liquidaciones
    // (/settings/commission-rules, /commissions/*).
    ...commissionsRoutes({ db: deps.db }),
    // Reportes e Inicio completo (I5, Pro): /reports/* (con su .csv) y /home/overview.
    ...reportsRoutes({ db: deps.db, countConversationsWaiting }),
    // WhatsApp IA (I2): canales, bandeja, resumen, métricas y push (/whatsapp/*, /push/*) y
    // el alta manual de un número del superadmin (/admin/businesses/:id/whatsapp).
    ...whatsappRoutes({ db: deps.db, deps: whatsapp }),
    // WhatsApp IA > Configuración del agente (I2): /whatsapp/settings, y crecimiento (I6):
    // /whatsapp/growth con lo que permite el plan.
    ...whatsappSettingsRoutes({ db: deps.db, getGrowth: growthFromPlan(deps.plans) }),
    // Campañas (I6, módulo `campaigns`): /campaigns/*.
    ...campaignsRoutes({ db: deps.db }),
  ];
}
