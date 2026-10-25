import { z } from "zod";
import type { Executor } from "../../platform/db/scope";
import { HttpError } from "../../platform/http/errors";
import { publicUrl } from "../../platform/http/publicUrl";
import { route } from "../../platform/http/router";
import type { Route } from "../../platform/http/routeTypes";
import { getBusinessRow, type BillingStatus } from "../business";
import { stripeGatewayFor } from "./gateway";
import { BILLING_OPTION_LABELS, BILLING_OPTIONS, stripeConfigFromEnv, type BillingOption, type StripeConfig, type StripeGateway } from "./stripe";

// ─────────────────────────────────────────────────────────────────────────────
// Suscripción por Stripe desde el panel (I6.6), solo el dueño (Configuración › Plan):
//
//   GET  /billing/status     ¿hay Stripe?, opciones con precio, ¿ya está suscrito?, estado
//                            del cobro y fin de la prueba. Sin Stripe: `configured: false`
//                            (el panel muestra el texto del cobro manual).
//   POST /billing/checkout   { option } → { url } del Checkout de Stripe. 409 si ya hay una
//                            suscripción viva (se cambia de plan desde el Portal).
//   POST /billing/portal     → { url } del Portal del cliente (tarjeta, plan, facturas,
//                            cancelar). 409 si todavía no se suscribió.
//
// Sin configuración, checkout y portal responden 503 `billing_not_configured`. Lo que
// Stripe cambia en el negocio llega SOLO por el webhook firmado (./stripeWebhook.ts): la
// vuelta del Checkout (`?billing=ok`) no toca nada.
// ─────────────────────────────────────────────────────────────────────────────

export interface BillingRouteDeps {
  db: Executor;
  /** Default: la del entorno. */
  stripeConfig?: () => StripeConfig | null;
  /** Default: el SDK real. */
  stripeGateway?: (config: StripeConfig) => StripeGateway;
}

export interface BillingStatusView {
  configured: boolean;
  options: { id: BillingOption; label: string }[];
  /** Tiene una suscripción de Stripe viva. */
  subscribed: boolean;
  /** Puede abrir el Portal (ya es cliente de Stripe). */
  canManage: boolean;
  billingStatus: BillingStatus;
  /** Fin de la prueba gratis (ISO), si la hay. */
  trialEndsAt: string | null;
}

const OWNER = ["owner"] as const;
const CheckoutBody = z.object({ option: z.enum(BILLING_OPTIONS) });

const notConfigured = () =>
  new HttpError(503, "El pago en línea todavía no está disponible. Escribinos y lo ajustamos a mano.", "billing_not_configured");

/** Vuelta del Checkout y del Portal: Configuración › Plan. */
const PLAN_PATH = "/panel/settings/plan";

export function billingRoutes({ db, stripeConfig = () => stripeConfigFromEnv(), stripeGateway = stripeGatewayFor }: BillingRouteDeps): Route[] {
  async function businessOf(businessId: string) {
    const business = await getBusinessRow(db, businessId);
    if (!business) throw new HttpError(404, "Negocio no encontrado.", "not_found");
    return business;
  }

  const subscribedOf = (b: { stripeSubscriptionId: string | null; billingStatus: string }) =>
    Boolean(b.stripeSubscriptionId) && b.billingStatus !== "cancelled";

  return [
    route({ method: "GET", path: "/billing/status", auth: "user", roles: OWNER }, async ({ session }): Promise<BillingStatusView> => {
      const config = stripeConfig();
      const business = await businessOf(session.businessId);
      return {
        configured: config !== null,
        options: config ? BILLING_OPTIONS.filter((o) => config.prices[o]).map((id) => ({ id, label: BILLING_OPTION_LABELS[id] })) : [],
        subscribed: subscribedOf(business),
        canManage: config !== null && Boolean(business.stripeCustomerId),
        billingStatus: business.billingStatus as BillingStatus,
        trialEndsAt: business.trialEndsAt?.toISOString() ?? null,
      };
    }),

    route({ method: "POST", path: "/billing/checkout", auth: "user", roles: OWNER, body: CheckoutBody }, async ({ session, body, log }) => {
      const config = stripeConfig();
      if (!config) throw notConfigured();
      const priceId = config.prices[body.option];
      if (!priceId) throw new HttpError(400, "Esa opción no se vende en línea todavía.", "option_not_available");
      const business = await businessOf(session.businessId);
      if (subscribedOf(business)) {
        throw new HttpError(409, "Tu negocio ya tiene una suscripción. Cambiá de plan desde «Administrar pago».", "already_subscribed");
      }
      const { url } = await stripeGateway(config).createCheckoutSession({
        priceId,
        businessId: business.id,
        option: body.option,
        customerId: business.stripeCustomerId,
        customerEmail: business.billingEmail,
        successUrl: publicUrl(PLAN_PATH, { billing: "ok" }),
        cancelUrl: publicUrl(PLAN_PATH, { billing: "cancelled" }),
      });
      log.info("billing_checkout_created", { businessId: business.id, option: body.option });
      return { url };
    }),

    route({ method: "POST", path: "/billing/portal", auth: "user", roles: OWNER }, async ({ session }) => {
      const config = stripeConfig();
      if (!config) throw notConfigured();
      const business = await businessOf(session.businessId);
      if (!business.stripeCustomerId) throw new HttpError(409, "Todavía no te suscribiste en línea.", "not_subscribed");
      return stripeGateway(config).createPortalSession({ customerId: business.stripeCustomerId, returnUrl: publicUrl(PLAN_PATH) });
    }),
  ];
}
