import type { Executor } from "../db/scope";
import type { BackoffOptions } from "./errors";

// ─────────────────────────────────────────────────────────────────────────────
// Registro de handlers de la cola: qué función corre cada `type` de job.
//
// Cada módulo registra los suyos al cargar (p. ej. el módulo de correo registra
// "email.send"). El worker (./worker.ts) SOLO reclama los tipos registrados en su proceso:
// en un deploy escalonado, una réplica vieja que todavía no conoce un tipo nuevo no lo
// toma (ni lo manda al DLQ por "no sé qué hacer con esto"): lo deja para una que sí.
//
// Contrato del handler:
//   • Semántica at-least-once: un crash entre el efecto y el "hecho" repite el job. El
//     handler tiene que ser idempotente o tolerar la repetición (p. ej. chequear si el
//     correo ya salió, o usar la clave de idempotencia del proveedor).
//   • Corre FUERA de transacción: para tocar la base abre la suya (`withTenant` con
//     `ctx.businessId`). Así una llamada externa lenta no retiene una conexión con locks.
//   • Para reintentar, que lance. Un error permanente (ver ./errors.ts) va directo a `dead`.
//     El mensaje del error va a `last_error` y a los logs: sin datos personales (ver
//     src/platform/observability/privacy.ts).
//   • Con `timeoutMs`, al vencer se aborta `ctx.signal`: el handler tiene que pasarlo a sus
//     `fetch` y llamadas externas. La cola no puede matar una promesa: si el handler ignora
//     la señal, sigue corriendo en segundo plano mientras el job ya se reintenta.
// ─────────────────────────────────────────────────────────────────────────────

/** Lo que recibe un handler además del payload. */
export interface JobContext {
  jobId: string;
  type: string;
  /** Negocio del job; null = job de sistema. */
  businessId: string | null;
  /** Número de este intento (1 = el primero). */
  attempt: number;
  maxAttempts: number;
  /** true si un fallo ahora manda el job a `dead` (p. ej. para avisar al cliente o al operador). */
  isLastAttempt: boolean;
  /** Se aborta al vencer `timeoutMs`. */
  signal: AbortSignal;
  /** Pool del proceso (para abrir `withTenant`/`withSystem`). */
  db: Executor;
}

export type JobHandler<T = unknown> = (payload: T, ctx: JobContext) => Promise<void>;

export interface JobHandlerOptions {
  /** Máximo de jobs de este tipo en vuelo A LA VEZ en este proceso (default: sin tope propio, solo el del worker). */
  concurrency?: number;
  /** Tope de cada intento (ms). Al vencer, el intento cuenta como fallo transitorio. Sin tope por defecto. */
  timeoutMs?: number;
  /** Backoff de los reintentos de este tipo (default ./errors.ts DEFAULT_BACKOFF). */
  backoff?: Partial<BackoffOptions>;
}

export interface RegisteredHandler {
  type: string;
  handler: JobHandler<unknown>;
  concurrency: number;
  timeoutMs: number | null;
  backoff: Partial<BackoffOptions>;
}

const handlers = new Map<string, RegisteredHandler>();

const TYPE_PATTERN = /^[a-z][a-z0-9_-]*(\.[a-z][a-z0-9_-]*)*$/;

function positiveIntOrNull(n: number | undefined, label: string): number | null {
  if (n === undefined) return null;
  if (!Number.isInteger(n) || n < 1) throw new Error(`registerJobHandler: ${label} debe ser un entero ≥ 1`);
  return n;
}

/**
 * Registra el handler del tipo `type` (p. ej. "email.send"). Un tipo se registra UNA vez
 * por proceso: registrarlo dos veces es un bug (dos módulos peleando por el mismo nombre).
 */
export function registerJobHandler<T>(type: string, handler: JobHandler<T>, options: JobHandlerOptions = {}): void {
  if (!TYPE_PATTERN.test(type)) {
    throw new Error(`registerJobHandler: tipo inválido "${type}" (minúsculas, dígitos, _ o -, en partes separadas por punto)`);
  }
  if (handlers.has(type)) throw new Error(`registerJobHandler: el tipo "${type}" ya tiene handler`);
  handlers.set(type, {
    type,
    handler: handler as JobHandler<unknown>,
    concurrency: positiveIntOrNull(options.concurrency, "concurrency") ?? Number.POSITIVE_INFINITY,
    timeoutMs: positiveIntOrNull(options.timeoutMs, "timeoutMs"),
    backoff: options.backoff ?? {},
  });
}

/** Handler registrado para `type`, o undefined. */
export function getJobHandler(type: string): RegisteredHandler | undefined {
  return handlers.get(type);
}

/** Todos los handlers registrados en este proceso. */
export function registeredJobHandlers(): RegisteredHandler[] {
  return [...handlers.values()];
}

/** true si `type` cumple el formato de los tipos de job (lo valida también `enqueue`). */
export function isValidJobType(type: string): boolean {
  return TYPE_PATTERN.test(type);
}

/** Solo para tests: olvida todos los handlers. */
export function _resetJobHandlersForTests(): void {
  handlers.clear();
}
