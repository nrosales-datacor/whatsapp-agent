import { z } from "zod";
import type { ClientsTier, PlanFeature } from "../../platform/plan/planHooks";
import { PLANS as PLAN_IDS, type ExtraModules, type Plan } from "../business";

// ─────────────────────────────────────────────────────────────────────────────
// Catálogo de planes (PLAN-GESTION.md §5). Dos planes:
//
//   • Básico — el agente de WhatsApp con lo mínimo para operar alrededor de él: agenda,
//     ficha automática de clientes (nivel `basic`) y WhatsApp IA. 1 sucursal, hasta 3
//     profesionales y 2 usuarios (dueño y recepción), con tope mensual de conversaciones
//     del agente.
//   • Pro — la gestión completa: todos los módulos, CRM de clientes (nivel `full`), marca
//     propia. Sucursales, profesionales y usuarios POR CANTIDAD CONTRATADA: el plan trae una
//     base y el superadmin carga lo contratado en `extra_modules.limits`.
//   • Pro sin agente — Pro con `whatsapp` apagado en `extra_modules.modules`. Los
//     recordatorios siguen disponibles (son de la agenda, módulo `scheduling`).
//
// `extra_modules` (jsonb de `businesses`, tipado acá con Zod):
//   { modules?: { campaigns: true, whatsapp: false }, limits?: { staff: 8, aiConversations: null } }
// `true` suma un módulo que el plan no trae, `false` apaga uno que sí trae; un límite
// reemplaza el del plan (null = sin tope). Lo que no está, sale del plan.
//
// Topes del agente: conversaciones por mes (el límite comercial, se le muestra al negocio)
// y gasto de LLM por mes en USD (red de seguridad contra un costo desbocado: un bucle con
// otro autorespondedor es UNA conversación y miles de llamadas pagadas; no se le vende ni
// se le muestra). Los defaults salen del entorno; cambiarlos pide reiniciar el proceso.
// ─────────────────────────────────────────────────────────────────────────────

/** Todos los módulos que una ruta puede declarar en `module` (y que el panel muestra u oculta). */
export const MODULES = ["scheduling", "clients", "sales", "commissions", "reports", "whatsapp", "campaigns"] as const;
export type ModuleName = (typeof MODULES)[number];

export { PLAN_IDS };

export function isModuleName(value: string): value is ModuleName {
  return (MODULES as readonly string[]).includes(value);
}

/** Límites de un plan. null = sin tope. */
export interface PlanLimits {
  /** Sucursales activas. */
  locations: number | null;
  /** Profesionales activos. */
  staff: number | null;
  /** Usuarios del panel (membresías activas, invitaciones pendientes incluidas). */
  users: number | null;
  /** Conversaciones del agente por mes. */
  aiConversations: number | null;
  /** Gasto de LLM del agente por mes, en USD. Interno: no se le muestra al negocio. */
  aiLlmUsd: number | null;
}

export const LIMIT_KEYS = ["locations", "staff", "users", "aiConversations", "aiLlmUsd"] as const satisfies readonly (keyof PlanLimits)[];

export interface PlanDefinition {
  id: Plan;
  /** Nombre comercial. */
  label: string;
  /** Nivel de la ficha de clientes (y del Inicio): `basic` o `full`. */
  clientsTier: ClientsTier;
  modules: readonly ModuleName[];
  features: readonly PlanFeature[];
  limits: PlanLimits;
}

type Env = Record<string, string | undefined>;

/** Entero ≥ 0 del entorno (vacío o inválido = default). */
function intFromEnv(name: string, fallback: number, env: Env): number {
  const raw = env[name]?.trim();
  const n = raw ? Number(raw) : NaN;
  return Number.isInteger(n) && n >= 0 ? n : fallback;
}

/** Número ≥ 0 del entorno, con decimales (USD). */
function numberFromEnv(name: string, fallback: number, env: Env): number {
  const raw = env[name]?.trim();
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** Arma el catálogo con los topes del entorno (`env` inyectable para los tests). */
export function buildPlans(env: Env = process.env): Record<Plan, PlanDefinition> {
  return {
    basic: {
      id: "basic",
      label: "Básico",
      clientsTier: "basic",
      modules: ["scheduling", "clients", "whatsapp"],
      features: [],
      limits: {
        locations: 1,
        staff: 3,
        users: 2,
        aiConversations: intFromEnv("PLAN_BASIC_AI_CONVERSATIONS", 500, env),
        aiLlmUsd: numberFromEnv("PLAN_BASIC_AI_LLM_USD", 15, env),
      },
    },
    pro: {
      id: "pro",
      label: "Pro",
      clientsTier: "full",
      modules: MODULES,
      features: ["branding"],
      // Base incluida en el precio del Pro; lo contratado de más va en extra_modules.limits.
      limits: {
        locations: 1,
        staff: 5,
        users: 8,
        aiConversations: intFromEnv("PLAN_PRO_AI_CONVERSATIONS", 3000, env),
        aiLlmUsd: numberFromEnv("PLAN_PRO_AI_LLM_USD", 40, env),
      },
    },
  };
}

/** Catálogo del proceso. */
export const PLANS: Record<Plan, PlanDefinition> = buildPlans();

/** "Pro sin agente": lo que se guarda en `extra_modules` para venderlo. */
export const PRO_WITHOUT_AGENT: Readonly<ExtraModulesInput> = Object.freeze({ modules: { whatsapp: false } });

// ── extra_modules con Zod ───────────────────────────────────────────────────

const Count = (min: number, max: number) => z.number().int().min(min).max(max).nullable();

/** Cupos contratados que reemplazan los del plan (null = sin tope). */
export const LimitOverridesSchema = z
  .object({
    locations: Count(1, 500),
    staff: Count(0, 5_000),
    users: Count(1, 5_000),
    aiConversations: Count(0, 10_000_000),
    aiLlmUsd: z.number().min(0).max(100_000).nullable(),
  })
  .partial()
  .strict();

/** Módulos sueltos: `true` suma, `false` apaga. Solo módulos conocidos. */
export const ModuleOverridesSchema = z.partialRecord(z.enum(MODULES), z.boolean());

export const ExtraModulesSchema = z
  .object({ modules: ModuleOverridesSchema.optional(), limits: LimitOverridesSchema.optional() })
  .strict();

export type ModuleOverrides = z.output<typeof ModuleOverridesSchema>;
export type LimitOverrides = z.output<typeof LimitOverridesSchema>;
export type ExtraModulesInput = z.output<typeof ExtraModulesSchema>;

/** Lo validado se guarda en la columna, tipada en business (que no conoce el catálogo). */
export function toStoredExtraModules(input: ExtraModulesInput): ExtraModules {
  return input;
}

/**
 * Lee `extra_modules` tal como está en la base, SIN fallar: un módulo desconocido o un
 * valor inválido se ignora (y cae al default del plan) en vez de dejar al negocio sin
 * servicio por un dato mal cargado. Lo que entra por la API se valida estricto con
 * `ExtraModulesSchema`.
 */
export function readExtraModules(raw: unknown): { modules: ModuleOverrides; limits: LimitOverrides } {
  const out: { modules: ModuleOverrides; limits: LimitOverrides } = { modules: {}, limits: {} };
  if (!raw || typeof raw !== "object") return out;
  const { modules, limits } = raw as { modules?: unknown; limits?: unknown };
  if (modules && typeof modules === "object") {
    for (const [key, value] of Object.entries(modules)) {
      if (isModuleName(key) && typeof value === "boolean") out.modules[key] = value;
    }
  }
  if (limits && typeof limits === "object") {
    const shape = LimitOverridesSchema.shape;
    for (const key of LIMIT_KEYS) {
      if (!Object.prototype.hasOwnProperty.call(limits, key)) continue;
      const parsed = shape[key].safeParse((limits as Record<string, unknown>)[key]);
      if (parsed.success && parsed.data !== undefined) out.limits[key] = parsed.data;
    }
  }
  return out;
}

/**
 * Lo que se guarda en `extra_modules` para un plan: sin los módulos que no cambian nada
 * (sumar uno que el plan ya trae, apagar uno que no trae) y sin claves vacías. Los límites
 * se guardan tal cual (son lo contratado, aunque hoy coincidan con el plan).
 */
export function normalizeExtraModules(plan: Plan, input: { modules?: ModuleOverrides; limits?: LimitOverrides }): ExtraModulesInput {
  const included = new Set<string>(PLANS[plan].modules);
  const modules: ModuleOverrides = {};
  for (const [key, value] of Object.entries(input.modules ?? {}) as [ModuleName, boolean | undefined][]) {
    if (value === undefined) continue;
    if (value !== included.has(key)) modules[key] = value;
  }
  const limits: LimitOverrides = {};
  for (const key of LIMIT_KEYS) {
    const value = input.limits?.[key];
    if (value !== undefined) limits[key] = value;
  }
  const out: ExtraModulesInput = {};
  if (Object.keys(modules).length > 0) out.modules = modules;
  if (Object.keys(limits).length > 0) out.limits = limits;
  return out;
}
