import { listConfigHistory } from "../../platform/audit/configHistory";
import type { Executor } from "../../platform/db/scope";
import { HttpError } from "../../platform/http/errors";
import { dismissOnboarding, getBusinessContext } from "../business";
import { listAppointments } from "../scheduling";
import { countActiveStaff } from "../team";

// ─────────────────────────────────────────────────────────────────────────────
// Checklist de primeros pasos del Inicio (I6) para los negocios nuevos: lo mínimo para
// empezar a usar el panel. Cada paso se detecta solo, con datos que ya existen:
//
//   hours              revisó el horario: algún cambio guardado en Configuración ›
//                      Sucursales (historial de configuración `location`).
//   services           revisó servicios y precios: algún cambio en Configuración › Servicios
//                      (la plantilla del rubro ya trae ejemplos; editarlos cuenta).
//   team               cargó al menos un profesional activo.
//   whatsapp           conectó un número de WhatsApp (solo si el plan trae WhatsApp IA).
//   first_appointment  agendó su primera cita.
//
// Se muestra a dueño y admin mientras no esté completa ni descartada; completarla la
// oculta. Los negocios que ya existían antes de I6 nacen con ella descartada (migración).
// WhatsApp no es del núcleo: la composición inyecta `isWhatsAppConnected` y los módulos
// del plan.
// ─────────────────────────────────────────────────────────────────────────────

export const ONBOARDING_STEPS = ["hours", "services", "team", "whatsapp", "first_appointment"] as const;
export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];

export interface OnboardingView {
  /** ¿Se muestra en el Inicio? (ni completa ni descartada). */
  visible: boolean;
  dismissed: boolean;
  completed: boolean;
  /** Pasos que aplican al negocio (WhatsApp solo si el plan lo trae), en orden. */
  steps: { id: OnboardingStep; done: boolean }[];
}

export interface ChecklistDeps {
  /** Módulos del plan del negocio (billing, inyectado). */
  enabledModules(businessId: string): Promise<readonly string[]>;
  /** ¿Tiene un número de WhatsApp conectado? (módulo WhatsApp, inyectado). */
  isWhatsAppConnected(db: Executor, businessId: string): Promise<boolean>;
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

export async function getOnboarding(db: Executor, businessId: string, deps: ChecklistDeps): Promise<OnboardingView> {
  const ctx = await getBusinessContext(db, businessId);
  if (!ctx) throw new HttpError(404, "Negocio no encontrado.", "not_found");
  const dismissed = ctx.business.onboardingDismissedAt !== null;
  const modules = await deps.enabledModules(businessId);
  const withWhatsapp = modules.includes("whatsapp");

  const [hours, services, staff, whatsapp, firstAppointment] = await Promise.all([
    hasConfigChange(db, businessId, ["location"]),
    hasConfigChange(db, businessId, SERVICE_ENTITIES),
    countActiveStaff(db, businessId),
    withWhatsapp ? deps.isWhatsAppConnected(db, businessId) : Promise.resolve(false),
    hasAnyAppointment(db, businessId),
  ]);
  const done: Record<OnboardingStep, boolean> = { hours, services, team: staff > 0, whatsapp, first_appointment: firstAppointment };
  const steps = ONBOARDING_STEPS.filter((id) => id !== "whatsapp" || withWhatsapp).map((id) => ({ id, done: done[id] }));
  const completed = steps.every((s) => s.done);
  return { visible: !dismissed && !completed, dismissed, completed, steps };
}

export async function dismissChecklist(db: Executor, businessId: string, deps: ChecklistDeps): Promise<OnboardingView> {
  await dismissOnboarding(db, businessId);
  return getOnboarding(db, businessId, deps);
}
