import { and, desc, eq, type SQL } from "drizzle-orm";
import { configHistory } from "../db/schema";
import { withTenant, type Executor } from "../db/scope";

// ─────────────────────────────────────────────────────────────────────────────
// Acceso a datos de `config_history` (ver la tabla en src/platform/db/schema.ts): cada
// cambio de una pantalla de Configuración guarda, en la MISMA transacción que el cambio,
// cómo quedó la entidad (`snapshot` completo, no un diff), quién lo hizo y cuándo.
//
// Recibe el `tx` del llamador para escribir adentro de la operación (o quedan el cambio Y
// su rastro, o ninguno de los dos). `withTenant` sobre una transacción abierta es un
// savepoint con el mismo negocio: no cambia el alcance.
//
// Igual que audit_log: el snapshot es configuración del negocio (nombres, horarios,
// precios), nunca secretos.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Qué configuración cambió. snake_case en inglés; crece sin migración ("business",
 * "location", "service", "staff", "time_off", "services_order"…).
 */
export type ConfigEntity = string;

export interface ConfigChange {
  businessId: string;
  entity: ConfigEntity;
  /** Id de la fila cuando la entidad tiene varias (una sucursal, un servicio…). */
  entityId?: string | null;
  /** Estado completo como quedó. Un borrado guarda `{ deleted: true, … }`. */
  snapshot: unknown;
  /** Usuario del panel que hizo el cambio (null = proceso del sistema). */
  changedBy: string | null;
}

export interface ConfigHistoryItem {
  id: string;
  entity: string;
  entityId: string | null;
  snapshot: unknown;
  changedBy: string | null;
  createdAt: string; // ISO
}

/** Registra un cambio de configuración dentro de la transacción del cambio. */
export async function recordConfigChange(executor: Executor, change: ConfigChange): Promise<void> {
  await withTenant(executor, change.businessId, (tx) =>
    tx.insert(configHistory).values({
      businessId: change.businessId,
      entity: change.entity,
      entityId: change.entityId ?? null,
      // JSON puro: las fechas quedan como ISO y lo que no es serializable no entra.
      snapshot: JSON.parse(JSON.stringify(change.snapshot ?? null)),
      changedBy: change.changedBy,
    }),
  );
}

/** Historial de un negocio (opcionalmente de una entidad / fila), MÁS RECIENTE PRIMERO. */
export async function listConfigHistory(
  executor: Executor,
  businessId: string,
  filter: { entity?: string; entityId?: string; limit?: number } = {},
): Promise<ConfigHistoryItem[]> {
  const conditions: SQL[] = [eq(configHistory.businessId, businessId)];
  if (filter.entity) conditions.push(eq(configHistory.entity, filter.entity));
  if (filter.entityId) conditions.push(eq(configHistory.entityId, filter.entityId));
  const rows = await withTenant(executor, businessId, (tx) =>
    tx
      .select()
      .from(configHistory)
      .where(and(...conditions))
      .orderBy(desc(configHistory.createdAt))
      .limit(Math.min(Math.max(filter.limit ?? 50, 1), 500)),
  );
  return rows.map((r) => ({
    id: r.id,
    entity: r.entity,
    entityId: r.entityId,
    snapshot: r.snapshot,
    changedBy: r.changedBy,
    createdAt: r.createdAt.toISOString(),
  }));
}
