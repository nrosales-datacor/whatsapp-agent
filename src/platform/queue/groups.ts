import { sql } from "drizzle-orm";
import { rowsOf } from "../db/rows";
import { withSystem, withTenant, type Executor } from "../db/scope";

// ─────────────────────────────────────────────────────────────────────────────
// Ráfagas dentro de un grupo de la cola (portado de la regla 3 de
// legacy/src/queue/cola.ts, "ráfagas H1").
//
// Con `groupKey` (p. ej. una conversación) la cola corre como mucho un job a la vez por
// grupo y en orden. Si el cliente manda tres mensajes seguidos, cada uno queda como un
// job; si el turno más nuevo va a releer el historial completo, contestar cada mensaje
// viejo por separado duplicaría respuestas. El handler del job viejo pregunta acá si hay
// un job MÁS NUEVO del mismo grupo y tipo que lo vaya a absorber y, si lo hay, termina
// sin hacer nada (cede).
//
// Qué jobs absorben lo decide el módulo con una marca booleana en el payload
// (`payloadFlag`, p. ej. "rereadsHistory"); qué jobs pueden ceder lo decide el handler
// (solo los que no tienen efectos propios). La cola no sabe nada de WhatsApp.
//
// Estados que cuentan: el más nuevo todavía no corrió (`pending`/`failed`), o —solo si
// `includeDone`— ya terminó bien. Lo segundo es para un job que vuelve de un fallo
// transitorio después de que un turno posterior ya se respondió: contestarlo ahora
// llegaría fuera de orden. En el primer intento no se usa: el más nuevo pudo haber leído
// el historial antes de que el viejo se confirmara (dos webhooks casi simultáneos).
// ─────────────────────────────────────────────────────────────────────────────

export interface NewerGroupJobQuery {
  /** El job que pregunta (el que está corriendo). */
  jobId: string;
  /** Negocio del job (null = de sistema). Fija el contexto RLS de la consulta. */
  businessId: string | null;
  /** Clave del payload que tiene que valer `true` en el job más nuevo. */
  payloadFlag: string;
  /** También cuenta un job más nuevo ya terminado (`done`). */
  includeDone?: boolean;
}

const FLAG_PATTERN = /^[A-Za-z][A-Za-z0-9_]*$/;

/**
 * ¿Hay en el mismo grupo un job más nuevo del mismo tipo, con `payload[payloadFlag] =
 * true`, que todavía no corrió (o ya terminó, con `includeDone`)? false si el job no tiene
 * grupo o no existe.
 */
export async function hasNewerGroupJob(db: Executor, query: NewerGroupJobQuery): Promise<boolean> {
  if (!FLAG_PATTERN.test(query.payloadFlag)) throw new Error(`hasNewerGroupJob: payloadFlag inválido "${query.payloadFlag}"`);
  const includeDone = query.includeDone === true;
  const run = async (tx: Executor) =>
    rowsOf<{ id: string }>(
      await tx.execute(sql`
        SELECT n.id
          FROM jobs c
          JOIN jobs n
            ON n.group_key = c.group_key
           AND n.business_id IS NOT DISTINCT FROM c.business_id
           AND n.type = c.type
           AND n.id <> c.id
         WHERE c.id = ${query.jobId}
           AND c.group_key IS NOT NULL
           AND n.created_at > c.created_at
           AND n.payload ->> ${query.payloadFlag} = 'true'
           AND (n.status IN ('pending', 'failed') OR (${includeDone} AND n.status = 'done'))
         LIMIT 1
      `),
    );
  const rows = query.businessId === null ? await withSystem(db, run) : await withTenant(db, query.businessId, run);
  return rows.length > 0;
}
