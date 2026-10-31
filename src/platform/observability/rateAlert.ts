import { alertPlatform, type Alert, type AlertType } from "./alerts";

// ─────────────────────────────────────────────────────────────────────────────
// Alerta por TASA: "N eventos de este tipo dentro de una ventana" (lección del motor
// viejo, F11, que ya usaba el DLQ por negocio en ../queue/stats.ts). Un evento suelto
// (un turno del agente que falló, un envío a Meta rechazado) es ruido; muchos seguidos
// son un modo de falla real —el proveedor caído, la cuenta bloqueada— y tienen que llegar
// a un humano. Sobre el umbral, la alerta sale por `alertPlatform`, con su cooldown por
// (tipo, negocio): mientras el problema siga, no se repite en cada evento.
//
// La ventana es por (tipo, clave). Por convención la clave es el negocio
// (`tenantId`), o null para la cuenta GLOBAL de la plataforma: un detector que quiera
// las dos llama dos veces (una con el negocio y otra con null), con umbrales propios.
//
// Estado en memoria del PROCESO, como el cooldown de alertas: con N réplicas, cada una
// cuenta lo suyo (un umbral "por réplica" — aceptable, y los turnos de un negocio corren
// en la réplica que los reclama). Sin dependencias. Lo reusan otros detectores
// (fallback del modelo, topes de gasto): este archivo es el dueño del patrón.
// ─────────────────────────────────────────────────────────────────────────────

export interface RateAlertOptions extends Omit<Alert, "message" | "data"> {
  /** Eventos dentro de la ventana a partir de los cuales se alerta (≥1). */
  threshold: number;
  /** Largo de la ventana deslizante, en ms. */
  windowMs: number;
  /** Texto de la alerta, con la cuenta de eventos en la ventana. SIN datos personales. */
  message: (count: number) => string;
  /** Datos extra (se les suma `count`, `threshold` y `windowMin`). SIN datos personales. */
  data?: Record<string, unknown>;
}

/** Tope de marcas por clave: un evento a ráfagas no hace crecer la memoria sin límite. */
const MAX_EVENTS_PER_KEY = 10_000;

/** Marcas de tiempo (epoch ms) de los eventos recientes por (tipo, clave). */
const eventsByKey = new Map<string, number[]>();

const keyOf = (type: AlertType, tenantId?: string | null) => `${type}:${tenantId ?? "*"}`;

/**
 * Registra UN evento de (tipo, negocio) y alerta si la ventana llegó al umbral. Devuelve
 * true si salió una alerta (false: debajo del umbral, o absorbida por el cooldown).
 * Nunca lanza: se llama desde un `catch` del camino caliente.
 */
export function rateAlert(options: RateAlertOptions, now: number = Date.now()): boolean {
  const { threshold, windowMs, message, data, ...alert } = options;
  const key = keyOf(alert.type, alert.tenantId);
  const recent = (eventsByKey.get(key) ?? []).filter((t) => now - t < windowMs);
  recent.push(now);
  if (recent.length > MAX_EVENTS_PER_KEY) recent.splice(0, recent.length - MAX_EVENTS_PER_KEY);
  eventsByKey.set(key, recent);
  if (recent.length < Math.max(1, threshold)) return false;
  const windowMin = Math.round(windowMs / 60_000);
  return alertPlatform(
    { ...alert, message: message(recent.length), data: { ...data, count: recent.length, threshold, windowMin } },
    now,
  );
}

/** Cuántos eventos de (tipo, negocio) hay ahora en la ventana (para tests y diagnósticos). */
export function rateAlertCount(type: AlertType, tenantId: string | null | undefined, windowMs: number, now: number = Date.now()): number {
  return (eventsByKey.get(keyOf(type, tenantId)) ?? []).filter((t) => now - t < windowMs).length;
}

/** Solo para tests: limpia las ventanas (de un tipo, o todas). */
export function _resetRateAlertsForTests(type?: AlertType): void {
  if (type === undefined) {
    eventsByKey.clear();
    return;
  }
  for (const key of [...eventsByKey.keys()]) if (key.startsWith(`${type}:`)) eventsByKey.delete(key);
}

/**
 * Número de una variable de entorno (umbrales de las alertas). Vacía, inválida o menor que
 * `min` → `fallback`. Se lee en cada llamada (no al importar): un cambio de `.env` entra
 * con el reinicio y los tests pueden fijarla. A diferencia de `msFromEnv`, acepta 0
 * cuando `min` lo permite (0 = detector apagado).
 */
export function numberFromEnv(name: string, fallback: number, min = 0): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= min ? n : fallback;
}
