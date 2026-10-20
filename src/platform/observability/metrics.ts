import type { Executor } from "../db/scope";
import { startLeaderLoop } from "../net/leaderLease";
import type { Loop } from "../net/scheduler";
import { alertPlatform } from "./alerts";
import { captureError } from "./sentry";

// ─────────────────────────────────────────────────────────────────────────────
// Métricas internas de operación, por NEGOCIO: cuántos eventos procesa (mensajes,
// requests…) y cuánto tarda su operación crítica (p. ej. el turno del agente), para
// poder responder "¿este negocio va lento?" sin mirar los logs a mano. Sin dependencias
// ni servicio externo (Prometheus/Grafana quedan fuera de alcance): se acumulan en
// memoria y se vuelcan a `console.log` cada cierto intervalo, visible con `pm2 logs`.
//
// El reporte corre con `startLeaderLoop`: con `ROLE=worker` y N réplicas, cada una
// acumula SUS PROPIOS contadores (son de proceso), pero solo el titular del lease
// imprime; si no, cada réplica reportaría una fracción arbitraria del tráfico total.
//
// Los contadores se pierden en cada restart: no hay serie temporal persistida, solo el
// snapshot de cada ventana. Las métricas propias de cada módulo (profundidad de la cola,
// latencia del turno del agente, costo LLM) se rehacen con su módulo en I2; ver
// `daily_usage` en PLAN-GESTION.md §2 para lo persistido.
// ─────────────────────────────────────────────────────────────────────────────

const INTERVAL_MIN = Number(process.env.METRICS_INTERVAL_MIN ?? 5);
const MAX_LATENCY_SAMPLES = 200; // ventana deslizante por negocio: evita crecer sin límite

interface TenantCounter {
  events: number;
  latenciesMs: number[];
}

const byTenant = new Map<string, TenantCounter>();

function counterFor(tenantId: string): TenantCounter {
  let c = byTenant.get(tenantId);
  if (!c) {
    c = { events: 0, latenciesMs: [] };
    byTenant.set(tenantId, c);
  }
  return c;
}

/** Contar un evento nuevo (no un duplicado) de ESE negocio. */
export function recordEvent(tenantId: string): void {
  counterFor(tenantId).events++;
}

/** Registrar cuánto tardó la operación crítica de ESE negocio. */
export function recordLatency(tenantId: string, ms: number): void {
  const c = counterFor(tenantId);
  c.latenciesMs.push(ms);
  if (c.latenciesMs.length > MAX_LATENCY_SAMPLES) c.latenciesMs.shift();
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

// ─────────────────────────────────────────────────────────────────────────────
// Alerta por SLO de latencia: si el p95 de un negocio supera el umbral EN LA VENTANA DE
// REPORTE (la muestra deslizante de hasta MAX_LATENCY_SAMPLES), sale una alerta a la
// plataforma (./alerts.ts). La "ventana" ES el propio tick del reporte (cada
// INTERVAL_MIN), y el cooldown de la alerta evita re-alertar en ticks consecutivos
// mientras el negocio sigue lento.
// ─────────────────────────────────────────────────────────────────────────────
const SLO_LATENCY_P95_MS = Number(process.env.METRICS_SLO_LATENCY_P95_MS ?? 15_000);
const SLO_MIN_SAMPLES = 5; // con menos muestras en la ventana, un p95 es ruido, no señal
const SLO_ALERT_COOLDOWN_MS = 15 * 60_000; // no re-alertar antes de 15 min por negocio

let sloAlertsFiredForTests = 0;

function checkLatencySlo(tenantId: string, p95: number, n: number): void {
  if (n < SLO_MIN_SAMPLES) return;
  if (p95 <= SLO_LATENCY_P95_MS) return;
  const fired = alertPlatform({
    type: "latency_slo_breached",
    tenantId,
    severity: "warning",
    message: `p95 de latencia = ${p95} ms (umbral ${SLO_LATENCY_P95_MS} ms, n=${n})`,
    data: { p95, n, threshold: SLO_LATENCY_P95_MS },
    cooldownMs: SLO_ALERT_COOLDOWN_MS,
  });
  if (fired) sloAlertsFiredForTests++;
}

/** Solo para tests: resetea contadores por negocio y el contador de alertas de SLO. */
export function _resetMetricsForTests(): void {
  byTenant.clear();
  sloAlertsFiredForTests = 0;
}

/** Solo para tests: cuántas veces se cruzó el umbral+cooldown del SLO de latencia. */
export function _countSloAlertsForTests(): number {
  return sloAlertsFiredForTests;
}

/** Solo para tests: umbral vigente del SLO de latencia (para no hardcodear el default). */
export function _sloThresholdForTests(): number {
  return SLO_LATENCY_P95_MS;
}

/**
 * Solo para tests: corre el mismo chequeo de SLO que hace cada tick del reporte sobre
 * las muestras que ya dejó `recordLatency` para ESE negocio, sin depender del lease ni
 * del reloj. Calcula el p95 con la misma función que el reporte real.
 */
export function _forceSloCheckForTests(tenantId: string): void {
  const c = byTenant.get(tenantId);
  if (!c) return;
  const p95 = Math.round(percentile(c.latenciesMs, 95));
  checkLatencySlo(tenantId, p95, c.latenciesMs.length);
}

/** Arranca el volcado periódico a consola (con lease de liderazgo). Llamar UNA vez al iniciar. */
export function startMetricsReport(db: Executor | null): Loop {
  const intervalMs = INTERVAL_MIN * 60 * 1000;
  const loop = startLeaderLoop({
    db,
    label: "metrics",
    intervalMs,
    scalingHint: "Subir METRICS_INTERVAL_MIN si el reporte se vuelve muy seguido para los logs.",
    tick: async () => {
      const active = [...byTenant.entries()].filter(([, c]) => c.events > 0 || c.latenciesMs.length > 0);
      if (active.length === 0) {
        console.log(`[metrics] sin actividad en los últimos ${INTERVAL_MIN} min`);
      }
      for (const [tenantId, c] of active) {
        const perMin = (c.events / INTERVAL_MIN).toFixed(2);
        const avg = c.latenciesMs.length ? Math.round(c.latenciesMs.reduce((a, b) => a + b, 0) / c.latenciesMs.length) : 0;
        const p95 = Math.round(percentile(c.latenciesMs, 95));
        console.log(
          `[metrics] tenant=${tenantId} ${perMin} ev/min · latencia: avg=${avg}ms p95=${p95}ms (n=${c.latenciesMs.length})`,
        );
        checkLatencySlo(tenantId, p95, c.latenciesMs.length);
        c.events = 0; // reinicia el contador de la ventana; la latencia sigue siendo una muestra deslizante
      }
    },
    onError: (e, phase) => {
      console.error(`[metrics] ${phase}:`, e);
      captureError(e, { loop: "metrics", phase });
    },
  });
  console.log(`Métricas internas activas (reporte cada ${INTERVAL_MIN} min).`);
  return loop;
}
