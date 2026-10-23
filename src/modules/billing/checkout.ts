import { z } from "zod";
import type { Executor } from "../../platform/db/scope";
import { HttpError } from "../../platform/http/errors";
import { publicUrl } from "../../platform/http/publicUrl";
import { log } from "../../platform/observability/log";
import { getBusinessRow, PLANS as PLAN_IDS, type Business, type Plan } from "../business";
import { PLANS } from "./catalog";
import { resolveEntitlements } from "./entitlements";
import { pauseDateFor, priceOfPlan, readStripeConfig, type StripeConfig } from "./stripeConfig";
import { createStripeGateway, type StripeGateway } from "./stripeGateway";
import { LIVE_SUBSCRIPTION_STATUSES } from "./stripeSync";

// ─────────────────────────────────────────────────────────────────────────────
// Lo del dueño sobre el cobro en línea (Configuración › Plan):
//
//   • estado: plan, cobro, prueba, período, atraso y qué puede hacer (suscribirse o
//     gestionar el pago);
//   • suscribirse: un Checkout de Stripe con el plan elegido (y, en el Pro, los cupos
//     extra si hay precio por cupo). Si está en prueba, Stripe no cobra hasta que termine;
//   • gestionar el pago: el Customer Portal de Stripe (plan, cupos, tarjeta, cancelar,
//     facturas).
//
// Sin Stripe configurado todo responde 503 `billing_not_configured` y el cobro sigue
// siendo manual (superadmin). Estas rutas se aceptan con el negocio PAUSADO POR EL COBRO
// (para que el dueño pueda pagar y reactivarlo); con una pausa del superadmin, no.
// ─────────────────────────────────────────────────────────────────────────────

/** Ruta del panel a la que vuelve Stripe (Configuración › Plan). */
export const PLAN_SETTINGS_PATH = "/panel/settings/plan";

/** Tope de cupos extra por compra (la base de datos acepta hasta 500 sucursales). */
const MAX_EXTRA = 100;

export const CheckoutInput = z
  .object({
    plan: z.enum(PLAN_IDS),
    /** Sucursales extra del Pro (precio por cupo). */
    extraLocations: z.int().min(0).max(MAX_EXTRA).default(0),
    /** Profesionales extra del Pro (precio por cupo). */
    extraStaff: z.int().min(0).max(MAX_EXTRA).default(0),
  })
  .strict();

export type CheckoutInputValue = z.output<typeof CheckoutInput>;

export interface BillingStatusView {
  /** ¿Se puede pagar en línea? (Stripe configurado en el servidor). */
  onlinePayments: boolean;
  /** Planes que se pueden contratar en línea (con precio cargado). */
  plans: { id: Plan; label: string; available: boolean }[];
  /** ¿Hay precio por sucursal / profesional extra del Pro? */
  extras: { locations: boolean; staff: boolean };
  plan: Plan;
  planLabel: string;
  billingStatus: string;
  trialEndsAt: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  pastDueSince: string | null;
  /** Cuándo se pausa la cuenta si no se paga (atraso + gracia), o null. */
  pauseAt: string | null;
  /** ¿Tiene una suscripción viva en Stripe? (entonces se gestiona desde el Portal). */
  hasSubscription: boolean;
  /** ¿Tiene cliente en Stripe? (puede abrir el Portal). */
  canManage: boolean;
  paused: boolean;
  /** Pausado por el cobro (al pagar se reactiva solo). */
  pausedForBilling: boolean;
}

export interface BillingDeps {
  /** Gateway de Stripe (los tests inyectan un doble). Default: el real con la config del entorno. */
  gateway?: (config: StripeConfig) => StripeGateway;
  env?: Record<string, string | undefined>;
  now?: () => Date;
}

export const billingNotConfigured = () =>
  new HttpError(
    503,
    "El pago en línea todavía no está disponible. Escribinos para contratar o cambiar tu plan.",
    "billing_not_configured",
  );

const stripeUnavailable = () =>
  new HttpError(502, "No pudimos conectar con el procesador de pagos. Probá de nuevo en un momento.", "stripe_error");

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

function hasLiveSubscription(business: Business): boolean {
  return Boolean(business.stripeSubscriptionId) && LIVE_SUBSCRIPTION_STATUSES.includes(business.stripeSubscriptionStatus ?? "");
}

async function loadBusiness(db: Executor, businessId: string): Promise<Business> {
  const business = await getBusinessRow(db, businessId);
  if (!business) throw new HttpError(404, "Negocio no encontrado.", "not_found");
  // Pausado por el superadmin (no por el cobro): desde acá no se reactiva nada.
  if (business.status === "paused" && !business.billingPausedAt) {
    throw new HttpError(403, "La cuenta de este negocio está pausada. Escribinos para reactivarla.", "business_paused");
  }
  if (business.status === "closed") throw new HttpError(403, "El negocio está dado de baja.", "business_closed");
  return business;
}

export function billingStatusOfBusiness(business: Business, env: Record<string, string | undefined> = process.env): BillingStatusView {
  const config = readStripeConfig(env);
  const e = resolveEntitlements(business);
  return {
    onlinePayments: config !== null,
    plans: (["basic", "pro"] as const).map((id) => ({ id, label: PLANS[id].label, available: Boolean(config && priceOfPlan(config, id)) })),
    extras: { locations: Boolean(config?.prices.extraLocation), staff: Boolean(config?.prices.extraStaff) },
    plan: e.plan,
    planLabel: e.label,
    billingStatus: business.billingStatus,
    trialEndsAt: iso(business.trialEndsAt),
    currentPeriodEnd: iso(business.currentPeriodEnd),
    cancelAtPeriodEnd: business.cancelAtPeriodEnd,
    pastDueSince: iso(business.pastDueSince),
    pauseAt: business.billingStatus === "past_due" && business.pastDueSince ? pauseDateFor(business.pastDueSince, env).toISOString() : null,
    hasSubscription: hasLiveSubscription(business),
    canManage: Boolean(business.stripeCustomerId),
    paused: business.status === "paused",
    pausedForBilling: business.status === "paused" && Boolean(business.billingPausedAt),
  };
}

export async function getBillingStatus(db: Executor, businessId: string, deps: BillingDeps = {}): Promise<BillingStatusView> {
  return billingStatusOfBusiness(await loadBusiness(db, businessId), deps.env);
}

/** Stripe pide que el fin de la prueba de un Checkout esté al menos 48 h adelante. */
const MIN_TRIAL_LEFT_MS = 49 * 60 * 60 * 1000;

/** Crea el Checkout de la primera suscripción y devuelve su URL. */
export async function startCheckout(
  db: Executor,
  input: { businessId: string; ownerEmail: string | null } & CheckoutInputValue,
  deps: BillingDeps = {},
): Promise<{ url: string }> {
  const config = readStripeConfig(deps.env);
  if (!config) throw billingNotConfigured();
  const business = await loadBusiness(db, input.businessId);
  if (hasLiveSubscription(business)) {
    throw new HttpError(409, "Ya tenés una suscripción activa: cambiá de plan, cupos o tarjeta desde «Gestionar pago».", "already_subscribed");
  }
  const price = priceOfPlan(config, input.plan);
  if (!price) throw new HttpError(400, "Ese plan todavía no se puede contratar en línea. Escribinos y lo activamos.", "plan_not_available");

  const lineItems = [{ price, quantity: 1 }];
  if (input.plan === "pro") {
    if (input.extraLocations > 0) {
      if (!config.prices.extraLocation) throw new HttpError(400, "Las sucursales extra todavía no se pueden contratar en línea.", "plan_not_available");
      lineItems.push({ price: config.prices.extraLocation, quantity: input.extraLocations });
    }
    if (input.extraStaff > 0) {
      if (!config.prices.extraStaff) throw new HttpError(400, "Los profesionales extra todavía no se pueden contratar en línea.", "plan_not_available");
      lineItems.push({ price: config.prices.extraStaff, quantity: input.extraStaff });
    }
  }

  // En prueba: la suscripción arranca ya, pero Stripe cobra recién al terminar la prueba.
  const now = (deps.now ?? (() => new Date()))();
  const trialEnd =
    business.billingStatus === "trial" && business.trialEndsAt && business.trialEndsAt.getTime() - now.getTime() >= MIN_TRIAL_LEFT_MS
      ? business.trialEndsAt
      : null;

  const gateway = (deps.gateway ?? createStripeGateway)(config);
  try {
    const session = await gateway.createCheckoutSession({
      businessId: business.id,
      customerId: business.stripeCustomerId,
      customerEmail: business.stripeCustomerId ? null : (business.billingEmail ?? input.ownerEmail),
      lineItems,
      trialEnd,
      successUrl: publicUrl(PLAN_SETTINGS_PATH, { checkout: "success" }),
      cancelUrl: publicUrl(PLAN_SETTINGS_PATH, { checkout: "cancelled" }),
    });
    return { url: session.url };
  } catch (error) {
    log.error("stripe_checkout_failed", { businessId: business.id, error: error instanceof Error ? error.message : String(error) });
    throw stripeUnavailable();
  }
}

/** Abre el Customer Portal de Stripe del negocio y devuelve su URL. */
export async function openPortal(db: Executor, businessId: string, deps: BillingDeps = {}): Promise<{ url: string }> {
  const config = readStripeConfig(deps.env);
  if (!config) throw billingNotConfigured();
  const business = await loadBusiness(db, businessId);
  if (!business.stripeCustomerId) {
    throw new HttpError(409, "Todavía no tenés una suscripción en línea: suscribite primero.", "no_billing_account");
  }
  const gateway = (deps.gateway ?? createStripeGateway)(config);
  try {
    return await gateway.createPortalSession({ customerId: business.stripeCustomerId, returnUrl: publicUrl(PLAN_SETTINGS_PATH) });
  } catch (error) {
    log.error("stripe_portal_failed", { businessId: business.id, error: error instanceof Error ? error.message : String(error) });
    throw stripeUnavailable();
  }
}
