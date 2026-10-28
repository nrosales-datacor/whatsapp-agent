// API pública del módulo billing (planes, módulos y límites; Stripe y vencimientos en I6): lo único que
// la composición (src/app.ts, src/routes.ts, src/jobs.ts), el superadmin y otros módulos de
// afuera del núcleo pueden importar de acá (test/architecture/moduleBoundaries.test.ts).
// El núcleo NO lo importa: recibe lo que necesita como `PlanHooks`
// (src/platform/plan/planHooks.ts) y `ModuleGate`.
export {
  buildPlans,
  ExtraModulesSchema,
  isModuleName,
  LIMIT_KEYS,
  LimitOverridesSchema,
  MODULES,
  ModuleOverridesSchema,
  normalizeExtraModules,
  PLAN_IDS,
  PLANS,
  PRO_WITHOUT_AGENT,
  readExtraModules,
} from "./catalog";
export type { ExtraModulesInput, LimitOverrides, ModuleName, ModuleOverrides, PlanDefinition, PlanLimits } from "./catalog";
export { quotaOf, resolveEntitlements } from "./entitlements";
export type { Entitlements } from "./entitlements";
export { createPlanService, monthIn } from "./service";
export type { AiLimits, AiUsageReader, GetAiLimits, PlanService, PlanServiceOptions } from "./service";
export {
  adminRowOf,
  changeBusinessPlan,
  getAdminBusinessDetail,
  listAdminBusinesses,
  pauseBusiness,
  PauseInput,
  PlanChangeInput,
  reactivateBusiness,
} from "./admin";
export type { AdminBusinessDetail, AdminBusinessRow, PlanChangeInputValue } from "./admin";
export type { AdminStripeView } from "./admin";
// Cobro en línea con Stripe (I6): rutas del dueño, webhook, barrido de vencimientos y prueba.
export { billingRoutes, type BillingRouteDeps } from "./routes";
export { billingNotConfigured, billingStatusOfBusiness, CheckoutInput, PLAN_SETTINGS_PATH } from "./checkout";
export type { BillingDeps, BillingStatusView } from "./checkout";
export { createStripeWebhookHandler, STRIPE_WEBHOOK_PATH, type StripeWebhookOptions } from "./stripeWebhook";
export { processStripeEvent, STRIPE_ACTOR } from "./stripeSync";
export type { StripeEventOutcome, StripeEventResult } from "./stripeSync";
export { createStripeGateway, signStripePayload, StripeGatewayError, verifyStripeEvent } from "./stripeGateway";
export type { CheckoutSessionInput, PortalSessionInput, StripeEventLike, StripeGateway } from "./stripeGateway";
export { pastDueGraceDays, readStripeConfig, trialDays, trialEndFrom } from "./stripeConfig";
export type { StripeConfig } from "./stripeConfig";
export { BILLING_SWEEP_ACTOR, billingPauseReason, startBillingScheduler, sweepBilling } from "./sweep";
export type { BillingPauseReason, BillingSweepResult } from "./sweep";
export { startTrial } from "./trial";
