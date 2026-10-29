import { and, asc, count, eq, isNotNull, isNull, lte, or } from "drizzle-orm";
import { withSystem, withTenant, type Executor, type Tx } from "../../platform/db/scope";
import { businesses, locations, type BillingStatus, type Business, type BusinessStatus, type Plan } from "./schema";
import type { ExtraModules } from "./settings";

// ─────────────────────────────────────────────────────────────────────────────
// Lo contractual del negocio que vive en `businesses` (PLAN-GESTION.md §5): plan, módulos
// sueltos y cupos contratados (`extra_modules`), estado del servicio (`status`: pausar y
// reactivar), estado del cobro (`billing_status`), la suscripción de Stripe y el fin de la
// prueba gratis. Lo ESCRIBE solo modules/billing (el superadmin, el webhook de Stripe y el
// barrido de pruebas vencidas), que es quien sabe qué significa cada valor; acá solo el
// acceso a la fila, para que billing no lea tablas ajenas.
// ─────────────────────────────────────────────────────────────────────────────

export interface SubscriptionChanges {
  plan?: Plan;
  extraModules?: ExtraModules;
  status?: BusinessStatus;
  billingStatus?: BillingStatus;
  /** null borra el valor. */
  stripeCustomerId?: string | null;
  stripeSubscriptionId?: string | null;
  trialEndsAt?: Date | null;
  unpaidSince?: Date | null;
  billingPausedAt?: Date | null;
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
  if (next.stripeCustomerId !== undefined) set.stripeCustomerId = next.stripeCustomerId;
  if (next.stripeSubscriptionId !== undefined) set.stripeSubscriptionId = next.stripeSubscriptionId;
  if (next.trialEndsAt !== undefined) set.trialEndsAt = next.trialEndsAt;
  if (next.unpaidSince !== undefined) set.unpaidSince = next.unpaidSince;
  if (next.billingPausedAt !== undefined) set.billingPausedAt = next.billingPausedAt;
  if (Object.keys(set).length === 0) return { before, after: before };
  const [after] = await tx.update(businesses).set(set).where(eq(businesses.id, businessId)).returning();
  return { before, after };
}

/**
 * Negocio de una suscripción o un cliente de Stripe (el webhook resuelve así los eventos
 * que no traen nuestro id en la metadata). Corre con el contexto de `tx` (sistema).
 */
export async function findBusinessIdByStripeRefs(
  tx: Tx,
  refs: { customerId?: string | null; subscriptionId?: string | null },
): Promise<string | null> {
  const conditions = [
    refs.subscriptionId ? eq(businesses.stripeSubscriptionId, refs.subscriptionId) : undefined,
    refs.customerId ? eq(businesses.stripeCustomerId, refs.customerId) : undefined,
  ].filter((c) => c !== undefined);
  if (conditions.length === 0) return null;
  const [row] = await tx
    .select({ id: businesses.id })
    .from(businesses)
    .where(or(...conditions))
    .limit(1);
  return row?.id ?? null;
}

/**
 * Negocios con la prueba gratis vencida a `now` que siguen en `trial` y sin suscripción de
 * Stripe (el barrido de billing los pasa a pago pendiente). Corre con el contexto de `tx`
 * (sistema). Los más viejos primero, hasta `limit`.
 */
export async function listExpiredTrials(tx: Tx, now: Date, limit = 100): Promise<string[]> {
  const rows = await tx
    .select({ id: businesses.id })
    .from(businesses)
    .where(
      and(
        isNotNull(businesses.trialEndsAt),
        lte(businesses.trialEndsAt, now),
        eq(businesses.billingStatus, "trial"),
        isNull(businesses.stripeSubscriptionId),
      ),
    )
    .orderBy(asc(businesses.trialEndsAt))
    .limit(limit);
  return rows.map((r) => r.id);
}

/**
 * Negocios activos que no están al día desde `cutoff` o antes (por una vía automática:
 * `unpaid_since` con fecha). El barrido de billing los pausa por el cobro. Corre con el
 * contexto de `tx` (sistema). Los más viejos primero, hasta `limit`.
 */
export async function listUnpaidSince(tx: Tx, cutoff: Date, limit = 100): Promise<string[]> {
  const rows = await tx
    .select({ id: businesses.id })
    .from(businesses)
    .where(and(isNotNull(businesses.unpaidSince), lte(businesses.unpaidSince, cutoff), eq(businesses.status, "active")))
    .orderBy(asc(businesses.unpaidSince))
    .limit(limit);
  return rows.map((r) => r.id);
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
