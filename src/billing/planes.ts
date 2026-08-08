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

// ─────────────────────────────────────────────────────────────────────────────
// Tope mensual de conversaciones (F10 — PLAN-ESCALA-MULTITENANT.md): lo que
// `wa_uso_mensual` mide desde Carril D 0.2 pero nunca aplicó ("medir sin
// bloquear"). null = sin tope (Pro no se ve afectado, ver la aceptación de F10
// en el plan). El valor de Básico (~500 conv/mes) es el que ya se le vende al
// cliente en el pitch comercial — acá es donde por fin se aplica. Configurable
// por env por si hace falta ajustar sin redeploy de código.
// ─────────────────────────────────────────────────────────────────────────────
export const TOPE_CONVERSACIONES_MES: Record<Plan, number | null> = {
  basico: Number(process.env.TOPE_CONVERSACIONES_MES_BASICO ?? 500),
  pro: null,
};

/** Todas las features derivadas del plan del tenant, para exponer en GET /me (el panel
 * muestra/oculta sin adivinar, mismo patrón que ya expone `marca`/`servicios`). */
export function featuresDeTenant(tenant: Tenant): Record<Feature, boolean> {
  return PLAN_FEATURES[tenant.plan];
}
