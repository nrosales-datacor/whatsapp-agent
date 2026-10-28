import { eq, sql } from "drizzle-orm";
import { recordAudit } from "../../platform/audit/auditLog";
import { withSystem, type Executor, type Tx } from "../../platform/db/scope";
import { log } from "../../platform/observability/log";
import {
  findBusinessIdByStripe,
  getBusinessRow,
  invalidateBusinessContext,
  updateBusinessSubscription,
  type BillingStatus,
  type Business,
  type Plan,
  type SubscriptionChanges,
} from "../business";
import { LIMIT_KEYS, normalizeExtraModules, PLANS, toStoredExtraModules, type LimitOverrides } from "./catalog";
import { resolveEntitlements } from "./entitlements";
import { stripeEvents } from "./schema";
import { planOfPrice, type StripeConfig } from "./stripeConfig";
import type { StripeEventLike } from "./stripeGateway";

// ─────────────────────────────────────────────────────────────────────────────
// Sincronización de Stripe → negocio (lo que hace el webhook con un evento ya verificado).
//
// Idempotencia: el id del evento se inserta en `stripe_events` en la MISMA transacción que
// el cambio (`ON CONFLICT DO NOTHING`). Un repetido no hace nada; si el cambio falla, el id
// tampoco queda y el reintento de Stripe lo vuelve a procesar.
//
// Orden: Stripe no garantiza el orden de entrega. Cada negocio guarda el instante del
// último evento de SUSCRIPCIÓN aplicado (`stripe_synced_at`: esos eventos traen el estado
// completo); cualquier evento más viejo que ese no pisa nada. Las facturas no lo mueven
// (un pago que llega antes que el alta de la suscripción no la deja "vieja").
//
// Qué se sincroniza (todo con la fila bloqueada y su rastro en audit_log, actor
// `system:stripe`, sin datos personales):
//
//   checkout.session.completed      cliente y suscripción de Stripe del negocio.
//   customer.subscription.created   plan (por Price ID), cupos extra del Pro, estado del
//   customer.subscription.updated   cobro, fin del período y "se cancela al final".
//   customer.subscription.paused
//   customer.subscription.resumed
//   customer.subscription.deleted   cobro `cancelled` y el negocio se pausa (el período ya
//                                   terminó: Stripe lo manda al final del período).
//   invoice.paid                    cobro al día; si estaba pausado POR EL COBRO, se reactiva.
//   invoice.payment_succeeded
//   invoice.payment_failed          cobro atrasado (`past_due`) desde ese momento; pasada la
//                                   gracia, el barrido (./sweep.ts) lo pausa.
//
// Estados de la suscripción → `billing_status`:
//   active → active · trialing → trial · past_due, unpaid, paused → past_due ·
//   canceled → cancelled · incomplete, incomplete_expired → sin cambio (Checkout sin pagar).
//
// Un Price ID que no es ninguno de los configurados NO cambia el plan (nunca se adivina).
// ─────────────────────────────────────────────────────────────────────────────

/** Actor del rastro de auditoría de lo que cambia Stripe. */
export const STRIPE_ACTOR = "system:stripe";

export type StripeEventOutcome = "applied" | "duplicate" | "ignored" | "stale" | "unknown_business";

export interface StripeEventResult {
  outcome: StripeEventOutcome;
  businessId: string | null;
}

export interface ProcessStripeEventOptions {
  /** Precios configurados (para mapear Price ID → plan y cupos). Sin ellos no se toca el plan. */
  prices: StripeConfig["prices"] | null;
  /** Reloj (tests). */
  now?: () => Date;
}

// ── Lectura defensiva de los objetos de Stripe ──────────────────────────────

type Obj = Record<string, unknown>;

const RE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function obj(value: unknown): Obj | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Obj) : null;
}

/** Un campo de Stripe que puede venir como id o como objeto expandido. */
function idOf(value: unknown): string | null {
  return str(value) ?? str(obj(value)?.id);
}

function epoch(value: unknown): Date | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? new Date(value * 1000) : null;
}

function businessIdIn(metadata: unknown): string | null {
  const id = str(obj(metadata)?.businessId);
  return id && RE_UUID.test(id) ? id.toLowerCase() : null;
}

export interface SubscriptionInfo {
  id: string;
  customerId: string | null;
  status: string;
  businessId: string | null;
  cancelAtPeriodEnd: boolean;
  currentPeriodEnd: Date | null;
  endedAt: Date | null;
  items: { priceId: string; quantity: number }[];
}

/** Lo que se usa de una suscripción (API nueva: el período vive en los ítems; vieja: en la suscripción). */
export function readSubscription(raw: Obj): SubscriptionInfo | null {
  const id = str(raw.id);
  if (!id) return null;
  const items: SubscriptionInfo["items"] = [];
  let periodEnd = epoch(raw.current_period_end);
  const data = obj(raw.items)?.data;
  if (Array.isArray(data)) {
    for (const entry of data) {
      const item = obj(entry);
      if (!item) continue;
      const priceId = idOf(item.price) ?? idOf(item.plan);
      const quantity = typeof item.quantity === "number" && Number.isInteger(item.quantity) && item.quantity >= 0 ? item.quantity : 1;
      if (priceId) items.push({ priceId, quantity });
      const itemEnd = epoch(item.current_period_end);
      if (itemEnd && (!periodEnd || itemEnd > periodEnd)) periodEnd = itemEnd;
    }
  }
  return {
    id,
    customerId: idOf(raw.customer),
    status: str(raw.status) ?? "unknown",
    businessId: businessIdIn(raw.metadata),
    cancelAtPeriodEnd: raw.cancel_at_period_end === true || epoch(raw.cancel_at) !== null,
    currentPeriodEnd: epoch(raw.cancel_at) ?? periodEnd,
    endedAt: epoch(raw.ended_at),
    items,
  };
}

/** Suscripción, cliente y negocio de una factura (API nueva: `parent.subscription_details`). */
export function readInvoice(raw: Obj): { subscriptionId: string | null; customerId: string | null; businessId: string | null } {
  const details = obj(obj(raw.parent)?.subscription_details);
  return {
    subscriptionId: idOf(details?.subscription) ?? idOf(raw.subscription),
    customerId: idOf(raw.customer),
    businessId: businessIdIn(details?.metadata) ?? businessIdIn(obj(raw.subscription_details)?.metadata),
  };
}

/** Negocio, cliente y suscripción de un Checkout terminado. */
export function readCheckoutSession(raw: Obj): { mode: string | null; businessId: string | null; customerId: string | null; subscriptionId: string | null } {
  const reference = str(raw.client_reference_id);
  return {
    mode: str(raw.mode),
    businessId: reference && RE_UUID.test(reference) ? reference.toLowerCase() : businessIdIn(raw.metadata),
    customerId: idOf(raw.customer),
    subscriptionId: idOf(raw.subscription),
  };
}

/** Estado de una suscripción de Stripe → estado del cobro (null = no cambia). */
export function billingStatusOf(stripeStatus: string): BillingStatus | null {
  switch (stripeStatus) {
    case "active":
      return "active";
    case "trialing":
      return "trial";
    case "past_due":
    case "unpaid":
    case "paused":
      return "past_due";
    case "canceled":
      return "cancelled";
    default:
      return null; // incomplete, incomplete_expired: Checkout sin pagar todavía
  }
}

/** Estados en los que la suscripción sigue viva (cuenta como "tiene suscripción"). */
export const LIVE_SUBSCRIPTION_STATUSES: readonly string[] = ["active", "trialing", "past_due", "unpaid", "paused"];

/** Plan y cupos extra que dicen los ítems de la suscripción (plan null = Price ID desconocido). */
export function planFromItems(
  items: SubscriptionInfo["items"],
  prices: StripeConfig["prices"],
): { plan: Plan | null; extraLocations: number; extraStaff: number } {
  let plan: Plan | null = null;
  let extraLocations = 0;
  let extraStaff = 0;
  for (const item of items) {
    const mapped = planOfPrice({ prices }, item.priceId);
    if (mapped === "pro" || (mapped === "basic" && plan === null)) plan = mapped;
    if (prices.extraLocation && item.priceId === prices.extraLocation) extraLocations += item.quantity;
    if (prices.extraStaff && item.priceId === prices.extraStaff) extraStaff += item.quantity;
  }
  return { plan, extraLocations, extraStaff };
}

// ── Cambios sobre el negocio ────────────────────────────────────────────────

/** Lo que pasa con el servicio al cambiar el cobro: reactivar si estaba pausado por el cobro. */
function reactivationFor(current: Business, nextBilling: BillingStatus | undefined): SubscriptionChanges {
  if (nextBilling !== "active" && nextBilling !== "trial") return {};
  if (current.status === "paused" && current.billingPausedAt) return { status: "active", billingPausedAt: null };
  return {};
}

/** Pausa POR EL COBRO (si está activo). */
function billingPause(current: Business, now: Date): SubscriptionChanges {
  return current.status === "active" ? { status: "paused", billingPausedAt: now } : {};
}

/** Plan y cupos del Pro según la suscripción, sobre lo contratado (null = no tocar). */
function planChanges(current: Business, sub: SubscriptionInfo, prices: StripeConfig["prices"] | null): SubscriptionChanges {
  if (!prices) return {};
  const mapped = planFromItems(sub.items, prices);
  if (!mapped.plan) {
    log.warn("stripe_unknown_price", { businessId: current.id, subscriptionId: sub.id });
    return {};
  }
  const e = resolveEntitlements(current);
  const limits: LimitOverrides = {};
  for (const key of LIMIT_KEYS) {
    const value = e.overrides.limits[key];
    if (value !== undefined) limits[key] = value;
  }
  // Los cupos extra solo los manda Stripe si hay precio por cupo; y son del Pro.
  if (prices.extraLocation) {
    delete limits.locations;
    if (mapped.plan === "pro" && mapped.extraLocations > 0) limits.locations = (PLANS.pro.limits.locations ?? 1) + mapped.extraLocations;
  }
  if (prices.extraStaff) {
    delete limits.staff;
    if (mapped.plan === "pro" && mapped.extraStaff > 0) limits.staff = (PLANS.pro.limits.staff ?? 0) + mapped.extraStaff;
  }
  const extra = normalizeExtraModules(mapped.plan, { modules: e.overrides.modules, limits });
  return { plan: mapped.plan, extraModules: toStoredExtraModules(extra) };
}

function subscriptionChanges(current: Business, sub: SubscriptionInfo, eventType: string, eventAt: Date, now: Date, prices: StripeConfig["prices"] | null): SubscriptionChanges | "stale" {
  // Un evento de OTRA suscripción que ya no está viva (p. ej. la vieja que termina después
  // de que el negocio se suscribió de nuevo) no pisa a la actual.
  if (current.stripeSubscriptionId && current.stripeSubscriptionId !== sub.id && !LIVE_SUBSCRIPTION_STATUSES.includes(sub.status)) return "stale";

  const deleted = eventType === "customer.subscription.deleted";
  const status = deleted ? "canceled" : sub.status;
  const billing = billingStatusOf(status);
  const changes: SubscriptionChanges = {
    stripeSubscriptionId: sub.id,
    stripeSubscriptionStatus: status,
    cancelAtPeriodEnd: deleted ? false : sub.cancelAtPeriodEnd,
    currentPeriodEnd: deleted ? (sub.endedAt ?? sub.currentPeriodEnd ?? eventAt) : sub.currentPeriodEnd,
    stripeSyncedAt: eventAt,
  };
  if (sub.customerId) changes.stripeCustomerId = sub.customerId;
  if (billing && billing !== "cancelled") Object.assign(changes, planChanges(current, sub, prices));
  if (billing) changes.billingStatus = billing;

  if (billing === "past_due") changes.pastDueSince = current.billingStatus === "past_due" && current.pastDueSince ? current.pastDueSince : eventAt;
  else if (billing) changes.pastDueSince = null;

  Object.assign(changes, reactivationFor(current, billing ?? undefined));
  // Terminada (o cancelada con el período ya cumplido): sin servicio.
  if (billing === "cancelled" && (deleted || !changes.currentPeriodEnd || changes.currentPeriodEnd <= now)) Object.assign(changes, billingPause(current, now));
  return changes;
}

function invoiceChanges(current: Business, eventType: string, eventAt: Date): SubscriptionChanges {
  if (eventType === "invoice.payment_failed") {
    // Un cobro fallido de una suscripción cancelada no la revive como "atrasada".
    if (current.billingStatus === "cancelled") return {};
    return {
      billingStatus: "past_due",
      pastDueSince: current.billingStatus === "past_due" && current.pastDueSince ? current.pastDueSince : eventAt,
    };
  }
  // La factura en $0 del arranque de una suscripción en prueba no la saca de la prueba (el
  // cambio a `active` lo trae la suscripción cuando Stripe cobra de verdad).
  if (current.stripeSubscriptionStatus === "trialing") return {};
  // Pagada: al día y, si estaba pausado por el cobro, se reactiva.
  return { billingStatus: "active", pastDueSince: null, ...reactivationFor(current, "active") };
}

/** Lo auditado del cobro de un negocio: sin datos personales. */
function billingState(business: Business) {
  const e = resolveEntitlements(business);
  return { plan: e.plan, modules: e.modules, overrides: e.overrides, billingStatus: e.billingStatus };
}

async function auditChange(tx: Tx, before: Business, after: Business, eventType: string): Promise<void> {
  const planOrBillingChanged =
    before.plan !== after.plan || before.billingStatus !== after.billingStatus || JSON.stringify(before.extraModules) !== JSON.stringify(after.extraModules);
  if (planOrBillingChanged) {
    await recordAudit(tx, after.id, "plan_changed", STRIPE_ACTOR, { source: eventType, before: billingState(before), after: billingState(after) });
  }
  if (before.status !== after.status) {
    const action = after.status === "paused" ? "business_paused" : "business_reactivated";
    await recordAudit(tx, after.id, action, STRIPE_ACTOR, { source: eventType, billingStatus: after.billingStatus });
  }
}

/** Aplica cambios con la fila bloqueada, salvo que el evento sea más viejo que el último aplicado. */
async function applyToBusiness(
  tx: Tx,
  businessId: string,
  eventType: string,
  eventAt: Date,
  build: (current: Business) => SubscriptionChanges | "stale",
): Promise<"applied" | "stale" | "unknown_business"> {
  const flags = { stale: false };
  const changed = await updateBusinessSubscription(tx, businessId, (current) => {
    if (current.stripeSyncedAt && eventAt < current.stripeSyncedAt) {
      flags.stale = true;
      return {};
    }
    const next = build(current);
    if (next === "stale") {
      flags.stale = true;
      return {};
    }
    return next;
  });
  if (!changed) return "unknown_business";
  if (flags.stale) return "stale";
  await auditChange(tx, changed.before, changed.after, eventType);
  return "applied";
}

async function businessExists(tx: Tx, businessId: string | null): Promise<string | null> {
  if (!businessId) return null;
  return (await getBusinessRow(tx, businessId)) ? businessId : null;
}

/**
 * Procesa un evento de Stripe YA VERIFICADO (firma). Idempotente por `event.id`. Devuelve
 * qué pasó; el webhook responde 200 en todos los casos (un evento que no nos sirve no se
 * reintenta), salvo que la base falle (500 → Stripe reintenta).
 */
export async function processStripeEvent(db: Executor, event: StripeEventLike, options: ProcessStripeEventOptions): Promise<StripeEventResult> {
  const now = (options.now ?? (() => new Date()))();
  const eventAt = epoch(event.created) ?? now;
  const object = event.data.object;

  const result = await withSystem(db, async (tx): Promise<StripeEventResult> => {
    const inserted = await tx
      .insert(stripeEvents)
      .values({ id: event.id, type: event.type })
      .onConflictDoNothing({ target: stripeEvents.id })
      .returning({ id: stripeEvents.id });
    if (inserted.length === 0) return { outcome: "duplicate", businessId: null };

    let businessId: string | null = null;
    let outcome: StripeEventOutcome = "ignored";

    switch (event.type) {
      case "checkout.session.completed": {
        const session = readCheckoutSession(object);
        if (session.mode !== "subscription") break;
        businessId =
          (await businessExists(tx, session.businessId)) ??
          (await findBusinessIdByStripe(tx, { subscriptionId: session.subscriptionId, customerId: session.customerId }));
        if (!businessId) {
          outcome = "unknown_business";
          break;
        }
        const changed = await updateBusinessSubscription(tx, businessId, (current) => ({
          ...(session.customerId ? { stripeCustomerId: session.customerId } : {}),
          // La suscripción nueva reemplaza a una vieja que ya no está viva; una viva no se pisa
          // con otra (la resuelven sus propios eventos).
          ...(session.subscriptionId &&
          (!current.stripeSubscriptionId || !LIVE_SUBSCRIPTION_STATUSES.includes(current.stripeSubscriptionStatus ?? ""))
            ? { stripeSubscriptionId: session.subscriptionId }
            : {}),
        }));
        outcome = changed ? "applied" : "unknown_business";
        break;
      }

      case "customer.subscription.created":
      case "customer.subscription.updated":
      case "customer.subscription.paused":
      case "customer.subscription.resumed":
      case "customer.subscription.deleted": {
        const sub = readSubscription(object);
        if (!sub) break;
        businessId =
          (await businessExists(tx, sub.businessId)) ?? (await findBusinessIdByStripe(tx, { subscriptionId: sub.id, customerId: sub.customerId }));
        if (!businessId) {
          outcome = "unknown_business";
          break;
        }
        outcome = await applyToBusiness(tx, businessId, event.type, eventAt, (current) =>
          subscriptionChanges(current, sub, event.type, eventAt, now, options.prices),
        );
        break;
      }

      case "invoice.paid":
      case "invoice.payment_succeeded":
      case "invoice.payment_failed": {
        const invoice = readInvoice(object);
        // Solo facturas de una suscripción (una factura suelta no dice nada del plan).
        if (!invoice.subscriptionId) break;
        businessId =
          (await findBusinessIdByStripe(tx, { subscriptionId: invoice.subscriptionId, customerId: invoice.customerId })) ??
          (await businessExists(tx, invoice.businessId));
        if (!businessId) {
          outcome = "unknown_business";
          break;
        }
        outcome = await applyToBusiness(tx, businessId, event.type, eventAt, (current) => {
          // Una factura de otra suscripción (vieja) no cambia el estado de la actual.
          if (current.stripeSubscriptionId && current.stripeSubscriptionId !== invoice.subscriptionId) return "stale";
          return invoiceChanges(current, event.type, eventAt);
        });
        break;
      }

      default:
        break;
    }

    if (businessId) await tx.update(stripeEvents).set({ businessId }).where(eq(stripeEvents.id, event.id));
    return { outcome, businessId };
  });

  if (result.businessId && result.outcome === "applied") invalidateBusinessContext(result.businessId);
  return result;
}

/** Cantidad de eventos registrados (diagnóstico / tests). */
export async function countStripeEvents(db: Executor): Promise<number> {
  const [row] = await withSystem(db, (tx) => tx.select({ n: sql<number>`count(*)::int` }).from(stripeEvents));
  return Number(row?.n ?? 0);
}
