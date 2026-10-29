import { alertPlatform } from "../observability/alerts";

// ─────────────────────────────────────────────────────────────────────────────
// Métricas de la cola POR TIPO de job, en memoria del proceso (mismo criterio que
// src/platform/observability/metrics.ts: sin dependencias ni serie temporal persistida;
// se pierden en cada restart). Cada evento además sale por log estructurado desde el
// worker. Lo persistido (profundidad por estado) se consulta con `countJobs` (./admin.ts).
//
// Alerta por DLQ POR NEGOCIO (lección del motor viejo, F11): un evento por cada job que
// llega a `dead` sería ruido (con 50 negocios, decenas de alertas por un proveedor caído);
// se alerta cuando UN negocio junta `DEAD_ALERT_THRESHOLD` jobs muertos dentro de la
// ventana, con el cooldown de alertPlatform para no repetir.
// ─────────────────────────────────────────────────────────────────────────────

export interface JobTypeStats {
  claimed: number;
  done: number;
  retried: number;
  dead: number;
  recovered: number;
  timedOut: number;
  /** Duración de los intentos terminados (ok o con error), en ms. */
  totalMs: number;
  maxMs: number;
}

const byType = new Map<string, JobTypeStats>();

function statsFor(type: string): JobTypeStats {
  let s = byType.get(type);
  if (!s) {
    s = { claimed: 0, done: 0, retried: 0, dead: 0, recovered: 0, timedOut: 0, totalMs: 0, maxMs: 0 };
    byType.set(type, s);
  }
  return s;
}

export type JobEvent = "claimed" | "done" | "retried" | "dead" | "recovered" | "timedOut";

/** Suma un evento de `type`; con `durationMs`, además la duración del intento. */
export function recordJobEvent(type: string, event: JobEvent, durationMs?: number): void {
  const s = statsFor(type);
  s[event]++;
  if (durationMs !== undefined) {
    s.totalMs += durationMs;
    if (durationMs > s.maxMs) s.maxMs = durationMs;
  }
}

/** Foto de las métricas por tipo (copia: el llamador puede guardarla). */
export function getQueueStats(): Record<string, JobTypeStats & { avgMs: number }> {
  const out: Record<string, JobTypeStats & { avgMs: number }> = {};
  for (const [type, s] of byType) {
    const finished = s.done + s.retried + s.dead;
    out[type] = { ...s, avgMs: finished > 0 ? Math.round(s.totalMs / finished) : 0 };
  }
  return out;
}

const DEAD_ALERT_WINDOW_MS = 10 * 60_000;
const DEAD_ALERT_THRESHOLD = 5;
const DEAD_ALERT_COOLDOWN_MS = 15 * 60_000;

const deadByBusiness = new Map<string, number[]>();

/**
 * Registra un job que llegó a `dead` y alerta si su negocio (o el sistema) cruzó el
 * umbral en la ventana. Devuelve true si salió una alerta.
 */
export function trackDeadJob(businessId: string | null, type: string, now: number = Date.now()): boolean {
  const key = businessId ?? "system";
  const recent = (deadByBusiness.get(key) ?? []).filter((t) => now - t < DEAD_ALERT_WINDOW_MS);
  recent.push(now);
  deadByBusiness.set(key, recent);
  if (recent.length < DEAD_ALERT_THRESHOLD) return false;
  return alertPlatform(
    {
      type: "queue_jobs_dead",
      tenantId: businessId,
      severity: "warning",
      message: `${recent.length} job(s) en dead (DLQ) en los últimos ${DEAD_ALERT_WINDOW_MS / 60_000} min (último: ${type})`,
      data: { count: recent.length, lastJobType: type, windowMin: DEAD_ALERT_WINDOW_MS / 60_000 },
      cooldownMs: DEAD_ALERT_COOLDOWN_MS,
    },
    now,
  );
}

/** Solo para tests: limpia métricas y ventanas de alerta. */
export function _resetQueueStatsForTests(): void {
  byType.clear();
  deadByBusiness.clear();
}
