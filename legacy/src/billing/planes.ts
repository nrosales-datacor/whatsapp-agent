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

// ─────────────────────────────────────────────────────────────────────────────
// Tope mensual de GASTO de LLM en USD (revisión pre-venta 2026-10). El tope de
// conversaciones de arriba mide ventanas de 24 h, no mensajes ni tokens: un
// spammer o un bucle con otro autorespondedor cuenta como UNA conversación y
// puede generar miles de llamadas pagadas a OpenAI. Este tope corta por la
// métrica que de verdad cuesta plata — `wa_uso_mensual.costo_estimado_millonesimos`,
// que ya acumula F13 (src/observabilidad/costoLlm.ts) — y aplica a AMBOS planes
// (a diferencia del de conversaciones, Pro también lo tiene, solo que más alto).
//
// Defaults: un turno típico con gpt-4o-mini ronda USD 0,001-0,002 (AUDIT.md § 7:
// ~3,7k tokens fijos por llamada, hasta 4 llamadas por turno). 500 conversaciones
// de ~8 turnos ≈ USD 6-8/mes, así que USD 15 (Básico) deja ~2x de margen al uso
// legítimo y USD 40 (Pro) cubre el volumen mayor; ambos quedan muy por debajo del
// precio del plan (₡35.000/₡60.000). No es un límite comercial que se le venda
// al cliente: es una red de seguridad contra el costo desbocado.
// ─────────────────────────────────────────────────────────────────────────────

function usdDeEnv(valor: string | undefined, porDefecto: number): number {
  const n = valor !== undefined && valor !== "" ? Number(valor) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : porDefecto;
}

export const TOPE_GASTO_LLM_USD_MES: Record<Plan, number> = {
  basico: usdDeEnv(process.env.TOPE_GASTO_LLM_USD_MES_BASICO, 15),
  pro: usdDeEnv(process.env.TOPE_GASTO_LLM_USD_MES_PRO, 40),
};

/**
 * Override por tenant SIN migración: `TOPE_GASTO_LLM_USD_MES_POR_TENANT` con pares
 * `tenantId=usd` separados por coma (ej. "lavacar-rosales=60,barberia-x=0"). `0` =
 * sin tope para ese tenant (contrato especial). Se lee en cada llamada (es un
 * string corto) para poder cambiarlo en los tests sin recargar el módulo; en
 * producción cambiarlo requiere reiniciar el proceso, igual que cualquier env.
 * Un par mal formado se ignora (cae al tope del plan), nunca deja al tenant sin tope.
 */
function overrideGastoDeTenant(tenantId: string): number | undefined {
  const crudo = process.env.TOPE_GASTO_LLM_USD_MES_POR_TENANT;
  if (!crudo) return undefined;
  for (const par of crudo.split(",")) {
    const [id, valor] = par.split("=").map((s) => s.trim());
    if (id !== tenantId || valor === undefined || valor === "") continue;
    const n = Number(valor);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return undefined;
}

/** Tope de gasto de LLM del mes, en USD, para este tenant. null = sin tope (solo por override explícito en 0). */
export function topeGastoLlmUsd(tenant: Tenant): number | null {
  const tope = overrideGastoDeTenant(tenant.id) ?? TOPE_GASTO_LLM_USD_MES[tenant.plan];
  return tope > 0 ? tope : null;
}

/** Todas las features derivadas del plan del tenant, para exponer en GET /me (el panel
 * muestra/oculta sin adivinar, mismo patrón que ya expone `marca`/`servicios`). */
export function featuresDeTenant(tenant: Tenant): Record<Feature, boolean> {
  return PLAN_FEATURES[tenant.plan];
}
