import { isTransientError } from "../net/transient";

// ─────────────────────────────────────────────────────────────────────────────
// Qué hace la cola con el error de un handler, y cuánto espera antes de reintentar.
//
// Clasificación (se recorre la cadena de `cause`, igual que `isTransientError`):
//   • transient: `isTransientError` (red/timeout, 408/409/429/5xx, o la marca
//     `transient: true`) → reintenta con backoff mientras queden intentos.
//   • permanent: `PermanentJobError`, la marca `permanent: true` o `transient: false`
//     explícito (p. ej. el 400 de un proveedor que ya avisa que no se arregla solo) →
//     directo a `dead`, sin gastar los intentos que quedan.
//   • unknown: cualquier otra excepción (un bug, un error sin clasificar). Reintenta como
//     el transitorio: es lo conservador (si era un hipo, se resuelve; si es un bug, llega
//     a `dead` al agotar los intentos y queda visible en el DLQ).
// ─────────────────────────────────────────────────────────────────────────────

export type JobErrorKind = "transient" | "permanent" | "unknown";

/**
 * Error que NO se arregla reintentando (datos inválidos, recurso que ya no existe,
 * destinatario rechazado): el job pasa directo a `dead`. Otros módulos pueden lograr lo
 * mismo sin importar esta clase, con la marca `permanent: true` en su propio error.
 */
export class PermanentJobError extends Error {
  readonly permanent = true;
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "PermanentJobError";
  }
}

/** Un intento que superó el `timeoutMs` del handler. Transitorio: se reintenta. */
export class JobTimeoutError extends Error {
  readonly transient = true;
  constructor(timeoutMs: number) {
    super(`el job superó su timeout de ${timeoutMs} ms`);
    this.name = "JobTimeoutError";
  }
}

function isMarkedPermanent(e: unknown): boolean {
  let current: unknown = e;
  for (let i = 0; current && i < 5; i++) {
    if (current instanceof PermanentJobError) return true;
    if ((current as { permanent?: unknown }).permanent === true) return true;
    if ((current as { transient?: unknown }).transient === false) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/** Clasifica el error de un handler (ver cabecera). */
export function classifyJobError(e: unknown): JobErrorKind {
  if (isMarkedPermanent(e)) return "permanent";
  if (isTransientError(e)) return "transient";
  return "unknown";
}

export interface BackoffOptions {
  /** Espera base del primer reintento (ms). */
  baseMs: number;
  /** Tope de la espera (ms). */
  maxMs: number;
}

export const DEFAULT_BACKOFF: BackoffOptions = { baseMs: 2_000, maxMs: 5 * 60_000 };

/**
 * Espera antes del próximo intento, después de que falló el intento número `attempt`
 * (1 = el primero). Exponencial (`baseMs · 2^(attempt-1)`, con tope `maxMs`) con jitter
 * "mitad fija + mitad al azar": nunca menos de la mitad de la exponencial (así no se
 * martilla al proveedor) y los jobs que fallaron juntos (una caída de 30 s) no vuelven
 * todos en el mismo milisegundo.
 */
export function computeBackoffMs(attempt: number, options: BackoffOptions = DEFAULT_BACKOFF, random: () => number = Math.random): number {
  const n = Math.max(1, Math.floor(attempt));
  const exp = Math.min(options.maxMs, options.baseMs * 2 ** Math.min(n - 1, 30));
  const half = exp / 2;
  return Math.round(half + random() * half);
}

const MAX_ERROR_LENGTH = 2_000;

/** Texto del error para `last_error` y los logs: nombre + mensaje, recortado. */
export function describeJobError(e: unknown): string {
  const text = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  return text.length > MAX_ERROR_LENGTH ? `${text.slice(0, MAX_ERROR_LENGTH)}…` : text;
}
