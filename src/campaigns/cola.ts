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
       WHERE e.estado = 'pendiente' AND c.estado = 'enviando'
       ORDER BY e.creado_en ASC
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
