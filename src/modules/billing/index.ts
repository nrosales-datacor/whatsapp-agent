// API pública del módulo billing (planes, módulos y límites; Stripe en I6): lo único que
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
