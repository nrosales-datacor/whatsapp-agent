import type { ClientsTier, PlanFeature, PlanResource } from "../../platform/plan/planHooks";
import type { Business, Plan } from "../business";
import { MODULES, PLANS, readExtraModules, type LimitOverrides, type ModuleName, type ModuleOverrides, type PlanDefinition, type PlanLimits } from "./catalog";

// ─────────────────────────────────────────────────────────────────────────────
// Lo que un negocio puede usar según su plan + `extra_modules` (puro, sin I/O): módulos,
// funciones, nivel de clientes y límites efectivos. Lo usan el router (`moduleGate`), los
// cupos del núcleo, `me` y el pipeline del agente (`getAiLimits`), vía ./service.ts.
// ─────────────────────────────────────────────────────────────────────────────

export interface Entitlements {
  plan: Plan;
  /** "Básico", "Pro" o "Pro sin agente". */
  label: string;
  clientsTier: ClientsTier;
  /** Módulos habilitados, en el orden del catálogo. */
  modules: ModuleName[];
  features: PlanFeature[];
  /** Límites efectivos (lo contratado sobre el plan). */
  limits: PlanLimits;
  /** Lo contratado encima del plan, ya leído (sin lo inválido). */
  overrides: { modules: ModuleOverrides; limits: LimitOverrides };
  /** Estado del servicio del negocio (`active` | `paused` | `closed`). */
  status: string;
  billingStatus: string;
}

type PlanFields = Pick<Business, "plan" | "extraModules" | "status" | "billingStatus">;

/** Funciones que hace el agente de WhatsApp: sin el módulo (Pro sin agente) no aplican. */
const AGENT_FEATURES: ReadonlySet<PlanFeature> = new Set<PlanFeature>(["reviews", "quote_recovery", "upsell"]);

function definitionOf(plan: string, plans: Record<Plan, PlanDefinition>): PlanDefinition {
  // La base solo acepta planes conocidos (CHECK); un valor raro cae al Básico, nunca a más.
  return plan === "pro" ? plans.pro : plans.basic;
}

export function resolveEntitlements(business: PlanFields, plans: Record<Plan, PlanDefinition> = PLANS): Entitlements {
  const def = definitionOf(business.plan, plans);
  const overrides = readExtraModules(business.extraModules);
  const included = new Set<string>(def.modules);
  const modules = MODULES.filter((m) => overrides.modules[m] ?? included.has(m));
  const limits: PlanLimits = { ...def.limits };
  for (const [key, value] of Object.entries(overrides.limits) as [keyof PlanLimits, number | null | undefined][]) {
    if (value !== undefined) limits[key] = value;
  }
  const label = def.id === "pro" && !modules.includes("whatsapp") ? "Pro sin agente" : def.label;
  return {
    plan: def.id,
    label,
    clientsTier: def.clientsTier,
    modules,
    features: def.features.filter((f) => modules.includes("whatsapp") || !AGENT_FEATURES.has(f)),
    limits,
    overrides,
    status: business.status,
    billingStatus: business.billingStatus,
  };
}

/** Cupo de un recurso del núcleo (null = sin tope). */
export function quotaOf(entitlements: Entitlements, resource: PlanResource): number | null {
  return entitlements.limits[resource];
}
