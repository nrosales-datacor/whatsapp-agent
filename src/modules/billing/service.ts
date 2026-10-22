import type { Executor } from "../../platform/db/scope";
import { HttpError } from "../../platform/http/errors";
import type { ModuleGate } from "../../platform/http/routeTypes";
import type { PlanFeature, PlanHooks, PlanResource, PlanSnapshot, PlanUsageView } from "../../platform/plan/planHooks";
import { countActiveLocationsOf, getBusinessContext, type Business } from "../business";
import { countActiveMembers, countActiveStaff } from "../team";
import type { PlanLimits } from "./catalog";
import { quotaOf, resolveEntitlements, type Entitlements } from "./entitlements";

// ─────────────────────────────────────────────────────────────────────────────
// Servicio de planes: lo que la composición inyecta al router (`moduleGate`), al núcleo
// (`PlanHooks`: cupos, marca propia, `me.plan`), a la cola (`canRunJob`) y al pipeline del
// agente de WhatsApp (`getAiLimits`).
//
// Caché: la fila del negocio sale del caché del contexto (`getBusinessContext`: LRU con TTL
// corto BUSINESS_CACHE_TTL_MS, una lectura en vuelo por negocio, invalidado al instante en
// el proceso que cambia el plan). Lo resuelto se memoiza por fila (WeakMap): mientras el
// contexto no venza, resolver el plan de un request es un lookup, sin otra consulta ni una
// segunda capa de caché que sume su propio TTL de atraso.
//
// Uso del agente del mes: lo mide el módulo WhatsApp (`ai_usage_monthly`, su tabla). Billing
// no lee tablas ajenas: la composición le pasa `aiUsage`; sin él, el uso sale null.
// ─────────────────────────────────────────────────────────────────────────────

/** Uso del agente de un negocio en un mes (`YYYY-MM`), o null si no hay datos. */
export type AiUsageReader = (businessId: string, month: string) => Promise<{ conversations: number; llmCostUsdMicros: number } | null>;

/** Topes del agente de WhatsApp para un negocio (lo consulta el pipeline antes de cada turno). */
export interface AiLimits {
  /** ¿El agente puede atender? Negocio activo y con el módulo `whatsapp` en su plan. */
  agentEnabled: boolean;
  /** Por qué no (null si puede). */
  disabledReason: "business_not_found" | "business_paused" | "business_closed" | "module_not_in_plan" | null;
  /** Plan del negocio (null si no existe). */
  plan: string | null;
  /** Conversaciones del agente por mes; null = sin tope. */
  monthlyConversations: number | null;
  /** Gasto de LLM por mes en MILLONÉSIMOS de USD (misma unidad que `ai_usage_monthly`); null = sin tope. */
  monthlyLlmCostUsdMicros: number | null;
}

/** Firma inyectable de `getAiLimits` (la usa el pipeline de WhatsApp). */
export type GetAiLimits = (businessId: string) => Promise<AiLimits>;

export interface PlanServiceOptions {
  /** Lee la fila del negocio. Default: el caché del contexto (TTL corto). */
  loadBusiness?: (businessId: string) => Promise<Business | null>;
  /** Uso del agente del mes (lo da el módulo WhatsApp). Sin él, `usage.aiConversations` es null. */
  aiUsage?: AiUsageReader;
  /** Tipos de job que SÍ corren con el negocio pausado (p. ej. guardar mensajes entrantes). */
  jobsAllowedWhilePaused?: readonly string[];
  /** Reloj (tests). */
  now?: () => Date;
}

export interface PlanService extends PlanHooks {
  /** Plan resuelto del negocio, o null si no existe. */
  resolve(businessId: string): Promise<Entitlements | null>;
  moduleGate: ModuleGate;
  /** Límites efectivos del negocio (null si no existe). */
  getPlanLimits(businessId: string): Promise<PlanLimits | null>;
  getAiLimits: GetAiLimits;
  /** Uso actual del negocio frente a sus límites. */
  usage(businessId: string): Promise<PlanUsageView>;
  /**
   * ¿La cola puede correr este job de este negocio? false si el negocio está pausado o
   * dado de baja (salvo los tipos de `jobsAllowedWhilePaused`): el worker lo posterga.
   */
  canRunJob(businessId: string, jobType: string): Promise<boolean>;
}

/** Mes (`YYYY-MM`) de un instante en una zona IANA. */
export function monthIn(date: Date, timeZone: string): string {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit" }).formatToParts(date);
    const year = parts.find((p) => p.type === "year")?.value;
    const month = parts.find((p) => p.type === "month")?.value;
    if (year && month) return `${year}-${month}`;
  } catch {
    // zona inválida: cae a UTC
  }
  return date.toISOString().slice(0, 7);
}

const MICROS_PER_USD = 1_000_000;

export function createPlanService(db: Executor, options: PlanServiceOptions = {}): PlanService {
  const loadBusiness = options.loadBusiness ?? (async (businessId: string) => (await getBusinessContext(db, businessId))?.business ?? null);
  const now = options.now ?? (() => new Date());
  const allowedWhilePaused = new Set(options.jobsAllowedWhilePaused ?? []);
  const memo = new WeakMap<object, Entitlements>();

  async function loadWithEntitlements(businessId: string): Promise<{ business: Business; entitlements: Entitlements } | null> {
    const business = await loadBusiness(businessId);
    if (!business) return null;
    let entitlements = memo.get(business);
    if (!entitlements) {
      entitlements = resolveEntitlements(business);
      memo.set(business, entitlements);
    }
    return { business, entitlements };
  }

  const resolve = async (businessId: string) => (await loadWithEntitlements(businessId))?.entitlements ?? null;

  async function usageOf(business: Business): Promise<PlanUsageView> {
    const month = monthIn(now(), business.timezone);
    const [locations, staff, users, ai] = await Promise.all([
      countActiveLocationsOf(db, business.id),
      countActiveStaff(db, business.id),
      countActiveMembers(db, business.id),
      options.aiUsage ? options.aiUsage(business.id, month) : Promise.resolve(null),
    ]);
    return { month, locations, staff, users, aiConversations: ai ? ai.conversations : null };
  }

  return {
    resolve,

    moduleGate: async (businessId, module) => {
      const modules: readonly string[] = (await resolve(businessId))?.modules ?? [];
      return modules.includes(module);
    },

    async enabledModules(businessId) {
      return (await resolve(businessId))?.modules ?? [];
    },

    async quota(businessId: string, resource: PlanResource) {
      const entitlements = await resolve(businessId);
      return entitlements ? quotaOf(entitlements, resource) : null;
    },

    async hasFeature(businessId: string, feature: PlanFeature) {
      return (await resolve(businessId))?.features.includes(feature) ?? false;
    },

    async clientsTier(businessId: string) {
      return (await resolve(businessId))?.clientsTier ?? "basic";
    },

    async getPlanLimits(businessId) {
      const entitlements = await resolve(businessId);
      return entitlements ? { ...entitlements.limits } : null;
    },

    async getAiLimits(businessId) {
      const entitlements = await resolve(businessId);
      if (!entitlements) {
        return { agentEnabled: false, disabledReason: "business_not_found", plan: null, monthlyConversations: null, monthlyLlmCostUsdMicros: null };
      }
      const { limits } = entitlements;
      const disabledReason =
        entitlements.status === "paused"
          ? "business_paused"
          : entitlements.status !== "active"
            ? "business_closed"
            : !entitlements.modules.includes("whatsapp")
              ? "module_not_in_plan"
              : null;
      return {
        agentEnabled: disabledReason === null,
        disabledReason,
        plan: entitlements.plan,
        monthlyConversations: limits.aiConversations,
        monthlyLlmCostUsdMicros: limits.aiLlmUsd === null ? null : Math.round(limits.aiLlmUsd * MICROS_PER_USD),
      };
    },

    async usage(businessId) {
      const found = await loadWithEntitlements(businessId);
      if (!found) throw new HttpError(404, "Negocio no encontrado.", "not_found");
      return usageOf(found.business);
    },

    async snapshot(businessId): Promise<PlanSnapshot> {
      const found = await loadWithEntitlements(businessId);
      if (!found) throw new HttpError(404, "Negocio no encontrado.", "not_found");
      const { entitlements: e } = found;
      return {
        id: e.plan,
        label: e.label,
        clientsTier: e.clientsTier,
        modules: [...e.modules],
        features: [...e.features],
        billingStatus: e.billingStatus,
        limits: { locations: e.limits.locations, staff: e.limits.staff, users: e.limits.users, aiConversations: e.limits.aiConversations },
        usage: await usageOf(found.business),
      };
    },

    async canRunJob(businessId, jobType) {
      const business = await loadBusiness(businessId);
      // Un negocio que ya no existe no se posterga: el handler decide (normalmente, noop).
      if (!business || business.status === "active") return true;
      return allowedWhilePaused.has(jobType);
    },
  };
}
