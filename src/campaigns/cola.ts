import { eq, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { waCampaniaEnvios, schema } from "../db/schema";
import { filasDe } from "../db/filas";

// ─────────────────────────────────────────────────────────────────────────────
// Mini-cola de envíos de campaña (ROADMAP C3.2), sobre wa_campania_envios.
// Copia estructural de src/queue/cola.ts (B1: claim con FOR UPDATE SKIP LOCKED
// en transacción corta, trabajo fuera de la transacción, backoff exponencial),
// pero DELIBERADAMENTE independiente de wa_jobs: esa cola está tipada hard a
// PendienteSerializado y su worker asume siempre "responder_entrante" — forzar
// un tipo de job nuevo ahí arriesga la pieza de fiabilidad más crítica del
// sistema para una feature que no es tiempo-crítica (un envío de campaña puede
// esperar unos segundos más sin drama).
//
// La única diferencia real con cola.ts: el claim exige que la CAMPAÑA padre siga
// en estado 'enviando' (join a wa_campanias) — si el dueño cancela a mitad de
// camino, los envíos pendientes dejan de reclamarse solos, sin lógica aparte.
// ─────────────────────────────────────────────────────────────────────────────

type DB = PostgresJsDatabase<typeof schema>;

export interface EnvioReclamado {
  id: string;
  campaniaId: string;
  tenantId: string;
  clienteWa: string;
  clienteNombre: string;
  mensaje: string;
  intentos: number;
}

/**
 * Reclama un envío pendiente cuya campaña siga "enviando" (FOR UPDATE SKIP
 * LOCKED) y lo pone en "procesando". Devuelve null si no hay ninguno listo.
 *
 * Reparto por tenant (F8, PLAN-ESCALA-MULTITENANT): antes se tomaba el envío
 * pendiente más viejo SIN mirar el tenant — una campaña de 5.000 destinatarios
 * de un negocio monopolizaba el worker mientras las campañas de los otros 49
 * esperaban en fila. Ahora se prioriza primero el TENANT que hace más tiempo
 * no recibe un turno (su último envío 'enviado' más antiguo, o nunca envió
 * = va primero), y recién dentro de ese tenant el envío más viejo.
 *
 * Se implementa con un LEFT JOIN a una subconsulta agregada (no una subconsulta
 * CORRELACIONADA en el ORDER BY): así el `max(enviado_en) GROUP BY tenant_id`
 * se calcula UNA sola vez y se hace hash join contra los candidatos, en vez de
 * ejecutarse una vez POR CADA fila pendiente. La subconsulta escanea
 * wa_campania_envios con estado='enviado' (usa el índice de `estado`,
 * wa_campania_envios_claim_idx); ese subconjunto lo mantiene chico la purga
 * por retención (F11, purgarEnviosFinalizados), así que el costo queda acotado
 * en la práctica aunque no exista un índice compuesto (tenant_id, estado) —
 * agregarlo requeriría tocar schema.ts/una migración, fuera de alcance de F8.
 *
 * Sigue siendo UNA sola consulta con `FOR UPDATE OF e SKIP LOCKED`: el join a
 * la subconsulta no cambia qué fila de `e` se bloquea, solo el ORDEN en que se
 * ofrecen las filas candidatas.
 */
export async function reclamarEnvio(db: DB): Promise<EnvioReclamado | null> {
  return db.transaction(async (tx) => {
    const rows = filasDe<{
      id: string;
      campania_id: string;
      tenant_id: string;
      cliente_wa: string;
      cliente_nombre: string;
      intentos: number;
      mensaje: string;
    }>(
      await tx.execute(sql`
      SELECT e.id, e.campania_id, e.tenant_id, e.cliente_wa, e.cliente_nombre, e.intentos, c.mensaje
        FROM wa_campania_envios e
        JOIN wa_campanias c ON c.id = e.campania_id
        LEFT JOIN (
          SELECT tenant_id, max(enviado_en) AS ultimo_envio
            FROM wa_campania_envios
           WHERE estado = 'enviado'
           GROUP BY tenant_id
        ) u ON u.tenant_id = e.tenant_id
       WHERE e.estado = 'pendiente' AND c.estado = 'enviando'
       ORDER BY u.ultimo_envio ASC NULLS FIRST, e.creado_en ASC
       FOR UPDATE OF e SKIP LOCKED
       LIMIT 1
    `),
    );

    if (rows.length === 0) return null;
    const r = rows[0];

    await tx.execute(sql`
      UPDATE wa_campania_envios
         SET estado = 'procesando', intentos = intentos + 1
       WHERE id = ${r.id}
    `);

    return {
      id: r.id,
      campaniaId: r.campania_id,
      tenantId: r.tenant_id,
      clienteWa: r.cliente_wa,
      clienteNombre: r.cliente_nombre,
      mensaje: r.mensaje,
      intentos: r.intentos + 1,
    };
  });
}

/** Marca el envío como completado exitosamente. */
export async function marcarEnviado(db: DB, id: string): Promise<void> {
  await db
    .update(waCampaniaEnvios)
    .set({ estado: "enviado", enviadoEn: new Date() })
    .where(eq(waCampaniaEnvios.id, id));
}

/** El cliente pidió baja entre que se armó el segmento y que le tocó el turno: no se envía. */
export async function marcarOmitidoOptOut(db: DB, id: string): Promise<void> {
  await db.update(waCampaniaEnvios).set({ estado: "omitido_opt_out" }).where(eq(waCampaniaEnvios.id, id));
}

const MAX_INTENTOS_ENVIO = 3;

/**
 * Si quedan intentos, reencola con backoff exponencial (mismo min(2^intentos,60)s
 * que src/queue/cola.ts). Si se agotaron, marca "error" definitivo.
 */
export async function marcarFalloOReintentar(db: DB, id: string, error: string, intentos: number): Promise<void> {
  if (intentos >= MAX_INTENTOS_ENVIO) {
    await db.update(waCampaniaEnvios).set({ estado: "error", error }).where(eq(waCampaniaEnvios.id, id));
    return;
  }
  // Sin columna de "ejecutar después de": el volumen de una campaña es chico y el
  // propio throttle del worker ya espacia los reintentos entre ticks.
  await db.update(waCampaniaEnvios).set({ estado: "pendiente", error }).where(eq(waCampaniaEnvios.id, id));
}

/** true si ya no quedan envíos "pendiente" para esa campaña (para marcarla "completada"). */
export async function quedanPendientes(db: DB, campaniaId: string): Promise<boolean> {
  const rows = filasDe(
    await db.execute(sql`
    SELECT 1 FROM wa_campania_envios WHERE campania_id = ${campaniaId} AND estado = 'pendiente' LIMIT 1
  `),
  );
  return rows.length > 0;
}

/**
 * Purga por retención (ROADMAP F11, mismo criterio que src/queue/cola.ts): borra
 * envíos cuya campaña PADRE ya terminó ('completada' o 'cancelada') y terminó
 * hace más de retencionDias. wa_campania_envios no tiene su propia columna de
 * "finalizado en" por fila (una campaña cancelada deja sus envíos "pendiente"
 * en 'error' sin timestamp propio, ver cancelarCampania), así que se usa la del
 * PADRE: completada_en si la campaña llegó a completarse, o creada_en si se
 * canceló antes (aproximación razonable: una campaña cancelada no sigue viva
 * después de cancelarse).
 *
 * Borra en LOTES por la misma razón que la cola principal: evitar un lock largo
 * sobre la tabla mientras el worker de campañas reclama con FOR UPDATE SKIP LOCKED.
 * Devuelve el total de filas borradas (para loguear).
 */
export async function purgarEnviosFinalizados(db: DB, retencionDias = 7, tamanoLote = 500): Promise<number> {
  let total = 0;
  for (;;) {
    const rows = filasDe<{ id: string }>(
      await db.execute(sql`
      DELETE FROM wa_campania_envios
       WHERE id IN (
         SELECT e.id
           FROM wa_campania_envios e
           JOIN wa_campanias c ON c.id = e.campania_id
          WHERE c.estado IN ('completada', 'cancelada')
            AND COALESCE(c.completada_en, c.creada_en) < now() - ${retencionDias} * interval '1 day'
          ORDER BY e.creado_en ASC
          LIMIT ${tamanoLote}
       )
      RETURNING id
    `),
    );
    total += rows.length;
    if (rows.length < tamanoLote) break;
  }
  return total;
}
