// ─────────────────────────────────────────────────────────────────────────────
// Tarifas de OpenAI para estimar el costo de LLM por tenant (F13 —
// PLAN-ESCALA-MULTITENANT.md). El costo se guarda en la DB como un ENTERO de
// "millonésimos de dólar" (1 unidad = USD 0,000001), NUNCA en float: es un
// contador que se incrementa miles de veces por mes (INSERT ... ON CONFLICT DO
// UPDATE SET x = x + n, ver observabilidad/uso.ts) y un float acumularía error
// de redondeo turno a turno. Acá se redondea UNA sola vez por llamada a
// `calcularCostoMillonesimos`/`calcularCostoWhisperMillonesimos` (no por token),
// y de ahí en adelante todo es suma entera exacta en Postgres.
//
// Los valores por defecto son los vigentes al momento de AUDIT.md (sección "7.
// Costos"): gpt-4o-mini a $0,15 / 1M tokens de entrada y $0,60 / 1M tokens de
// salida; whisper-1 a $0,006/minuto. OpenAI cambia precios sin aviso — antes de
// usar estos números para cotizar un plan nuevo, verificalos en
// https://openai.com/api/pricing/. Se pueden actualizar SIN REDEPLOY con las
// variables de entorno de abajo (en dólares normales, ej. "0.15"; NO en
// millonésimos — la conversión a la unidad entera se hace acá, una sola vez).
// ─────────────────────────────────────────────────────────────────────────────

/** 1 millonésimo de dólar = USD 0,000001. Factor de conversión USD → la unidad entera. */
const USD_A_MILLONESIMOS = 1_000_000;

/** Lee un precio en USD desde una env var (si viene y es un número válido ≥ 0) o cae al
 * default, y lo convierte a millonésimos de dólar. La conversión ocurre UNA sola vez acá
 * (al armar la tabla de tarifas), no en el hot path de cada mensaje. */
function precioUsdAMillonesimos(envVar: string | undefined, defaultUsd: number): number {
  const n = envVar !== undefined && envVar !== "" ? Number(envVar) : NaN;
  const usd = Number.isFinite(n) && n >= 0 ? n : defaultUsd;
  return Math.round(usd * USD_A_MILLONESIMOS);
}

interface TarifaModelo {
  /** Millonésimos de USD por CADA millón de tokens de entrada. */
  entradaPor1M: number;
  /** Millonésimos de USD por CADA millón de tokens de salida. */
  salidaPor1M: number;
}

/**
 * Tabla de precios por modelo (item 3 del ítem F13: "Tarifas configurables").
 * Env vars para actualizar sin deploy (en USD normales, no en millonésimos):
 *   OPENAI_PRECIO_GPT4O_MINI_ENTRADA_USD_POR_1M
 *   OPENAI_PRECIO_GPT4O_MINI_SALIDA_USD_POR_1M
 *
 * ⚠️ Default vigente a la fecha de AUDIT.md § 7 ("Estimación por conversación"): $0,15/1M
 * in · $0,60/1M out. Revisar contra la tabla de precios de OpenAI antes de confiar en esto
 * para fijar el precio de venta de un plan nuevo.
 */
const TARIFAS: Record<string, TarifaModelo> = {
  "gpt-4o-mini": {
    entradaPor1M: precioUsdAMillonesimos(process.env.OPENAI_PRECIO_GPT4O_MINI_ENTRADA_USD_POR_1M, 0.15),
    salidaPor1M: precioUsdAMillonesimos(process.env.OPENAI_PRECIO_GPT4O_MINI_SALIDA_USD_POR_1M, 0.6),
  },
};

// Modelo de fallback cuando MODELO (env OPENAI_MODEL) no tiene fila en la tabla de arriba:
// se estima con la tarifa de gpt-4o-mini en vez de dejar el costo en cero en silencio. Se
// avisa por consola una sola vez por modelo (no en cada turno) para no inundar los logs.
const avisados = new Set<string>();
function tarifaDe(modelo: string): TarifaModelo {
  const tarifa = TARIFAS[modelo];
  if (tarifa) return tarifa;
  if (!avisados.has(modelo)) {
    avisados.add(modelo);
    console.warn(`[costoLlm] no hay tarifa configurada para el modelo "${modelo}"; se estima con la de gpt-4o-mini`);
  }
  return TARIFAS["gpt-4o-mini"];
}

/**
 * Costo estimado de una llamada (o de un turno completo, sumando los tokens de todos sus
 * pasos de tool-calling), en millonésimos de dólar. Redondea UNA vez — no llamar por token.
 */
export function calcularCostoMillonesimos(modelo: string, tokensEntrada: number, tokensSalida: number): number {
  if (tokensEntrada <= 0 && tokensSalida <= 0) return 0;
  const tarifa = tarifaDe(modelo);
  return Math.round((tokensEntrada * tarifa.entradaPor1M + tokensSalida * tarifa.salidaPor1M) / USD_A_MILLONESIMOS);
}

// Whisper (transcripción de audio) cobra por MINUTO, no por token — no encaja en la tabla
// de arriba. $0,006/min es el precio documentado en AUDIT.md § 7 ("Nota de voz").
// Env var para actualizar sin deploy: OPENAI_PRECIO_WHISPER_USD_POR_MINUTO.
const PRECIO_WHISPER_USD_POR_MINUTO = (() => {
  const n = Number(process.env.OPENAI_PRECIO_WHISPER_USD_POR_MINUTO);
  return Number.isFinite(n) && n >= 0 ? n : 0.006;
})();

/** Costo estimado de transcribir `segundos` de audio con Whisper, en millonésimos de dólar. */
export function calcularCostoWhisperMillonesimos(segundos: number): number {
  if (!Number.isFinite(segundos) || segundos <= 0) return 0;
  return Math.round((segundos / 60) * PRECIO_WHISPER_USD_POR_MINUTO * USD_A_MILLONESIMOS);
}
