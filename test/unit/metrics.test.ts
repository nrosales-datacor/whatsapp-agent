import assert from "node:assert/strict";
import { test } from "node:test";
import { _resetAlertsForTests } from "../../src/platform/observability/alerts";
import {
  _countSloAlertsForTests,
  _forceSloCheckForTests,
  _resetMetricsForTests,
  _sloThresholdForTests,
  recordEvent,
  recordLatency,
} from "../../src/platform/observability/metrics";

// ─────────────────────────────────────────────────────────────────────────────
// Métricas por negocio (src/platform/observability/metrics.ts): contadores en memoria y
// la alerta de SLO por p95. El reporte periódico (`startMetricsReport`) usa
// `startLeaderLoop`, que ya tiene su propia cobertura (test/unit/scheduler.test.ts,
// test/reliability/leaderLease.test.ts); `_forceSloCheckForTests` ejercita EXACTAMENTE la
// misma función de chequeo que corre dentro de cada tick, sin DB ni tiempo real.
// ─────────────────────────────────────────────────────────────────────────────

test.beforeEach(() => {
  _resetMetricsForTests();
  _resetAlertsForTests(); // la deduplicación de alertas es estado de módulo
});

test("recordLatency: dos negocios no se mezclan — uno cruza el umbral, el otro no", () => {
  const threshold = _sloThresholdForTests();

  // negocio lento: todas las muestras por encima del umbral → p95 > umbral.
  for (let i = 0; i < 10; i++) recordLatency("tenant-slow", threshold + 5_000);
  // negocio rápido: todas las muestras muy por debajo → p95 << umbral.
  for (let i = 0; i < 10; i++) recordLatency("tenant-fast", 100);

  _forceSloCheckForTests("tenant-fast");
  assert.equal(_countSloAlertsForTests(), 0, "el negocio rápido no debe disparar la alerta");

  _forceSloCheckForTests("tenant-slow");
  assert.equal(_countSloAlertsForTests(), 1, "el lento sí, y sin afectar al rápido");
});

test("alerta de SLO: no dispara con muy pocas muestras aunque estén todas por encima del umbral", () => {
  const threshold = _sloThresholdForTests();
  // Menos que el mínimo (5): un p95 con 2 muestras es ruido, no señal.
  recordLatency("tenant-few", threshold + 10_000);
  recordLatency("tenant-few", threshold + 10_000);

  _forceSloCheckForTests("tenant-few");
  assert.equal(_countSloAlertsForTests(), 0, "con pocas muestras no debe alertar");
});

test("alerta de SLO: respeta el cooldown (no re-alerta en el tick inmediatamente siguiente)", () => {
  const threshold = _sloThresholdForTests();
  for (let i = 0; i < 10; i++) recordLatency("tenant-slow", threshold + 5_000);

  _forceSloCheckForTests("tenant-slow");
  assert.equal(_countSloAlertsForTests(), 1, "primer cruce del umbral: dispara");

  // Nuevas muestras igual de lentas, mismo negocio: el cooldown sigue vigente (recién
  // disparó), así que el segundo chequeo no vuelve a alertar.
  recordLatency("tenant-slow", threshold + 5_000);
  _forceSloCheckForTests("tenant-slow");
  assert.equal(_countSloAlertsForTests(), 1, "el cooldown evita inundar la plataforma con la misma condición");
});

test("recordEvent: no lanza para negocios distintos y _resetMetricsForTests limpia el estado", () => {
  recordEvent("tenant-a");
  recordEvent("tenant-a");
  recordEvent("tenant-b");
  recordLatency("tenant-a", 1234);

  _resetMetricsForTests();
  assert.equal(_countSloAlertsForTests(), 0);

  // Tras el reset, el negocio arranca "limpio": si tuviera muestras colgadas, un solo
  // chequeo con pocas muestras nuevas no debería alcanzar para disparar la alerta.
  recordLatency("tenant-a", _sloThresholdForTests() + 5_000);
  _forceSloCheckForTests("tenant-a");
  assert.equal(_countSloAlertsForTests(), 0, "una sola muestra nueva tras el reset no alcanza el mínimo");
});
