import { recordAudit } from "../../platform/audit/auditLog";
import { withSystem, type Executor } from "../../platform/db/scope";
import { startLeaderLoop } from "../../platform/net/leaderLease";
import type { Loop } from "../../platform/net/scheduler";
import { msFromEnv } from "../../platform/net/timeouts";
import { log } from "../../platform/observability/log";
import { captureError } from "../../platform/observability/sentry";
import { invalidateBusinessContext, listBillingSweepCandidates, updateBusinessSubscription, type Business } from "../business";
import { pastDueCutoff } from "./stripeConfig";
import { LIVE_SUBSCRIPTION_STATUSES } from "./stripeSync";

// ─────────────────────────────────────────────────────────────────────────────
// Barrido de vencimientos del cobro (loop con lease: una sola réplica por tick). Pausa
// con el flujo de siempre (status `paused`: la API responde 403 `business_paused`, la cola
// posterga el trabajo nuevo, los datos quedan intactos), marcando que la pausa es POR EL
// COBRO (`billing_paused_at`): el dueño puede entrar a pagar y, al pagar, se reactiva solo.
//
//   • Pago atrasado (`past_due`) con la gracia vencida (BILLING_PAST_DUE_GRACE_DAYS).
//   • Prueba del alta self-service vencida (`trial` con `trial_ends_at` cumplido) sin una
//     suscripción viva en Stripe (si la hay, Stripe cobra al terminar la prueba).
//   • Suscripción cancelada con el período ya cumplido (por si el evento de baja no llegó).
//
// Los negocios de cobro manual no entran: no tienen `past_due_since` (lo pone Stripe),
// ni `trial_ends_at` (lo pone el alta self-service), ni `current_period_end`.
// ─────────────────────────────────────────────────────────────────────────────

/** Actor del rastro de auditoría de lo que pausa el barrido. */
export const BILLING_SWEEP_ACTOR = "system:billing";

export type BillingPauseReason = "past_due_grace_expired" | "trial_expired" | "subscription_ended";

/** Por qué hay que pausar este negocio ahora (null = no corresponde). */
export function billingPauseReason(business: Business, now: Date, env: Record<string, string | undefined> = process.env): BillingPauseReason | null {
  if (business.status !== "active") return null;
  if (business.billingStatus === "past_due" && business.pastDueSince && business.pastDueSince <= pastDueCutoff(now, env)) {
    return "past_due_grace_expired";
  }
  if (
    business.billingStatus === "trial" &&
    business.trialEndsAt &&
    business.trialEndsAt <= now &&
    !LIVE_SUBSCRIPTION_STATUSES.includes(business.stripeSubscriptionStatus ?? "")
  ) {
    return "trial_expired";
  }
  if (business.billingStatus === "cancelled" && business.currentPeriodEnd && business.currentPeriodEnd <= now) return "subscription_ended";
  return null;
}

export interface BillingSweepResult {
  checked: number;
  paused: number;
}

/** Un tick del barrido: pausa lo que corresponde, cada negocio en su transacción. */
export async function sweepBilling(db: Executor, options: { now?: Date; env?: Record<string, string | undefined> } = {}): Promise<BillingSweepResult> {
  const now = options.now ?? new Date();
  const env = options.env ?? process.env;
  const candidates = await listBillingSweepCandidates(db, { pastDueBefore: pastDueCutoff(now, env), trialEndedBefore: now, periodEndedBefore: now });
  let paused = 0;
  for (const businessId of candidates) {
    const didPause = await withSystem(db, async (tx) => {
      const decided: { reason: BillingPauseReason | null } = { reason: null };
      // Se vuelve a decidir con la fila bloqueada: un pago que entró entre la lista y acá gana.
      const changed = await updateBusinessSubscription(tx, businessId, (current) => {
        decided.reason = billingPauseReason(current, now, env);
        return decided.reason ? { status: "paused", billingPausedAt: now } : {};
      });
      if (!changed || !decided.reason) return false;
      await recordAudit(tx, businessId, "business_paused", BILLING_SWEEP_ACTOR, { reason: decided.reason, billingStatus: changed.after.billingStatus });
      return true;
    });
    if (didPause) {
      paused++;
      invalidateBusinessContext(businessId);
      log.info("billing_business_paused", { businessId });
    }
  }
  return { checked: candidates.length, paused };
}

/** Loop del barrido (procesos worker). Cada BILLING_SWEEP_INTERVAL_MS (default 1 h). */
export function startBillingScheduler(options: { db: Executor; intervalMs?: number }): Loop {
  const intervalMs = options.intervalMs ?? msFromEnv("BILLING_SWEEP_INTERVAL_MS", 60 * 60 * 1000);
  return startLeaderLoop({
    db: options.db,
    label: "billing",
    intervalMs,
    tick: async () => {
      const result = await sweepBilling(options.db);
      if (result.paused > 0) log.info("billing_sweep", { ...result });
    },
    onError: (e, phase) => {
      log.error("billing_sweep_failed", { phase, error: e instanceof Error ? e.message : String(e) });
      captureError(e, { scheduler: "billing", phase });
    },
    scalingHint: "Revisá los índices de `businesses` o subí BILLING_SWEEP_INTERVAL_MS.",
  });
}
