import { listConfigHistory } from "./platform/audit/configHistory";
import type { Executor } from "./platform/db/scope";
import { HttpError } from "./platform/http/errors";
import { route } from "./platform/http/router";
import type { Route } from "./platform/http/routeTypes";
import type { PlanHooks } from "./platform/plan/planHooks";
import { dismissOnboarding, getBusinessContext } from "./modules/business";
import { listAppointments } from "./modules/scheduling";
import { countActiveStaff } from "./modules/team";
import { isWhatsAppConnected } from "./modules/whatsapp";

// ─────────────────────────────────────────────────────────────────────────────
// Checklist de primeros pasos del Inicio (I6) para los negocios nuevos: lo mínimo para
// empezar a usar el panel. Vive en la composición (como src/signup.ts) porque junta
// business, catalog, team, scheduling, WhatsApp y el plan. Cada paso se detecta solo, con
// datos que ya existen:
//
//   hours              revisó el horario: algún cambio guardado en Configuración ›
//                      Sucursales (historial de configuración `location`).
//   services           revisó servicios y precios: algún cambio en Configuración › Servicios
//                      (la plantilla del rubro ya trae ejemplos; editarlos cuenta).
//   team               cargó al menos un profesional activo.
//   whatsapp           conectó un número de WhatsApp (solo si el plan trae WhatsApp IA).
//   first_appointment  agendó su primera cita.
//
//   GET  /onboarding          dueño y admin: pasos y si se muestra
//   POST /onboarding/dismiss  dueño y admin: ocultarla
//
// Se muestra mientras no esté completa ni oculta; completarla también la oculta.
// ─────────────────────────────────────────────────────────────────────────────

export const ONBOARDING_STEPS = ["hours", "services", "team", "whatsapp", "first_appointment"] as const;
export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];

export interface OnboardingView {
  /** ¿Se muestra en el Inicio? (ni completa ni oculta). */
  visible: boolean;
  dismissed: boolean;
  completed: boolean;
  /** Pasos que aplican al negocio (WhatsApp solo si el plan lo trae), en orden. */
  steps: { id: OnboardingStep; done: boolean }[];
}

export interface OnboardingDeps {
  db: Executor;
  plans: Pick<PlanHooks, "enabledModules">;
  /** ¿Tiene un número de WhatsApp conectado? Default: el del módulo WhatsApp. */
  isWhatsAppConnected?: (db: Executor, businessId: string) => Promise<boolean>;
}

const SERVICE_ENTITIES = ["service", "service_category", "services_order", "service_categories_order"];

async function hasConfigChange(db: Executor, businessId: string, entities: readonly string[]): Promise<boolean> {
  for (const entity of entities) {
    if ((await listConfigHistory(db, businessId, { entity, limit: 1 })).length > 0) return true;
  }
  return false;
}

async function hasAnyAppointment(db: Executor, businessId: string): Promise<boolean> {
  const rows = await listAppointments(db, businessId, { from: new Date(0), to: new Date("9999-12-31T00:00:00Z"), limit: 1 });
  return rows.length > 0;
}

export async function getOnboarding(deps: OnboardingDeps, businessId: string): Promise<OnboardingView> {
  const { db } = deps;
  const ctx = await getBusinessContext(db, businessId);
  if (!ctx) throw new HttpError(404, "Negocio no encontrado.", "not_found");
  const dismissed = ctx.business.onboardingDismissedAt !== null;
  const withWhatsapp = (await deps.plans.enabledModules(businessId)).includes("whatsapp");
  const whatsappConnected = deps.isWhatsAppConnected ?? isWhatsAppConnected;

  const [hours, services, staff, whatsapp, firstAppointment] = await Promise.all([
    hasConfigChange(db, businessId, ["location"]),
    hasConfigChange(db, businessId, SERVICE_ENTITIES),
    countActiveStaff(db, businessId),
    withWhatsapp ? whatsappConnected(db, businessId) : Promise.resolve(false),
    hasAnyAppointment(db, businessId),
  ]);
  const done: Record<OnboardingStep, boolean> = { hours, services, team: staff > 0, whatsapp, first_appointment: firstAppointment };
  const steps = ONBOARDING_STEPS.filter((id) => id !== "whatsapp" || withWhatsapp).map((id) => ({ id, done: done[id] }));
  const completed = steps.every((s) => s.done);
  return { visible: !dismissed && !completed, dismissed, completed, steps };
}

const MANAGERS = ["owner", "admin"] as const;

export function onboardingRoutes(deps: OnboardingDeps): Route[] {
  return [
    route({ method: "GET", path: "/onboarding", auth: "user", roles: MANAGERS }, ({ session }) => getOnboarding(deps, session.businessId)),

    route({ method: "POST", path: "/onboarding/dismiss", auth: "user", roles: MANAGERS }, async ({ session }) => {
      await dismissOnboarding(deps.db, session.businessId);
      return getOnboarding(deps, session.businessId);
    }),
  ];
}
