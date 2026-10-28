import Stripe from "stripe";
import type { StripeConfig } from "./stripeConfig";

// ─────────────────────────────────────────────────────────────────────────────
// La única puerta hacia Stripe (SDK oficial `stripe`). Superficie mínima a propósito:
//
//   • Checkout Session para la primera suscripción (Stripe arma la página de pago);
//   • Customer Portal para todo lo demás (cambiar de plan o cupos, tarjeta, cancelar,
//     facturas): esa UI también es de Stripe, no nuestra;
//   • verificar la firma de un webhook (no necesita red ni la clave secreta).
//
// El resto del módulo habla con esta interfaz (`StripeGateway`): los tests inyectan un
// doble y nunca salen a la red. Los objetos que vuelven de los eventos se leen con tipos
// propios mínimos (./stripeSync.ts), no con los del SDK: así un cambio de versión de la
// API de Stripe no rompe la compilación de todo el módulo.
// ─────────────────────────────────────────────────────────────────────────────

export interface CheckoutSessionInput {
  businessId: string;
  /** Cliente de Stripe del negocio si ya tiene (si no, Checkout lo crea con `customerEmail`). */
  customerId: string | null;
  customerEmail: string | null;
  lineItems: { price: string; quantity: number }[];
  /** Fin de la prueba del negocio: Stripe no cobra hasta entonces (null = cobra ya). */
  trialEnd: Date | null;
  successUrl: string;
  cancelUrl: string;
}

export interface PortalSessionInput {
  customerId: string;
  returnUrl: string;
}

/** Evento ya verificado, con lo mínimo que se lee de él. */
export interface StripeEventLike {
  id: string;
  type: string;
  /** Epoch en segundos. */
  created: number;
  data: { object: Record<string, unknown> };
}

export interface StripeGateway {
  createCheckoutSession(input: CheckoutSessionInput): Promise<{ id: string; url: string }>;
  createPortalSession(input: PortalSessionInput): Promise<{ url: string }>;
}

/** Error de configuración o de Stripe que el llamador traduce a una respuesta clara. */
export class StripeGatewayError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "StripeGatewayError";
  }
}

const clients = new Map<string, Stripe>();

function clientFor(secretKey: string): Stripe {
  let client = clients.get(secretKey);
  if (!client) {
    // Reintentos y timeout acotados: el panel espera la URL de Checkout en el request.
    client = new Stripe(secretKey, { maxNetworkRetries: 1, timeout: 15_000, appInfo: { name: "selyon-crm" } });
    clients.set(secretKey, client);
  }
  return client;
}

/** Gateway real contra la API de Stripe. */
export function createStripeGateway(config: Pick<StripeConfig, "secretKey">): StripeGateway {
  const stripe = clientFor(config.secretKey);
  return {
    async createCheckoutSession(input) {
      const session = await stripe.checkout.sessions.create({
        mode: "subscription",
        client_reference_id: input.businessId,
        ...(input.customerId ? { customer: input.customerId } : input.customerEmail ? { customer_email: input.customerEmail } : {}),
        line_items: input.lineItems,
        success_url: input.successUrl,
        cancel_url: input.cancelUrl,
        locale: "es",
        allow_promotion_codes: true,
        // El negocio viaja también en la metadata de la SUSCRIPCIÓN: los eventos
        // customer.subscription.* se resuelven aunque lleguen antes que el de Checkout.
        metadata: { businessId: input.businessId },
        subscription_data: {
          metadata: { businessId: input.businessId },
          ...(input.trialEnd ? { trial_end: Math.floor(input.trialEnd.getTime() / 1000) } : {}),
        },
      });
      if (!session.url) throw new StripeGatewayError("Stripe no devolvió la URL de Checkout.");
      return { id: session.id, url: session.url };
    },

    async createPortalSession(input) {
      const session = await stripe.billingPortal.sessions.create({ customer: input.customerId, return_url: input.returnUrl, locale: "es" });
      return { url: session.url };
    },
  };
}

/**
 * Verifica la firma `Stripe-Signature` sobre el cuerpo CRUDO y devuelve el evento. Lanza
 * si la firma no corresponde, venció (tolerancia de 5 min) o el cuerpo no es un evento.
 * No usa la red ni la clave secreta: solo el secreto del endpoint.
 */
export function verifyStripeEvent(rawBody: Buffer, signature: string, webhookSecret: string): StripeEventLike {
  const event = Stripe.webhooks.constructEvent(rawBody, signature, webhookSecret) as unknown as StripeEventLike;
  if (!event || typeof event.id !== "string" || typeof event.type !== "string" || !event.data || typeof event.data.object !== "object") {
    throw new StripeGatewayError("El evento de Stripe no tiene la forma esperada.");
  }
  return event;
}

/** Cabecera `Stripe-Signature` válida para un cuerpo (solo tests y scripts de prueba). */
export function signStripePayload(payload: string, webhookSecret: string, timestampSec?: number): string {
  return Stripe.webhooks.generateTestHeaderString({ payload, secret: webhookSecret, ...(timestampSec ? { timestamp: timestampSec } : {}) });
}
