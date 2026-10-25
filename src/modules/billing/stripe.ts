import { createHmac, timingSafeEqual } from "node:crypto";
import Stripe from "stripe";
import type { BillingStatus } from "../business";

// ─────────────────────────────────────────────────────────────────────────────
// Stripe (I6.6, absorbe C4.3): configuración, el cliente de la API y la verificación de la
// firma del webhook. Sin `STRIPE_SECRET_KEY` (y el secreto del webhook) todo esto es un
// no-op: las rutas responden 503 `billing_not_configured` y el cobro sigue siendo manual
// (PROCESO-COBRO-MANUAL.md).
//
// Superficie propia mínima a propósito (igual que el sistema viejo): un Checkout Session
// para suscribirse y un Customer Portal para todo lo demás (cambiar de plan, tarjeta,
// cancelar, facturas) — esa UI la hace Stripe. Los montos viven en Stripe: acá solo los
// Price IDs del entorno, uno por opción que se vende.
//
// La firma del webhook se verifica a mano (esquema documentado de Stripe: cabecera
// `Stripe-Signature: t=…,v1=…`, HMAC-SHA256 de `t.cuerpo` con el secreto del endpoint,
// tolerancia de 5 min): es lo mismo que hace el SDK, sin depender de su tipado, y se
// prueba con cuerpos firmados en el test.
// ─────────────────────────────────────────────────────────────────────────────

/** Lo que se vende por Stripe: los dos planes y el Pro sin agente. */
export const BILLING_OPTIONS = ["basic", "pro", "pro_no_agent"] as const;
export type BillingOption = (typeof BILLING_OPTIONS)[number];

export const BILLING_OPTION_LABELS: Record<BillingOption, string> = {
  basic: "Básico",
  pro: "Pro",
  pro_no_agent: "Pro sin agente",
};

const PRICE_ENV: Record<BillingOption, string> = {
  basic: "STRIPE_PRICE_BASIC",
  pro: "STRIPE_PRICE_PRO",
  pro_no_agent: "STRIPE_PRICE_PRO_NO_AGENT",
};

type Env = Record<string, string | undefined>;

export interface StripeConfig {
  secretKey: string;
  webhookSecret: string;
  /** Price ID de cada opción que se vende (las que no tienen precio no se ofrecen). */
  prices: Partial<Record<BillingOption, string>>;
}

const read = (env: Env, name: string) => env[name]?.trim() || undefined;

/**
 * Configuración del entorno, o null si falta lo mínimo (clave secreta, secreto del webhook
 * y al menos un precio). `env` inyectable para los tests.
 */
export function stripeConfigFromEnv(env: Env = process.env): StripeConfig | null {
  const secretKey = read(env, "STRIPE_SECRET_KEY");
  const webhookSecret = read(env, "STRIPE_WEBHOOK_SECRET");
  const prices: Partial<Record<BillingOption, string>> = {};
  for (const option of BILLING_OPTIONS) {
    const price = read(env, PRICE_ENV[option]);
    if (price) prices[option] = price;
  }
  if (!secretKey || !webhookSecret || Object.keys(prices).length === 0) return null;
  return { secretKey, webhookSecret, prices };
}

/** Opción que corresponde a un Price ID (el de la suscripción). null si no es ninguno de los nuestros: no se adivina. */
export function optionOfPrice(config: Pick<StripeConfig, "prices">, priceId: string | null | undefined): BillingOption | null {
  if (!priceId) return null;
  for (const option of BILLING_OPTIONS) if (config.prices[option] === priceId) return option;
  return null;
}

/** Estados de una suscripción de Stripe → estado del cobro del negocio. null = no cambia. */
export function billingStatusOf(stripeStatus: string): BillingStatus | null {
  switch (stripeStatus) {
    case "trialing":
      return "trial";
    case "active":
      return "active";
    case "past_due":
    case "unpaid":
    case "paused":
      return "past_due";
    case "canceled":
    case "incomplete_expired":
      return "cancelled";
    default:
      // `incomplete`: el primer pago está en curso (o falló y Stripe espera); el estado se
      // decide con el evento siguiente.
      return null;
  }
}

// ── Firma del webhook ────────────────────────────────────────────────────────

/** Tolerancia entre el `t` de la firma y el reloj (anti-replay de un evento viejo). */
export const SIGNATURE_TOLERANCE_SEC = 300;

/** Cabecera `Stripe-Signature` para un cuerpo (la usan los tests y nada más). */
export function signStripePayload(rawBody: string | Buffer, secret: string, timestampSec = Math.floor(Date.now() / 1000)): string {
  const signature = createHmac("sha256", secret).update(`${timestampSec}.`).update(rawBody).digest("hex");
  return `t=${timestampSec},v1=${signature}`;
}

/** ¿La firma corresponde al cuerpo crudo, con el secreto del endpoint y dentro de la tolerancia? */
export function isValidStripeSignature(rawBody: Buffer, header: string | string[] | undefined, secret: string, now = new Date()): boolean {
  if (typeof header !== "string" || !secret) return false;
  let timestamp: number | null = null;
  const signatures: string[] = [];
  for (const part of header.split(",")) {
    const [key, value] = part.trim().split("=", 2);
    if (key === "t" && value && /^\d+$/.test(value)) timestamp = Number(value);
    else if (key === "v1" && value) signatures.push(value);
  }
  if (timestamp === null || signatures.length === 0) return false;
  if (Math.abs(now.getTime() / 1000 - timestamp) > SIGNATURE_TOLERANCE_SEC) return false;
  const expected = Buffer.from(createHmac("sha256", secret).update(`${timestamp}.`).update(rawBody).digest("hex"));
  return signatures.some((s) => {
    const given = Buffer.from(s);
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
}

// ── API ──────────────────────────────────────────────────────────────────────

/** Lo que importa de una suscripción (ya leída de la API: el estado más nuevo, no el del evento). */
export interface SubscriptionSnapshot {
  id: string;
  customerId: string | null;
  status: string;
  priceId: string | null;
  trialEnd: Date | null;
  metadata: Record<string, string>;
}

export interface CheckoutInput {
  priceId: string;
  businessId: string;
  option: BillingOption;
  /** Cliente de Stripe del negocio si ya tiene uno (resuscribirse no duplica clientes). */
  customerId: string | null;
  customerEmail: string | null;
  successUrl: string;
  cancelUrl: string;
}

/** Lo que el módulo usa de Stripe (inyectable: los tests pasan un doble). */
export interface StripeGateway {
  createCheckoutSession(input: CheckoutInput): Promise<{ url: string }>;
  createPortalSession(input: { customerId: string; returnUrl: string }): Promise<{ url: string }>;
  retrieveSubscription(subscriptionId: string): Promise<SubscriptionSnapshot>;
}

const idOf = (value: unknown): string | null =>
  typeof value === "string" ? value : value && typeof value === "object" && typeof (value as { id?: unknown }).id === "string" ? (value as { id: string }).id : null;

/** Cliente real sobre el SDK oficial (una instancia por clave). */
export function createStripeGateway(config: Pick<StripeConfig, "secretKey">): StripeGateway {
  const stripe = new Stripe(config.secretKey);
  return {
    async createCheckoutSession(input) {
      const metadata = { businessId: input.businessId, option: input.option };
      const session = await stripe.checkout.sessions.create({
        mode: "subscription",
        client_reference_id: input.businessId,
        line_items: [{ price: input.priceId, quantity: 1 }],
        success_url: input.successUrl,
        cancel_url: input.cancelUrl,
        ...(input.customerId ? { customer: input.customerId } : input.customerEmail ? { customer_email: input.customerEmail } : {}),
        metadata,
        // El negocio viaja también en la metadata DE LA SUSCRIPCIÓN: los eventos
        // customer.subscription.* lo resuelven aunque llegue antes que checkout.session.completed.
        subscription_data: { metadata },
      });
      if (!session.url) throw new Error("Stripe no devolvió la URL del Checkout.");
      return { url: session.url };
    },

    async createPortalSession(input) {
      const session = await stripe.billingPortal.sessions.create({ customer: input.customerId, return_url: input.returnUrl });
      return { url: session.url };
    },

    async retrieveSubscription(subscriptionId) {
      const sub = await stripe.subscriptions.retrieve(subscriptionId);
      const item = sub.items?.data?.[0];
      return {
        id: sub.id,
        customerId: idOf(sub.customer),
        status: sub.status,
        priceId: item?.price?.id ?? null,
        trialEnd: typeof sub.trial_end === "number" ? new Date(sub.trial_end * 1000) : null,
        metadata: { ...(sub.metadata ?? {}) },
      };
    },
  };
}
