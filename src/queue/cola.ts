import { eq, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { waJobs, schema } from "../db/schema";
import { filasDe } from "../db/filas";
import type { PendienteSerializado } from "../types";

// ─────────────────────────────────────────────────────────────────────────────
// Cola durable de jobs sobre wa_jobs (ROADMAP B1).
//
// Patrón: claim en transacción corta con FOR UPDATE SKIP LOCKED → trabajo fuera
// de transacción (LLM, segundos) → marcar hecho/error. El reaper reencola jobs
// que quedaron en "procesando" más de umbralSeg (crash a mitad del trabajo).
//
// Semántica: at-least-once. Si el proceso muere después de enviar el WhatsApp
// pero antes de marcarHecho, el job se re-ejecuta → posible respuesta duplicada
// (raro: solo en esa ventana). Aceptado para el piloto.
//
// Pooler-safe: FOR UPDATE SKIP LOCKED corre dentro de db.transaction (postgres.js
// fija una conexión por transacción). No usamos advisory locks de sesión.
// ─────────────────────────────────────────────────────────────────────────────

type DB = PostgresJsDatabase<typeof schema>;

/** Fila de wa_jobs tal como la devuelve el SELECT crudo (snake_case). */
export interface Job {
  id: string;
  tenantId: string;
  intentos: number;
  maxIntentos: number;
  payload: PendienteSerializado;
}

/**
 * Reclama un job pendiente (FOR UPDATE SKIP LOCKED) y lo pone en "procesando".
 * Devuelve null si no hay ninguno listo. Toda la lógica va en una transacción
 * corta para que el lock quede liberado antes de llamar al LLM.
 */
export async function reclamarUno(db: DB): Promise<Job | null> {
  return db.transaction(async (tx) => {
    const rows = filasDe<{
      id: string;
      tenant_id: string;
      intentos: number;
      max_intentos: number;
      payload: PendienteSerializado;
    }>(
      await tx.execute(sql`
      SELECT id, tenant_id, intentos, max_intentos, payload
        FROM wa_jobs
       WHERE estado = 'pendiente' AND ejecutar_despues_de <= now()
       ORDER BY ejecutar_despues_de ASC
       FOR UPDATE SKIP LOCKED
       LIMIT 1
    `),
    );

    if (rows.length === 0) return null;
    const r = rows[0];

    await tx.execute(sql`
      UPDATE wa_jobs
         SET estado = 'procesando', locked_at = now(), intentos = intentos + 1
       WHERE id = ${r.id}
    `);

    return {
      id: r.id,
      tenantId: r.tenant_id,
      intentos: r.intentos + 1,
      maxIntentos: r.max_intentos,
      payload: r.payload,
    };
  });
}

/** Marca el job como completado exitosamente. */
export async function marcarHecho(db: DB, id: string): Promise<void> {
  await db
    .update(waJobs)
    .set({ estado: "hecho", finalizadoEn: new Date(), lockedAt: null })
    .where(eq(waJobs.id, id));
}

/** true si ya no quedan reintentos (se marca "error" definitivo). */
export function agotoIntentos(intentos: number, maxIntentos: number): boolean {
  return intentos >= maxIntentos;
}

/** Backoff exponencial en segundos para el próximo reintento: min(2^intentos, 60). */
export function calcularBackoffSeg(intentos: number): number {
  return Math.min(Math.pow(2, intentos), 60);
}

/**
 * Si quedan intentos, reencola con backoff exponencial (min(2^intentos, 60)s).
 * Si se agotaron, marca como "error" definitivo.
 */
export async function marcarFalloOReintentar(
  db: DB,
  id: string,
  error: string,
  intentos: number,
  maxIntentos: number,
): Promise<void> {
  if (agotoIntentos(intentos, maxIntentos)) {
    await db
      .update(waJobs)
      .set({ estado: "error", ultimoError: error, finalizadoEn: new Date(), lockedAt: null })
      .where(eq(waJobs.id, id));
    return;
  }
  const retrasoSeg = calcularBackoffSeg(intentos);
  await db.execute(sql`
    UPDATE wa_jobs
       SET estado = 'pendiente',
           ultimo_error = ${error},
           locked_at = NULL,
           ejecutar_despues_de = now() + ${retrasoSeg} * interval '1 second'
     WHERE id = ${id}
  `);
}

/**
 * Reencola jobs zombis: aquellos en "procesando" cuyo locked_at es más viejo que
 * umbralSeg segundos. Cubre el caso de crash a mitad del trabajo.
 * Devuelve la cantidad reencolada (para loguear).
 */
export async function reencolarVencidos(db: DB, umbralSeg = 180): Promise<number> {
  const rows = filasDe<{ id: string }>(
    await db.execute(sql`
    UPDATE wa_jobs
       SET estado = 'pendiente', locked_at = NULL
     WHERE estado = 'procesando'
       AND locked_at < now() - ${umbralSeg} * interval '1 second'
    RETURNING id
  `),
  );
  return rows.length;
}
