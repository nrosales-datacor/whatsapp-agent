import { and, count, eq, isNotNull, lte, or } from "drizzle-orm";
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
  // Cobro en línea (Stripe, I6) y prueba del alta self-service. `null` borra el valor.
  stripeCustomerId?: string | null;
  stripeSubscriptionId?: string | null;
  stripeSubscriptionStatus?: string | null;
  currentPeriodEnd?: Date | null;
  cancelAtPeriodEnd?: boolean;
  stripeSyncedAt?: Date | null;
  trialEndsAt?: Date | null;
  pastDueSince?: Date | null;
  billingPausedAt?: Date | null;
}

/** Campos de `SubscriptionChanges` que se copian tal cual a la fila (los demás son los de arriba). */
const PLAIN_FIELDS = [
  "plan",
  "extraModules",
  "status",
  "billingStatus",
  "stripeCustomerId",
  "stripeSubscriptionId",
  "stripeSubscriptionStatus",
  "currentPeriodEnd",
  "cancelAtPeriodEnd",
  "stripeSyncedAt",
  "trialEndsAt",
  "pastDueSince",
  "billingPausedAt",
] as const satisfies readonly (keyof SubscriptionChanges)[];

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
  const set: Record<string, unknown> = {};
  for (const key of PLAIN_FIELDS) {
    if (next[key] !== undefined) set[key] = next[key];
  }
  if (Object.keys(set).length === 0) return { before, after: before };
  const [after] = await tx
    .update(businesses)
    .set(set as Partial<typeof businesses.$inferInsert>)
    .where(eq(businesses.id, businessId))
    .returning();
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

// ── Cobro en línea (Stripe, I6): búsquedas de sistema que necesita modules/billing ──

/**
 * Negocio dueño de una suscripción o de un cliente de Stripe (el webhook resuelve así los
 * eventos que no traen el id del negocio en la metadata). Corre con el contexto de `tx`
 * (sistema). La suscripción gana sobre el cliente; null si ninguno coincide.
 */
export async function findBusinessIdByStripe(tx: Tx, ref: { subscriptionId?: string | null; customerId?: string | null }): Promise<string | null> {
  if (ref.subscriptionId) {
    const [row] = await tx.select({ id: businesses.id }).from(businesses).where(eq(businesses.stripeSubscriptionId, ref.subscriptionId)).limit(1);
    if (row) return row.id;
  }
  if (ref.customerId) {
    const [row] = await tx.select({ id: businesses.id }).from(businesses).where(eq(businesses.stripeCustomerId, ref.customerId)).limit(1);
    if (row) return row.id;
  }
  return null;
}

/**
 * Negocios ACTIVOS que el barrido de cobro tiene que mirar (billing decide qué hacer con
 * cada uno, con la fila bloqueada): pago atrasado desde antes de `pastDueBefore`, prueba
 * del alta self-service vencida antes de `trialEndedBefore` o suscripción cancelada con el
 * período cumplido antes de `periodEndedBefore`.
 */
export async function listBillingSweepCandidates(
  executor: Executor,
  input: { pastDueBefore: Date; trialEndedBefore: Date; periodEndedBefore: Date; limit?: number },
): Promise<string[]> {
  const rows = await withSystem(executor, (tx) =>
    tx
      .select({ id: businesses.id })
      .from(businesses)
      .where(
        and(
          eq(businesses.status, "active"),
          or(
            and(eq(businesses.billingStatus, "past_due"), isNotNull(businesses.pastDueSince), lte(businesses.pastDueSince, input.pastDueBefore)),
            and(eq(businesses.billingStatus, "trial"), isNotNull(businesses.trialEndsAt), lte(businesses.trialEndsAt, input.trialEndedBefore)),
            and(eq(businesses.billingStatus, "cancelled"), isNotNull(businesses.currentPeriodEnd), lte(businesses.currentPeriodEnd, input.periodEndedBefore)),
          ),
        ),
      )
      .limit(input.limit ?? 500),
  );
  return rows.map((r) => r.id);
}
