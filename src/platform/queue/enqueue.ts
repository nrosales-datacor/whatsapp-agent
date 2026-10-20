import { and, eq, is, isNull } from "drizzle-orm";
import { PgTransaction } from "drizzle-orm/pg-core";
import { isTenantId, withSystem, withTenant, type Executor } from "../db/scope";
import { isValidJobType } from "./handlers";
import { jobs } from "./schema";

// ─────────────────────────────────────────────────────────────────────────────
// Encolar un job (patrón outbox).
//
// `enqueue(tx, …)` dentro de una transacción YA ABIERTA inserta con esa misma transacción:
// el job queda atómico con la escritura de dominio (si la transacción hace rollback, el
// job no existe; si hace commit, el worker lo ve). Corre con el contexto RLS que fijó el
// llamador, sin tocarlo: dentro de `withTenant(db, A, …)` solo se pueden encolar jobs de
// A (la política rechaza otro `businessId` o uno de sistema), dentro de `withSystem`
// cualquiera.
//
// Con el pool (`enqueue(db, …)`, fuera de transacción) abre la suya: `withTenant` del
// negocio del job o `withSystem` si es de sistema.
//
// `dedupeKey`: el mismo (negocio, clave) no se encola dos veces mientras la fila exista
// (incluye los ya terminados hasta que la purga los borra). Devuelve el id del que ya
// estaba con `created: false`. Para algo periódico, la clave lleva el período
// ("daily-summary:2026-10-20").
// ─────────────────────────────────────────────────────────────────────────────

export interface EnqueueOptions<T = unknown> {
  /** Tipo del job (p. ej. "email.send"); elige el handler (./handlers.ts). */
  type: string;
  /** Datos del job, serializables a JSON. Mejor ids que contenidos (ver `jobs.payload`). */
  payload: T;
  /** Negocio dueño del job; null/omitido = job de sistema. */
  businessId?: string | null;
  /** No correr antes de este instante (default: ya). */
  runAfter?: Date;
  /** Clave de idempotencia por negocio (ver cabecera). */
  dedupeKey?: string;
  /** Un solo job `running` a la vez por (negocio, groupKey), p. ej. el id de la conversación. */
  groupKey?: string;
  /** Intentos máximos (default de la tabla: 5). */
  maxAttempts?: number;
}

export interface EnqueueResult {
  id: string;
  /** false si `dedupeKey` ya existía y no se insertó nada. */
  created: boolean;
}

/** ¿El executor es una transacción abierta (y no el pool)? */
function isTransaction(executor: Executor): boolean {
  return is(executor, PgTransaction);
}

function validate(options: EnqueueOptions): void {
  if (!isValidJobType(options.type)) throw new Error(`enqueue: tipo de job inválido "${options.type}"`);
  if (options.businessId != null && !isTenantId(options.businessId)) {
    throw new Error("enqueue: businessId inválido (se espera un uuid o null)");
  }
  if (options.maxAttempts !== undefined && (!Number.isInteger(options.maxAttempts) || options.maxAttempts < 1)) {
    throw new Error("enqueue: maxAttempts debe ser un entero ≥ 1");
  }
  if (options.runAfter !== undefined && Number.isNaN(options.runAfter.getTime())) {
    throw new Error("enqueue: runAfter no es una fecha válida");
  }
  if (options.dedupeKey === "" || options.groupKey === "") throw new Error("enqueue: dedupeKey/groupKey no pueden ser vacíos");
}

async function insertJob(tx: Executor, options: EnqueueOptions): Promise<EnqueueResult> {
  const businessId = options.businessId ?? null;
  // Un conflicto de dedupe con una fila que justo se purga entre el INSERT y el SELECT
  // deja el SELECT vacío: se reintenta el INSERT (en la segunda vuelta ya no choca).
  for (let i = 0; i < 3; i++) {
    const inserted = await tx
      .insert(jobs)
      .values({
        businessId,
        type: options.type,
        payload: options.payload ?? {},
        dedupeKey: options.dedupeKey ?? null,
        groupKey: options.groupKey ?? null,
        ...(options.runAfter ? { runAfter: options.runAfter } : {}),
        ...(options.maxAttempts ? { maxAttempts: options.maxAttempts } : {}),
      })
      // Sin target: cubre los dos índices únicos de dedupe (por negocio y de sistema).
      .onConflictDoNothing()
      .returning({ id: jobs.id });
    if (inserted.length > 0) return { id: inserted[0].id, created: true };
    if (!options.dedupeKey) break; // sin clave no hay conflicto posible: no debería pasar

    const existing = await tx
      .select({ id: jobs.id })
      .from(jobs)
      .where(
        and(eq(jobs.dedupeKey, options.dedupeKey), businessId === null ? isNull(jobs.businessId) : eq(jobs.businessId, businessId)),
      )
      .limit(1);
    if (existing.length > 0) return { id: existing[0].id, created: false };
  }
  throw new Error("enqueue: no se pudo insertar ni encontrar el job (conflicto de dedupe inesperado)");
}

/**
 * Encola un job. Con una transacción abierta, dentro de ella (outbox); con el pool, en
 * una transacción propia acotada al negocio del job (ver cabecera).
 */
export async function enqueue<T>(executor: Executor, options: EnqueueOptions<T>): Promise<EnqueueResult> {
  validate(options);
  if (isTransaction(executor)) return insertJob(executor, options);
  const businessId = options.businessId ?? null;
  return businessId === null
    ? withSystem(executor, (tx) => insertJob(tx, options))
    : withTenant(executor, businessId, (tx) => insertJob(tx, options));
}
