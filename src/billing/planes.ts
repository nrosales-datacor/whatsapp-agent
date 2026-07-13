import type { Plan, Tenant } from "../types";

// ─────────────────────────────────────────────────────────────────────────────
// Catálogo de features por plan (ROADMAP C4.3 / PLAN-VALOR-PRODUCTO.md §C4.3):
// Básico = bot + panel + agenda. Pro = suma campañas segmentadas, multi-usuario y
// white-label. Puro (sin I/O) para poder usarlo tanto del router (gating) como del
// frontend si hiciera falta mostrar/ocultar UI según el plan.
// ─────────────────────────────────────────────────────────────────────────────

type Feature = "campanias" | "multiUsuario" | "whiteLabel";

const PLAN_FEATURES: Record<Plan, Record<Feature, boolean>> = {
  basico: { campanias: false, multiUsuario: false, whiteLabel: false },
  pro: { campanias: true, multiUsuario: true, whiteLabel: true },
};

/** true si el plan del tenant habilita esa feature. */
export function tenantPuede(tenant: Tenant, feature: Feature): boolean {
  return PLAN_FEATURES[tenant.plan][feature];
}
