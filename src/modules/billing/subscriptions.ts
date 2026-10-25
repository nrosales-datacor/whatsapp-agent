import { eq } from "drizzle-orm";
import { recordAudit } from "../../platform/audit/auditLog";
import { isTenantId, withSystem, type Executor, type Tx } from "../../platform/db/scope";
import { captureError } from "../../platform/observability/sentry";
import { log } from "../../platform/observability/log";
import { startLeaderLoop } from "../../platform/net/leaderLease";
import type { Loop } from "../../platform/net/scheduler";
import { msFromEnv } from "../../platform/net/timeouts";
import {
  findBusinessIdByStripeRefs,
  getBusinessRow,
  invalidateBusinessContext,
  listExpiredTrials,
  updateBusinessSubscription,
  type Business,
  type Plan,
  type SubscriptionChanges,
} from "../business";
import { normalizeExtraModules, readExtraModules, toStoredExtraModules } from "./catalog";
import { resolveEntitlements } from "./entitlements";
import { stripeEvents } from "./schema";
import { billingStatusOf, optionOfPrice, type BillingOption, type StripeConfig, type SubscriptionSnapshot } from "./stripe";

// ─────────────────────────────────────────────────────────────────────────────
// Lo que Stripe cambia en el negocio (I6.6) y el barrido de pruebas vencidas (I6.7).
//
// Webhook: cada evento se aplica en UNA transacción con su fila en `stripe_events`
// (idempotencia por id: el mismo evento dos veces se aplica una sola) y su rastro en
// `audit_log` (sin datos personales: plan, módulos, estados y los ids de Stripe no lo son).
// El estado de la suscripción se lee FRESCO de la API antes de abrir la transacción (lo
// hace el handler): los eventos pueden llegar desordenados y uno viejo no debe pisar uno
// nuevo.
//
//   • Precio → plan: Básico, Pro o Pro sin agente (Pro con `whatsapp: false` en
//     `extra_modules`; los cupos contratados se conservan). Un precio que no es de los
//     configurados NO toca el plan (no se adivina): solo el estado del cobro.
//   • Estado → `billing_status` (`billingStatusOf`). Stripe no pausa el servicio: pausar
//     sigue siendo una decisión del superadmin.
//   • Prueba: con la suscripción en `trialing`, `trial_ends_at` = fin de la prueba de
//     Stripe; en cualquier otro estado se borra (ya no hay prueba nuestra que vencer).
// ─────────────────────────────────────────────────────────────────────────────

/** Actor de lo que cambia Stripe en el rastro de auditoría. */
export const STRIPE_ACTOR = "system:stripe";
/** Actor del barrido de pruebas vencidas. */
export const TRIAL_SWEEP_ACTOR = "system:trial-expiry";

/** Plan y `extra_modules` de una opción vendida, conservando lo contratado aparte (cupos, otros módulos). */
export function subscriptionPlanChanges(current: Business, option: BillingOption): Pick<SubscriptionChanges, "plan" | "extraModules"> {
  const plan: Plan = option === "basic" ? "basic" : "pro";
  const { modules, limits } = readExtraModules(current.extraModules);
  const nextModules = { ...modules };
  if (option === "pro_no_agent") nextModules.whatsapp = false;
  else delete nextModules.whatsapp;
  return { plan, extraModules: toStoredExtraModules(normalizeExtraModules(plan, { modules: nextModules, limits })) };
}

function auditState(business: Business) {
  const e = resolveEntitlements(business);
  return {
    plan: e.plan,
    modules: e.modules,
    billingStatus: business.billingStatus,
    stripeSubscriptionId: business.stripeSubscriptionId,
    trialEndsAt: business.trialEndsAt?.toISOString() ?? null,
  };
}

/** Registra el evento. false si ya estaba (otro reintento lo aplicó primero). */
async function claimEvent(tx: Tx, event: { id: string; type: string }, businessId: string | null): Promise<boolean> {
  const inserted = await tx
    .insert(stripeEvents)
    .values({ id: event.id, type: event.type, businessId })
    .onConflictDoNothing({ target: stripeEvents.id })
    .returning({ id: stripeEvents.id });
  return inserted.length === 1;
}

/** ¿Ya se procesó este evento? (para no pedirle la suscripción a la API en un reintento). */
export async function isEventProcessed(db: Executor, eventId: string): Promise<boolean> {
  const rows = await withSystem(db, (tx) => tx.select({ id: stripeEvents.id }).from(stripeEvents).where(eq(stripeEvents.id, eventId)).limit(1));
  return rows.length > 0;
}

/** Negocio del evento: el id de nuestra metadata (si existe) o el de la suscripción/cliente de Stripe. */
async function resolveBusinessId(tx: Tx, refs: { metadataBusinessId?: string | null; customerId?: string | null; subscriptionId?: string | null }): Promise<string | null> {
  const fromRefs = await findBusinessIdByStripeRefs(tx, { customerId: refs.customerId, subscriptionId: refs.subscriptionId });
  if (fromRefs) return fromRefs;
  const candidate = refs.metadataBusinessId?.toLowerCase();
  if (!candidate || !isTenantId(candidate)) return null;
  return (await getBusinessRow(tx, candidate)) ? candidate : null;
}

export type StripeEventOutcome = "applied" | "duplicate" | "ignored" | "unknown_business";

export interface StripeEventInput {
  id: string;
  type: string;
  /** Lo que el handler leyó del evento (sin datos personales). */
  checkout?: { businessId: string | null; customerId: string | null; subscriptionId: string | null };
  /** La suscripción leída FRESCA de la API (eventos customer.subscription.* y checkout completo). */
  subscription?: SubscriptionSnapshot | null;
}

/** Aplica un evento ya verificado. Idempotente por id. */
export async function applyStripeEvent(db: Executor, config: Pick<StripeConfig, "prices">, event: StripeEventInput): Promise<StripeEventOutcome> {
  const sub = event.subscription ?? null;
  if (!event.checkout && !sub) {
    // Un tipo que no nos interesa: se registra igual (no se vuelve a mirar).
    const fresh = await withSystem(db, (tx) => claimEvent(tx, event, null));
    return fresh ? "ignored" : "duplicate";
  }

  const result = await withSystem(db, async (tx) => {
    const businessId = await resolveBusinessId(tx, {
      metadataBusinessId: event.checkout?.businessId ?? sub?.metadata.businessId ?? null,
      customerId: sub?.customerId ?? event.checkout?.customerId ?? null,
      subscriptionId: sub?.id ?? event.checkout?.subscriptionId ?? null,
    });
    if (!(await claimEvent(tx, event, businessId))) return { outcome: "duplicate" as const, businessId };
    if (!businessId) return { outcome: "unknown_business" as const, businessId };

    const changed = await updateBusinessSubscription(tx, businessId, (current) => {
      const next: SubscriptionChanges = {};
      const customerId = sub?.customerId ?? event.checkout?.customerId ?? null;
      const subscriptionId = sub?.id ?? event.checkout?.subscriptionId ?? null;
      if (customerId) next.stripeCustomerId = customerId;
      if (subscriptionId && sub?.status !== "canceled") next.stripeSubscriptionId = subscriptionId;
      if (sub) {
        const status = billingStatusOf(sub.status);
        if (status) next.billingStatus = status;
        // Una suscripción cancelada deja de ser la del negocio (puede volver a suscribirse).
        if (sub.status === "canceled" && current.stripeSubscriptionId === sub.id) next.stripeSubscriptionId = null;
        next.trialEndsAt = sub.status === "trialing" ? sub.trialEnd : null;
        const option = optionOfPrice(config, sub.priceId);
        if (option && sub.status !== "canceled" && sub.status !== "incomplete_expired") Object.assign(next, subscriptionPlanChanges(current, option));
        else if (!option && sub.priceId) log.warn("stripe_unknown_price", { businessId, eventId: event.id });
      }
      return next;
    });
    if (!changed) return { outcome: "unknown_business" as const, businessId };
    await recordAudit(tx, businessId, "stripe_subscription_synced", STRIPE_ACTOR, {
      eventId: event.id,
      eventType: event.type,
      before: auditState(changed.before),
      after: auditState(changed.after),
    });
    return { outcome: "applied" as const, businessId };
  });
  if (result.outcome === "applied" && result.businessId) invalidateBusinessContext(result.businessId);
  return result.outcome;
}

// ── Pruebas vencidas (I6.7) ──────────────────────────────────────────────────

/**
 * Pasa a pago pendiente (`past_due`) los negocios con la prueba gratis vencida, todavía en
 * `trial` y sin suscripción. NO los pausa: el panel muestra el aviso para suscribirse y
 * pausar sigue siendo del superadmin. Devuelve cuántos cambió.
 */
export async function expireTrials(db: Executor, now = new Date()): Promise<number> {
  const ids = await withSystem(db, (tx) => listExpiredTrials(tx, now));
  let expired = 0;
  for (const businessId of ids) {
    const changed = await withSystem(db, async (tx) => {
      const result = await updateBusinessSubscription(tx, businessId, (current) =>
        // Releído con lock: si justo se suscribió o cambió el estado, no se toca.
        current.billingStatus === "trial" && !current.stripeSubscriptionId && current.trialEndsAt && current.trialEndsAt <= now
          ? { billingStatus: "past_due" }
          : {},
      );
      if (!result || result.after.billingStatus !== "past_due" || result.before.billingStatus === "past_due") return false;
      await recordAudit(tx, businessId, "trial_expired", TRIAL_SWEEP_ACTOR, { trialEndsAt: result.before.trialEndsAt?.toISOString() ?? null });
      return true;
    });
    if (changed) {
      invalidateBusinessContext(businessId);
      expired++;
    }
  }
  return expired;
}

/** Barrido periódico de pruebas vencidas (procesos `ROLE=worker|all`, un líder entre réplicas). */
export function startTrialExpiryLoop(options: { db: Executor; intervalMs?: number }): Loop {
  const intervalMs = options.intervalMs ?? msFromEnv("TRIAL_EXPIRY_INTERVAL_MS", 60 * 60_000);
  return startLeaderLoop({
    db: options.db,
    label: "trial-expiry",
    intervalMs,
    tick: async () => {
      const expired = await expireTrials(options.db);
      if (expired > 0) log.info("trials_expired", { expired });
    },
    onError: (e, phase) => {
      log.error("trial_expiry_failed", { phase, error: e instanceof Error ? e.message : String(e) });
      captureError(e, { scheduler: "trial-expiry", phase });
    },
    scalingHint: "Revisá el índice businesses_trial_ends_idx o bajá TRIAL_EXPIRY_INTERVAL_MS.",
  });
}
