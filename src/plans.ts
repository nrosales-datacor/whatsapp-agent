import { createPlanService, type PlanService } from "./modules/billing";
import { NO_GROWTH, readMonthlyAiUsage, WHATSAPP_JOBS_ALLOWED_WHILE_PAUSED, type AiLimitsResolver, type GrowthResolver } from "./modules/whatsapp";
import type { Executor } from "./platform/db/scope";

// ─────────────────────────────────────────────────────────────────────────────
// Composición de los planes (PLAN-GESTION.md §5): el servicio de billing con lo que le
// aportan los módulos de afuera del núcleo, y el adaptador de sus topes al pipeline del
// agente. Vive acá (en la composición, como src/routes.ts y src/jobs.ts) porque ni el
// núcleo ni whatsapp importan billing, ni billing lee las tablas de whatsapp:
//
//   • `aiUsage`: el uso del agente del mes sale de `ai_usage_monthly` (módulo WhatsApp)
//     → `me.plan.usage.aiConversations` y el detalle del superadmin.
//   • `jobsAllowedWhilePaused`: los jobs que la cola corre con el negocio pausado (los de
//     WhatsApp que completan lo que ya entró sin responder, y el borrado de adjuntos de un
//     cliente anonimizado). Todo lo demás se posterga hasta que se reactive.
//   • `aiLimitsFromPlan`: los topes del plan (conversaciones y gasto de LLM del mes, y si
//     el agente está apagado por plan o pausa) con la forma que espera el pipeline.
//   • `growthFromPlan`: lo de crecimiento que el plan le permite al agente (I6: pedir el
//     consentimiento de marketing si hay Campañas, reseñas, rescate de cotizaciones y upsell).
//
// Lo usan src/app.ts (router y `me`), src/jobs.ts (pipeline y cola) y src/server.ts (una
// sola instancia por proceso).
// ─────────────────────────────────────────────────────────────────────────────

/** Tipos de job que corren aunque el negocio esté pausado o dado de baja. */
const JOBS_ALLOWED_WHILE_PAUSED: readonly string[] = [...WHATSAPP_JOBS_ALLOWED_WHILE_PAUSED];

/** Servicio de planes del proceso, con el uso del agente y los jobs permitidos en pausa. */
export function createPlans(db: Executor): PlanService {
  return createPlanService(db, {
    aiUsage: (businessId, month) => readMonthlyAiUsage(db, businessId, month),
    jobsAllowedWhilePaused: JOBS_ALLOWED_WHILE_PAUSED,
  });
}

/**
 * Topes del agente de WhatsApp desde el plan del negocio. Con el agente apagado (Pro sin
 * agente, módulo quitado, negocio pausado o de baja) el pipeline no lo llama; con el tope
 * del mes agotado, avisa al cliente y pasa la conversación a una persona.
 */
export function aiLimitsFromPlan(plans: Pick<PlanService, "getAiLimits">): AiLimitsResolver {
  return async (businessId) => {
    const limits = await plans.getAiLimits(businessId);
    return {
      agentEnabled: limits.agentEnabled,
      disabledReason: limits.disabledReason,
      monthlyConversations: limits.monthlyConversations,
      monthlySpendMicros: limits.monthlyLlmCostUsdMicros,
    };
  };
}

/**
 * Crecimiento del agente desde el plan del negocio (src/modules/whatsapp/growth.ts). Un
 * negocio que no existe, o sin servicio, no tiene nada: los barridos y el agente no hacen
 * nada de esto por él.
 */
export function growthFromPlan(plans: Pick<PlanService, "resolve">): GrowthResolver {
  return async (businessId) => {
    const e = await plans.resolve(businessId);
    if (!e || e.status !== "active") return NO_GROWTH;
    return {
      marketingConsent: e.modules.includes("campaigns"),
      reviews: e.features.includes("reviews"),
      quoteRecovery: e.features.includes("quote_recovery"),
      upsell: e.features.includes("upsell"),
    };
  };
}
