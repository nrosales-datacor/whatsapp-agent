import { log } from "../../../platform/observability/log";
import { agentModel } from "./config";

// ─────────────────────────────────────────────────────────────────────────────
// Costo estimado de LLM por turno (puerto de legacy/src/observabilidad/costoLlm.ts). Se
// cuenta en MILLONÉSIMOS de dólar (1 = USD 0,000001), entero: es un acumulado mensual
// (`ai_usage_monthly.estimated_cost_usd_micros`) que crece miles de veces y un float
// arrastraría error de redondeo. Se redondea UNA vez por turno, nunca por token.
//
// Tabla por modelo con las tres tarifas de OpenAI (USD por 1M tokens): entrada, entrada
// servida desde el caché de prompts y salida. El modelo en uso (`OPENAI_MODEL`) se puede
// re-tarifar SIN deploy con:
//   OPENAI_PRICE_INPUT_USD_PER_1M, OPENAI_PRICE_CACHED_INPUT_USD_PER_1M,
//   OPENAI_PRICE_OUTPUT_USD_PER_1M   (en dólares, p. ej. "0.15")
// OpenAI cambia precios sin aviso: verificá https://openai.com/api/pricing/ antes de usar
// estos números para cotizar un plan.
// ─────────────────────────────────────────────────────────────────────────────

const USD_TO_MICROS = 1_000_000;

/** Tarifas de un modelo, en micro-dólares por cada millón de tokens. */
export interface ModelPricing {
  inputPer1M: number;
  cachedInputPer1M: number;
  outputPer1M: number;
}

const pricing = (inputUsd: number, cachedUsd: number, outputUsd: number): ModelPricing => ({
  inputPer1M: Math.round(inputUsd * USD_TO_MICROS),
  cachedInputPer1M: Math.round(cachedUsd * USD_TO_MICROS),
  outputPer1M: Math.round(outputUsd * USD_TO_MICROS),
});

/** Precios públicos de OpenAI (USD por 1M tokens) a la fecha del port. */
export const MODEL_PRICING: Readonly<Record<string, ModelPricing>> = {
  "gpt-4o-mini": pricing(0.15, 0.075, 0.6),
  "gpt-4o": pricing(2.5, 1.25, 10),
  "gpt-4.1": pricing(2, 0.5, 8),
  "gpt-4.1-mini": pricing(0.4, 0.1, 1.6),
  "gpt-4.1-nano": pricing(0.1, 0.025, 0.4),
  "gpt-5": pricing(1.25, 0.125, 10),
  "gpt-5-mini": pricing(0.25, 0.025, 2),
  "gpt-5-nano": pricing(0.05, 0.005, 0.4),
};

const FALLBACK_MODEL = "gpt-4o-mini";

/** Precio en USD de una env (≥ 0) convertido a micro-dólares, o null si falta o es inválido. */
function priceFromEnv(name: string): number | null {
  const raw = process.env[name];
  const n = raw !== undefined && raw.trim() !== "" ? Number(raw) : NaN;
  return Number.isFinite(n) && n >= 0 ? Math.round(n * USD_TO_MICROS) : null;
}

const warned = new Set<string>();

/**
 * Tarifas de un modelo. Un id con fecha ("gpt-4o-mini-2024-07-18") usa la fila de su
 * modelo base; uno desconocido se estima con gpt-4o-mini (y se avisa una vez) en vez de
 * quedar en cero en silencio. Las env vars de precio pisan las del modelo configurado.
 */
export function pricingFor(model: string): ModelPricing {
  const base = MODEL_PRICING[model] ?? MODEL_PRICING[model.replace(/-\d{4}-\d{2}-\d{2}$/, "")];
  if (!base && !warned.has(model)) {
    warned.add(model);
    log.warn("agent_model_without_pricing", { model, fallback: FALLBACK_MODEL });
  }
  const row = base ?? MODEL_PRICING[FALLBACK_MODEL];
  if (model !== agentModel()) return row;
  return {
    inputPer1M: priceFromEnv("OPENAI_PRICE_INPUT_USD_PER_1M") ?? row.inputPer1M,
    cachedInputPer1M: priceFromEnv("OPENAI_PRICE_CACHED_INPUT_USD_PER_1M") ?? row.cachedInputPer1M,
    outputPer1M: priceFromEnv("OPENAI_PRICE_OUTPUT_USD_PER_1M") ?? row.outputPer1M,
  };
}

export interface TokenUsage {
  /** `prompt_tokens` TOTAL (ya incluye los cacheados). */
  inputTokens: number;
  /** Parte de la entrada servida desde el caché (`prompt_tokens_details.cached_tokens`). */
  cachedInputTokens: number;
  outputTokens: number;
}

/** Costo en micro-dólares de un turno (suma de todos sus pasos). Redondea una sola vez. */
export function computeCostMicros(model: string, usage: TokenUsage, rates: ModelPricing = pricingFor(model)): number {
  const input = Math.max(0, usage.inputTokens);
  const output = Math.max(0, usage.outputTokens);
  if (input === 0 && output === 0) return 0;
  const cached = Math.min(Math.max(0, usage.cachedInputTokens), input);
  return Math.round(((input - cached) * rates.inputPer1M + cached * rates.cachedInputPer1M + output * rates.outputPer1M) / USD_TO_MICROS);
}
