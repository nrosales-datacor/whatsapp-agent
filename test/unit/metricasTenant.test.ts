import assert from "node:assert/strict";
import { test } from "node:test";
import {
  _contarAlertasSloParaTests,
  _forzarChequeoSloParaTests,
  _resetMetricasParaTests,
  _umbralSloLatenciaParaTests,
  registrarLatenciaAgente,
  registrarMensaje,
} from "../../src/observabilidad/metricas";

// ─────────────────────────────────────────────────────────────────────────────
// F14 (observabilidad por tenant): los contadores en memoria de metricas.ts
// pasaron de 3 variables globales a un Map<tenantId, {...}>. Estos tests cubren
// la parte en memoria (registrarMensaje/registrarLatenciaAgente y la alerta de
// SLO por p95) — el reporte periódico (`iniciarReporteMetricas`) usa
// `iniciarCicloSinSolape` + `intentarLiderazgo`, que ya tienen su propia
// cobertura (test/unit/programador.test.ts, test/reliability/liderazgo.test.ts)
// y no hace falta re-testear acá; `_forzarChequeoSloParaTests` ejercita
// EXACTAMENTE la misma función de chequeo que corre dentro de cada tick, sin
// depender de DB ni de tiempo real.
// ─────────────────────────────────────────────────────────────────────────────

test.beforeEach(() => {
  _resetMetricasParaTests();
});

test("registrarLatenciaAgente: dos tenants no se mezclan — uno cruza el umbral, el otro no", () => {
  const umbral = _umbralSloLatenciaParaTests();

  // tenant-lento: todas las muestras por encima del umbral -> p95 > umbral.
  for (let i = 0; i < 10; i++) registrarLatenciaAgente("tenant-lento", umbral + 5_000);
  // tenant-rapido: todas las muestras muy por debajo -> p95 << umbral.
  for (let i = 0; i < 10; i++) registrarLatenciaAgente("tenant-rapido", 100);

  _forzarChequeoSloParaTests("tenant-rapido");
  assert.equal(_contarAlertasSloParaTests(), 0, "tenant-rapido no debe disparar la alerta");

  _forzarChequeoSloParaTests("tenant-lento");
  assert.equal(_contarAlertasSloParaTests(), 1, "tenant-lento sí debe disparar, y sin afectar a tenant-rapido");
});

test("alerta de SLO: no dispara con muy pocas muestras aunque estén todas por encima del umbral", () => {
  const umbral = _umbralSloLatenciaParaTests();
  // Menos que SLO_MUESTRA_MINIMA (5): un p95 con 2 muestras es ruido, no señal.
  registrarLatenciaAgente("tenant-poco-dato", umbral + 10_000);
  registrarLatenciaAgente("tenant-poco-dato", umbral + 10_000);

  _forzarChequeoSloParaTests("tenant-poco-dato");
  assert.equal(_contarAlertasSloParaTests(), 0, "con pocas muestras no debe alertar");
});

test("alerta de SLO: respeta el cooldown (no re-alerta en el tick inmediatamente siguiente)", () => {
  const umbral = _umbralSloLatenciaParaTests();
  for (let i = 0; i < 10; i++) registrarLatenciaAgente("tenant-lento", umbral + 5_000);

  _forzarChequeoSloParaTests("tenant-lento");
  assert.equal(_contarAlertasSloParaTests(), 1, "primer cruce del umbral: dispara");

  // Nuevas muestras igual de lentas, mismo tenant: el cooldown de 15 min sigue
  // vigente (recién disparó), así que el segundo chequeo no debe volver a alertar.
  registrarLatenciaAgente("tenant-lento", umbral + 5_000);
  _forzarChequeoSloParaTests("tenant-lento");
  assert.equal(_contarAlertasSloParaTests(), 1, "el cooldown evita floodear Sentry con la misma condición");
});

test("registrarMensaje: no lanza para tenants distintos y _resetMetricasParaTests limpia el estado", () => {
  registrarMensaje("tenant-a");
  registrarMensaje("tenant-a");
  registrarMensaje("tenant-b");
  registrarLatenciaAgente("tenant-a", 1234);

  _resetMetricasParaTests();
  assert.equal(_contarAlertasSloParaTests(), 0);

  // Tras el reset, el tenant vuelve a arrancar "limpio": si tuviera muestras
  // colgadas del test anterior, un solo chequeo con pocas muestras nuevas no
  // debería alcanzar para disparar la alerta.
  registrarLatenciaAgente("tenant-a", _umbralSloLatenciaParaTests() + 5_000);
  _forzarChequeoSloParaTests("tenant-a");
  assert.equal(_contarAlertasSloParaTests(), 0, "una sola muestra nueva tras el reset no alcanza el mínimo");
});
