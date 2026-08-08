import { sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { schema } from "../db/schema";
import { filasDe } from "../db/filas";

// ─────────────────────────────────────────────────────────────────────────────
// Mini-cola del rescate de cotizaciones abandonadas (ROADMAP Carril D, 1.1), sobre
// wa_cotizaciones. Copia estructural de src/campaigns/cola.ts (claim con FOR UPDATE
// SKIP LOCKED en transacción corta), pero el corte de tiempo ("¿ya pasaron las horas
// de espera?") es configurable POR TENANT (tenant.rescateHorasEspera), así que el
// caller (worker.ts) calcula `antesDe` por tenant y lo pasa como parámetro — no hay
// un único cutoff global como en campanias/cola.ts.
//
// DELIBERADAMENTE independiente de wa_jobs (B1) y de wa_campania_envios (C3.2): un
// bug acá no puede afectar el pipeline de respuesta a clientes. Ver
// [[patron-colas-independientes]].
// ─────────────────────────────────────────────────────────────────────────────

type DB = PostgresJsDatabase<typeof schema>;

export interface CandidatoToque {
  id: string;
  clienteWa: string;
  servicioId: string;
  monto: number;
}

/** Reclama UNA cotización "pendiente" (sin toques) más vieja que `antesDe`, y la pasa a "toque1". */
export async function reclamarToque1(db: DB, tenantId: string, antesDe: Date): Promise<CandidatoToque | null> {
  return db.transaction(async (tx) => {
    const rows = filasDe<{ id: string; cliente_wa: string; servicio_id: string; monto: number }>(
      await tx.execute(sql`
      SELECT id, cliente_wa, servicio_id, monto
        FROM wa_cotizaciones
       WHERE tenant_id = ${tenantId} AND estado = 'pendiente' AND creada_en <= ${antesDe}
       ORDER BY creada_en ASC
       FOR UPDATE SKIP LOCKED
       LIMIT 1
    `),
    );
    if (rows.length === 0) return null;
    const r = rows[0];
    await tx.execute(sql`UPDATE wa_cotizaciones SET estado = 'toque1', toque1_en = now() WHERE id = ${r.id}`);
    return { id: r.id, clienteWa: r.cliente_wa, servicioId: r.servicio_id, monto: r.monto };
  });
}

/** Reclama UNA cotización en "toque1" cuyo toque1 ya pasó `antesDe`, y la pasa a "toque2" (el último). */
export async function reclamarToque2(db: DB, tenantId: string, antesDe: Date): Promise<CandidatoToque | null> {
  return db.transaction(async (tx) => {
    const rows = filasDe<{ id: string; cliente_wa: string; servicio_id: string; monto: number }>(
      await tx.execute(sql`
      SELECT id, cliente_wa, servicio_id, monto
        FROM wa_cotizaciones
       WHERE tenant_id = ${tenantId} AND estado = 'toque1' AND toque1_en <= ${antesDe}
       ORDER BY toque1_en ASC
       FOR UPDATE SKIP LOCKED
       LIMIT 1
    `),
    );
    if (rows.length === 0) return null;
    const r = rows[0];
    await tx.execute(sql`UPDATE wa_cotizaciones SET estado = 'toque2', toque2_en = now() WHERE id = ${r.id}`);
    return { id: r.id, clienteWa: r.cliente_wa, servicioId: r.servicio_id, monto: r.monto };
  });
}

/** El envío del toque1 falló (o no correspondía): revierte a "pendiente" para reintentar en el próximo tick. */
export async function revertirToque1(db: DB, id: string): Promise<void> {
  await db.execute(sql`UPDATE wa_cotizaciones SET estado = 'pendiente', toque1_en = NULL WHERE id = ${id}`);
}

/** El envío del toque2 falló (o no correspondía): revierte a "toque1" para reintentar en el próximo tick. */
export async function revertirToque2(db: DB, id: string): Promise<void> {
  await db.execute(sql`UPDATE wa_cotizaciones SET estado = 'toque1', toque2_en = NULL WHERE id = ${id}`);
}

/** El cliente pidió baja ("BAJA") entre que se cotizó y que le tocaba el turno: se detiene el rescate. */
export async function marcarOptOut(db: DB, id: string): Promise<void> {
  await db.execute(sql`UPDATE wa_cotizaciones SET estado = 'opt_out' WHERE id = ${id}`);
}

/** true si el cliente pidió baja de campañas (mismo flag que C3.2 — es la única señal de opt-out que existe hoy). */
export async function siguioOptOut(db: DB, tenantId: string, clienteWa: string): Promise<boolean> {
  const rows = filasDe(
    await db.execute(sql`
    SELECT 1 FROM wa_conversaciones
     WHERE tenant_id = ${tenantId} AND cliente_wa = ${clienteWa} AND opt_out_en IS NOT NULL
     LIMIT 1
  `),
  );
  return rows.length > 0;
}

/** true si un humano está atendiendo esa conversación ahora mismo (no interrumpir con un toque automático). */
export async function enModoHumano(db: DB, tenantId: string, clienteWa: string): Promise<boolean> {
  const rows = filasDe<{ modo: string }>(
    await db.execute(sql`
    SELECT modo FROM wa_conversaciones WHERE tenant_id = ${tenantId} AND cliente_wa = ${clienteWa} LIMIT 1
  `),
  );
  return rows[0]?.modo === "humano";
}

/** Nombre del cliente aproximado por su cita más reciente (mismo criterio que segmentos.ts). "estimado cliente" si no hay ninguna. */
export async function nombreClienteAprox(db: DB, tenantId: string, clienteWa: string): Promise<string> {
  const rows = filasDe<{ cliente_nombre: string }>(
    await db.execute(sql`
    SELECT cliente_nombre FROM wa_citas
     WHERE tenant_id = ${tenantId} AND cliente_wa = ${clienteWa}
     ORDER BY creada_en DESC
     LIMIT 1
  `),
  );
  return rows[0]?.cliente_nombre ?? "estimado cliente";
}

/**
 * Purga por retención (ROADMAP F11, mismo criterio que src/queue/cola.ts): borra
 * cotizaciones en un estado FINAL ('agendada', 'recuperada', 'descartada' u
 * 'opt_out') y más viejas que retencionDias. NO toca 'pendiente'/'toque1'/
 * 'toque2' (el rescate las necesita vivas para seguir tocando).
 *
 * La tabla no guarda un timestamp de "cuándo llegó al estado final" (solo
 * creada_en/toque1_en/toque2_en), así que se usa creada_en como corte: el ciclo
 * completo de rescate (pendiente → toque1 → toque2) es de días, no de meses, así
 * que para una retención medida en días/semanas la diferencia contra el momento
 * real de cierre es despreciable.
 *
 * ⚠️ Nota deliberada (no es un fix de este cambio): el dashboard usa TODAS las
 * filas de wa_cotizaciones del tenant para el "monto recuperado" histórico
 * (drizzleRepository.ts, metricasCotizaciones) — purgar filas viejas encoge esa
 * métrica all-time con el tiempo. Aceptado porque el plan (PLAN-ESCALA-
 * MULTITENANT.md, F11) pide explícitamente esta purga; si se necesita conservar
 * el histórico exacto del monto recuperado, habría que sumarlo a un contador
 * agregado antes de purgar (fuera de alcance acá).
 *
 * Borra en LOTES, mismo motivo que las otras dos colas: no retener el lock que
 * el worker de rescate usa para su propio FOR UPDATE SKIP LOCKED.
 * Devuelve el total de filas borradas (para loguear).
 */
export async function purgarCotizacionesFinalizadas(db: DB, retencionDias = 7, tamanoLote = 500): Promise<number> {
  let total = 0;
  for (;;) {
    const rows = filasDe<{ id: string }>(
      await db.execute(sql`
      DELETE FROM wa_cotizaciones
       WHERE id IN (
         SELECT id FROM wa_cotizaciones
          WHERE estado IN ('agendada', 'recuperada', 'descartada', 'opt_out')
            AND creada_en < now() - ${retencionDias} * interval '1 day'
          ORDER BY creada_en ASC
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

/** Citas "agendada" del tenant en una fecha, con las columnas mínimas que necesita espaciosDisponibles(). */
export async function citasDelDia(
  db: DB,
  tenantId: string,
  fecha: string,
): Promise<{ estado: string; hora: string; servicioId: string }[]> {
  const rows = filasDe<{ estado: string; hora: string; servicio_id: string }>(
    await db.execute(sql`
    SELECT estado, hora, servicio_id FROM wa_citas WHERE tenant_id = ${tenantId} AND fecha = ${fecha}
  `),
  );
  return rows.map((r) => ({ estado: r.estado, hora: r.hora, servicioId: r.servicio_id }));
}
