import assert from "node:assert/strict";
import { test } from "node:test";
import { calcularCostoMillonesimos, calcularCostoWhisperMillonesimos } from "../../src/observabilidad/costoLlm";

// ─────────────────────────────────────────────────────────────────────────────
// Cálculo de costo estimado de LLM por tenant (F13 — PLAN-ESCALA-MULTITENANT.md).
// Las tarifas por defecto son las de AUDIT.md § 7 ("Estimación por conversación"):
// gpt-4o-mini a $0,15/1M tokens de entrada y $0,60/1M de salida; whisper-1 a $0,006/min.
// El costo se guarda como ENTERO de millonésimos de dólar (1 unidad = USD 0,000001)
// para no acumular error de redondeo — acá se prueba que la conversión token→millonésimo
// da los números exactos que documenta la auditoría.
// ─────────────────────────────────────────────────────────────────────────────

test("calcularCostoMillonesimos: 1M tokens de entrada cuestan exactamente $0,15 (150.000 millonésimos)", () => {
  assert.equal(calcularCostoMillonesimos("gpt-4o-mini", 1_000_000, 0), 150_000);
});

test("calcularCostoMillonesimos: 1M tokens de salida cuestan exactamente $0,60 (600.000 millonésimos)", () => {
  assert.equal(calcularCostoMillonesimos("gpt-4o-mini", 0, 1_000_000), 600_000);
});

test("calcularCostoMillonesimos: sin tokens, costo cero", () => {
  assert.equal(calcularCostoMillonesimos("gpt-4o-mini", 0, 0), 0);
});

test("calcularCostoMillonesimos: combina entrada y salida en la misma llamada", () => {
  // 51.200 tokens de entrada + 1.440 de salida ≈ la conversación típica de AUDIT.md § 7
  // (allí redondeada a "$0,0086"; acá se verifica el cálculo exacto en millonésimos).
  const costo = calcularCostoMillonesimos("gpt-4o-mini", 51_200, 1_440);
  // 51200*150000 = 7,680,000,000 ; 1440*600000 = 864,000,000 ; suma = 8,544,000,000
  // /1_000_000 = 8544 millonésimos = $0,008544 ≈ $0,0086 del audit (redondeo de la auditoría).
  assert.equal(costo, 8_544);
});

test("calcularCostoMillonesimos: un modelo desconocido no revienta y estima con la tarifa de gpt-4o-mini", () => {
  const costoConocido = calcularCostoMillonesimos("gpt-4o-mini", 1_000, 1_000);
  const costoDesconocido = calcularCostoMillonesimos("un-modelo-que-no-existe", 1_000, 1_000);
  assert.equal(costoDesconocido, costoConocido);
});

test("calcularCostoWhisperMillonesimos: 30 s de audio cuestan ~$0,003 (el número de AUDIT.md § 7)", () => {
  // 30 s = 0,5 min × $0,006/min = $0,003 = 3.000 millonésimos.
  assert.equal(calcularCostoWhisperMillonesimos(30), 3_000);
});

test("calcularCostoWhisperMillonesimos: 60 s (1 min) cuesta exactamente la tarifa por minuto", () => {
  assert.equal(calcularCostoWhisperMillonesimos(60), 6_000); // $0,006 = 6.000 millonésimos
});

test("calcularCostoWhisperMillonesimos: sin duración (0, negativo o no numérico) da costo cero, no NaN", () => {
  assert.equal(calcularCostoWhisperMillonesimos(0), 0);
  assert.equal(calcularCostoWhisperMillonesimos(-5), 0);
  assert.equal(calcularCostoWhisperMillonesimos(NaN), 0);
});
