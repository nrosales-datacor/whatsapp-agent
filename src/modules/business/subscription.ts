import { and, count, eq } from "drizzle-orm";
import { withSystem, withTenant, type Executor, type Tx } from "../../platform/db/scope";
import { businesses, locations, type BillingStatus, type Business, type BusinessStatus, type Plan } from "./schema";
import type { ExtraModules } from "./settings";

// ─────────────────────────────────────────────────────────────────────────────
// Lo contractual del negocio que vive en `businesses` (PLAN-GESTION.md §5): plan, módulos
// sueltos y cupos contratados (`extra_modules`), estado del servicio (`status`: pausar y
// reactivar) y estado del cobro manual (`billing_status`). Lo ESCRIBE solo el superadmin,
// vía modules/billing, que es quien sabe qué significa cada valor; acá solo el acceso a la
// fila, para que billing no lea tablas ajenas.
// ─────────────────────────────────────────────────────────────────────────────

export interface SubscriptionChanges {
  plan?: Plan;
  extraModules?: ExtraModules;
  status?: BusinessStatus;
  billingStatus?: BillingStatus;
}

/** La fila del negocio leída de la base (no del caché), en contexto de sistema. null si no existe. */
export async function getBusinessRow(executor: Executor, businessId: string): Promise<Business | null> {
  const [row] = await withSystem(executor, (tx) => tx.select().from(businesses).where(eq(businesses.id, businessId)).limit(1));
  return row ?? null;
}

/**
 * Cambia lo contractual del negocio DENTRO de la transacción del llamador (que registra la
 * auditoría en la misma). Bloquea la fila (FOR UPDATE) y devuelve cómo quedó antes y
 * después, o null si el negocio no existe. El llamador invalida el caché del contexto
 * (`invalidateBusinessContext`) DESPUÉS de confirmar.
 */
export async function updateBusinessSubscription(
  tx: Tx,
  businessId: string,
  changes: SubscriptionChanges | ((current: Business) => SubscriptionChanges),
): Promise<{ before: Business; after: Business } | null> {
  const [before] = await tx.select().from(businesses).where(eq(businesses.id, businessId)).for("update");
  if (!before) return null;
  const next = typeof changes === "function" ? changes(before) : changes;
  const set: Partial<typeof businesses.$inferInsert> = {};
  if (next.plan !== undefined) set.plan = next.plan;
  if (next.extraModules !== undefined) set.extraModules = next.extraModules;
  if (next.status !== undefined) set.status = next.status;
  if (next.billingStatus !== undefined) set.billingStatus = next.billingStatus;
  if (Object.keys(set).length === 0) return { before, after: before };
  const [after] = await tx.update(businesses).set(set).where(eq(businesses.id, businessId)).returning();
  return { before, after };
}

/** Sucursales activas del negocio, contadas con `tx` (para el cupo, dentro de la transacción). */
export async function countActiveLocations(tx: Tx, businessId: string): Promise<number> {
  const [row] = await tx
    .select({ n: count() })
    .from(locations)
    .where(and(eq(locations.businessId, businessId), eq(locations.active, true)));
  return Number(row?.n ?? 0);
}

/** Lo mismo, abriendo su propia lectura con el contexto del negocio (uso del plan). */
export function countActiveLocationsOf(executor: Executor, businessId: string): Promise<number> {
  return withTenant(executor, businessId, (tx) => countActiveLocations(tx, businessId));
}
