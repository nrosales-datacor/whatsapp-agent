// ─────────────────────────────────────────────────────────────────────────────
// Funciones de crecimiento del agente (I6, PLAN-GESTION.md §11) que dependen del plan del
// negocio. Igual que los topes (./limits.ts), este módulo no conoce los planes: la
// composición (src/plans.ts) inyecta `getGrowth` desde modules/billing.
//
//   • `marketingConsent`: el negocio tiene Campañas → tras la primera cita agendada se le
//     pregunta al cliente si quiere recibir promociones (sin Campañas no tiene sentido
//     pedirlo: nadie las mandaría).
//   • `reviews`: seguimiento post-servicio con pedido de reseña (./followUps.ts).
//   • `quoteRecovery`: rescate de cotizaciones abandonadas (./quotes.ts).
//   • `upsell`: ofrecer un servicio complementario tras agendar (./upsell.ts).
//
// Además de que el plan lo traiga, cada función se activa en la configuración del agente
// (`ai_settings`): el plan dice si se PUEDE, el dueño decide si la USA.
// ─────────────────────────────────────────────────────────────────────────────

export interface GrowthFeatures {
  marketingConsent: boolean;
  reviews: boolean;
  quoteRecovery: boolean;
  upsell: boolean;
}

export type GrowthResolver = (businessId: string) => GrowthFeatures | Promise<GrowthFeatures>;

/** Ninguna: el default sin plan inyectado (rutas del panel y tests que no lo prueban). */
export const NO_GROWTH: Readonly<GrowthFeatures> = Object.freeze({ marketingConsent: false, reviews: false, quoteRecovery: false, upsell: false });

export const noGrowth: GrowthResolver = () => NO_GROWTH;
