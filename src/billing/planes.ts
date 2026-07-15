import type { Plan, Tenant } from "../types";

// ─────────────────────────────────────────────────────────────────────────────
// Catálogo de features por plan (ROADMAP Carril D / PLAN-FEATURES-FALTANTES.md §0.1):
// Básico = bot + panel + agenda (todo lo que ya existe, menos lo de abajo). Pro suma
// campañas segmentadas, multi-usuario, white-label y las 3 features de la Fase 1
// (rescate de cotizaciones, upsell, motor de reseñas completo — aún sin construir,
// el mapa ya las deja listas para gatear el día que se construyan). Puro (sin I/O)
// para poder usarlo tanto del router (gating) como del frontend (mostrar/ocultar UI).
// ─────────────────────────────────────────────────────────────────────────────

export type Feature =
  | "campanias"
  | "multiUsuario"
  | "whiteLabel"
  | "rescateCotizaciones"
  | "upsell"
  | "resenasPro";

const PLAN_FEATURES: Record<Plan, Record<Feature, boolean>> = {
  basico: {
    campanias: false,
    multiUsuario: false,
    whiteLabel: false,
    rescateCotizaciones: false,
    upsell: false,
    resenasPro: false,
  },
  pro: {
    campanias: true,
    multiUsuario: true,
    whiteLabel: true,
    rescateCotizaciones: true,
    upsell: true,
    resenasPro: true,
  },
};

/** true si el plan del tenant habilita esa feature. */
export function tenantPuede(tenant: Tenant, feature: Feature): boolean {
  return PLAN_FEATURES[tenant.plan][feature];
}

/** Todas las features derivadas del plan del tenant, para exponer en GET /me (el panel
 * muestra/oculta sin adivinar, mismo patrón que ya expone `marca`/`servicios`). */
export function featuresDeTenant(tenant: Tenant): Record<Feature, boolean> {
  return PLAN_FEATURES[tenant.plan];
}
