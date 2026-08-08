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

// E5-b (ráfaga): coalescing/debounce por conversación. Si al reclamar un job hay
// otro job PENDIENTE de la MISMA conversación con un `creado_en` más nuevo, este
// job quedó obsoleto — el cliente ya escribió algo más y el mensaje más nuevo va a
// releer el historial completo (E5-a) de todos modos, así que responder a este
// generaría una respuesta duplicada/incoherente. Se marca "reemplazado" (no se
// llama a `responderEntrante`) y seguimos al siguiente candidato.
//
// No agregamos una columna `conversacion_id` a `wa_jobs` (evitamos migración):
// `payload.conv.id` ya viaja en el JSONB de TODOS los jobs (`Pendiente.conv` es
// obligatorio en el tipo), así que alcanza con leerlo vía `payload->'conv'->>'id'`.
// No se agrega índice nuevo: en operación normal la cola pendiente tiene pocas
// filas (se procesa casi en tiempo real), así que un filtro sobre esas pocas filas
// no cambia el plan del claim principal (que sigue usando `wa_jobs_claim_idx`).
//
// Se usa `creado_en` (no `ejecutar_despues_de`) para decidir "más nuevo": el
// backoff de reintentos empuja `ejecutar_despues_de` al futuro sin tocar
// `creado_en`, que refleja el orden real de llegada de los mensajes.
//
// Atomicidad: la comparación pasa DENTRO de la misma transacción que reclama el
// job (antes de marcarlo "procesando"), bajo el lock de `FOR UPDATE SKIP LOCKED`
// del job reclamado. Como la condición es estrictamente "más nuevo que YO", dos
// jobs de la misma conversación no pueden reemplazarse mutuamente: el más viejo
// puede ceder ante el más nuevo, pero el más nuevo nunca encuentra algo "más nuevo
// que él mismo" en ese chequeo.
//
// "reemplazado" es un estado nuevo (columna `estado` es texto libre, sin check
// constraint) que significa "no se respondió a propósito, superseded por un
// mensaje más nuevo de la misma conversación" — distinto de "hecho" (se respondió
// bien) y de "error" (falló). No lo cuenta `profundidadCola` (solo mira
// 'pendiente'), así que no ensucia esa métrica.
const ESTADO_REEMPLAZADO = "reemplazado";

/**
 * Reclama un job pendiente (FOR UPDATE SKIP LOCKED) y lo pone en "procesando".
 * Devuelve null si no hay ninguno listo. Toda la lógica va en una transacción
 * corta para que el lock quede liberado antes de llamar al LLM.
 *
 * Internamente puede reclamar y descartar (marcar "reemplazado") varios jobs
 * obsoletos de una ráfaga antes de devolver el que corresponde procesar (el más
 * nuevo de cada conversación) — ver comentario de E5-b arriba.
 */
export async function reclamarUno(db: DB): Promise<Job | null> {
  while (true) {
    const resultado = await db.transaction(async (tx) => {
      const rows = filasDe<{
        id: string;
        tenant_id: string;
        intentos: number;
        max_intentos: number;
        payload: PendienteSerializado;
        creado_en: Date;
      }>(
        await tx.execute(sql`
        SELECT id, tenant_id, intentos, max_intentos, payload, creado_en
          FROM wa_jobs
         WHERE estado = 'pendiente' AND ejecutar_despues_de <= now()
         ORDER BY ejecutar_despues_de ASC
         FOR UPDATE SKIP LOCKED
         LIMIT 1
      `),
      );

      if (rows.length === 0) return { tipo: "vacio" as const };
      const r = rows[0];

      const conversacionId = r.payload?.conv?.id;
      if (conversacionId) {
        const masNuevo = filasDe<{ id: string }>(
          await tx.execute(sql`
          SELECT id FROM wa_jobs
           WHERE estado = 'pendiente'
             AND payload->'conv'->>'id' = ${conversacionId}
             AND creado_en > ${r.creado_en}
           LIMIT 1
        `),
        );
        if (masNuevo.length > 0) {
          await tx.execute(sql`
            UPDATE wa_jobs
               SET estado = ${ESTADO_REEMPLAZADO}, locked_at = NULL, finalizado_en = now()
             WHERE id = ${r.id}
          `);
          return { tipo: "reemplazado" as const };
        }
      }

      await tx.execute(sql`
        UPDATE wa_jobs
           SET estado = 'procesando', locked_at = now(), intentos = intentos + 1
         WHERE id = ${r.id}
      `);

      return {
        tipo: "job" as const,
        job: {
          id: r.id,
          tenantId: r.tenant_id,
          intentos: r.intentos + 1,
          maxIntentos: r.max_intentos,
          payload: r.payload,
        },
      };
    });

    if (resultado.tipo === "vacio") return null;
    if (resultado.tipo === "reemplazado") continue; // sigue buscando el siguiente candidato
    return resultado.job;
  }
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
