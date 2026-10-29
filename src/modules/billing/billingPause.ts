import { recordAudit } from "../../platform/audit/auditLog";
import { withSystem, type Executor } from "../../platform/db/scope";
import { log } from "../../platform/observability/log";
import { invalidateBusinessContext, listUnpaidSince, updateBusinessSubscription, type BillingStatus, type Business, type SubscriptionChanges } from "../business";

// ─────────────────────────────────────────────────────────────────────────────
// Pausa por falta de pago (I6): cuando el cobro deja de estar al día por una vía
// AUTOMÁTICA, corre una gracia (BILLING_GRACE_DAYS, default 7) y después el barrido pausa el
// negocio con el flujo de siempre (`status = paused`: la API responde 403 `business_paused`,
// la cola posterga el trabajo nuevo y los datos quedan intactos), marcado como pausa POR EL
// COBRO (`billing_paused_at`): la dueña puede entrar solo a pagar y, al pagar, se reactiva.
//
//   Vías automáticas (arrancan el reloj `unpaid_since`):
//     • Stripe no pudo cobrar (`past_due`) o la suscripción se canceló (`cancelled`).
//     • La prueba del alta self-service venció sin suscribirse (`past_due`).
//   Al volver a `active` o `trial` por Stripe, el reloj se borra y, si estaba pausado por
//   el cobro, se reactiva.
//
// El cobro manual no entra: un estado que carga el superadmin no arranca el reloj (pausar a
// mano sigue siendo suyo); sí lo borra si lo pasa a al día.
// ─────────────────────────────────────────────────────────────────────────────

/** Actor del rastro de auditoría de lo que pausa el barrido. */
export const BILLING_SWEEP_ACTOR = "system:billing";

/** Días de gracia por defecto entre que el cobro deja de estar al día y la pausa. */
export const DEFAULT_GRACE_DAYS = 7;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Estados del cobro que no están al día. */
const UNPAID_STATUSES: ReadonlySet<string> = new Set<BillingStatus>(["past_due", "cancelled"]);

/** Días de gracia (`BILLING_GRACE_DAYS`, entero ≥ 0; un valor inválido cae al default). */
export function graceDays(env: Record<string, string | undefined> = process.env): number {
  const raw = env.BILLING_GRACE_DAYS?.trim();
  if (!raw) return DEFAULT_GRACE_DAYS;
  const days = Number(raw);
  return Number.isInteger(days) && days >= 0 ? days : DEFAULT_GRACE_DAYS;
}

/** Cuándo se pausa el negocio si nadie paga (null = no corre ningún reloj). */
export function pausesAtOf(business: Pick<Business, "status" | "unpaidSince">, env?: Record<string, string | undefined>): Date | null {
  if (business.status !== "active" || !business.unpaidSince) return null;
  return new Date(business.unpaidSince.getTime() + graceDays(env) * DAY_MS);
}

/** ¿El negocio está pausado POR EL COBRO (no por el superadmin)? */
export function isPausedForBilling(business: Pick<Business, "status" | "billingPausedAt">): boolean {
  return business.status === "paused" && business.billingPausedAt !== null;
}

/**
 * Lo que acompaña a un cambio del estado del cobro para mantener el reloj de la gracia y la
 * pausa por el cobro. `automatic`: Stripe o el barrido de pruebas (arranca el reloj y
 * reactiva); `manual`: el superadmin (solo borra el reloj al pasar a al día).
 */
export function billingClockChanges(current: Business, next: BillingStatus | undefined, now: Date, source: "automatic" | "manual"): SubscriptionChanges {
  if (next === undefined) return {};
  if (UNPAID_STATUSES.has(next)) {
    // El reloj sigue desde la primera vez (pasar de pendiente a cancelado no lo reinicia).
    if (source === "manual" || current.unpaidSince) return {};
    return { unpaidSince: now };
  }
  const changes: SubscriptionChanges = current.unpaidSince ? { unpaidSince: null } : {};
  if (source === "automatic" && isPausedForBilling(current)) {
    changes.status = "active";
    changes.billingPausedAt = null;
  }
  return changes;
}

/** ¿Hay que pausarlo ya? (activo, con el reloj corriendo y la gracia cumplida). */
function graceExpired(business: Business, now: Date, env?: Record<string, string | undefined>): boolean {
  const pausesAt = pausesAtOf(business, env);
  return pausesAt !== null && pausesAt <= now && UNPAID_STATUSES.has(business.billingStatus);
}

/**
 * Un pase del barrido: pausa por el cobro los negocios con la gracia cumplida, cada uno en su
 * transacción y con su rastro. Devuelve cuántos pausó.
 */
export async function pauseUnpaidBusinesses(db: Executor, options: { now?: Date; env?: Record<string, string | undefined> } = {}): Promise<number> {
  const now = options.now ?? new Date();
  const cutoff = new Date(now.getTime() - graceDays(options.env) * DAY_MS);
  const ids = await withSystem(db, (tx) => listUnpaidSince(tx, cutoff));
  let paused = 0;
  for (const businessId of ids) {
    const didPause = await withSystem(db, async (tx) => {
      // Se vuelve a decidir con la fila bloqueada: un pago que entró entre la lista y acá gana.
      const changed = await updateBusinessSubscription(tx, businessId, (current) =>
        graceExpired(current, now, options.env) ? { status: "paused", billingPausedAt: now } : {},
      );
      if (!changed || changed.after.status !== "paused" || changed.before.status === "paused") return false;
      await recordAudit(tx, businessId, "business_paused", BILLING_SWEEP_ACTOR, {
        reason: "grace_expired",
        billingStatus: changed.after.billingStatus,
        unpaidSince: changed.before.unpaidSince?.toISOString() ?? null,
      });
      return true;
    });
    if (didPause) {
      invalidateBusinessContext(businessId);
      log.info("billing_business_paused", { businessId });
      paused++;
    }
  }
  return paused;
}
