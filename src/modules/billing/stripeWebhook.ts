import type { IncomingMessage, ServerResponse } from "node:http";
import type { Executor } from "../../platform/db/scope";
import { readBodyWithLimit, type HttpHandler } from "../../platform/net/http";
import { msFromEnv } from "../../platform/net/timeouts";
import { log } from "../../platform/observability/log";
import { captureError } from "../../platform/observability/sentry";
import { applyStripeEvent, isEventProcessed, type StripeEventInput } from "./subscriptions";
import { stripeGatewayFor } from "./gateway";
import { isValidStripeSignature, stripeConfigFromEnv, type StripeConfig, type StripeGateway } from "./stripe";

// ─────────────────────────────────────────────────────────────────────────────
// Webhook de Stripe (`POST /webhook/stripe`, fuera de /api/panel: lo llama Stripe, sin
// sesión ni CSRF). Mismo esqueleto que el de WhatsApp:
//
//   1) sin configuración → 503 (Stripe reintenta; nada se pierde mientras se configura);
//   2) tope del cuerpo (413) ANTES de verificar nada;
//   3) firma `Stripe-Signature` sobre el cuerpo CRUDO, con tolerancia de 5 min (400 si no
//      vale: un evento que no firmó Stripe no toca ningún negocio);
//   4) un evento ya procesado responde 200 sin hacer nada (idempotencia por id);
//   5) checkout completo y customer.subscription.*: se lee la suscripción FRESCA de la API
//      (los eventos llegan desordenados) y se aplica en una transacción con su registro
//      (./subscriptions.ts). Si la API o la base fallan → 500 y Stripe reintenta.
//   6) cualquier otro tipo se registra y se ignora.
// ─────────────────────────────────────────────────────────────────────────────

export const STRIPE_WEBHOOK_PATH = "/webhook/stripe";
const MAX_BODY_BYTES = msFromEnv("STRIPE_WEBHOOK_MAX_BODY_BYTES", 256 * 1024);

const SUBSCRIPTION_EVENTS = new Set([
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "customer.subscription.paused",
  "customer.subscription.resumed",
]);
const CHECKOUT_EVENTS = new Set(["checkout.session.completed", "checkout.session.async_payment_succeeded"]);

interface RawEvent {
  id: string;
  type: string;
  data: { object: Record<string, unknown> };
}

function parseEvent(raw: Buffer): RawEvent | null {
  try {
    const json = JSON.parse(raw.toString("utf8")) as Partial<RawEvent>;
    if (typeof json?.id !== "string" || typeof json.type !== "string" || !json.data || typeof json.data.object !== "object" || !json.data.object) return null;
    return json as RawEvent;
  } catch {
    return null;
  }
}

const idOf = (value: unknown): string | null =>
  typeof value === "string" ? value : value && typeof value === "object" && typeof (value as { id?: unknown }).id === "string" ? (value as { id: string }).id : null;

const metadataOf = (value: unknown): Record<string, unknown> => (value && typeof value === "object" ? (value as Record<string, unknown>) : {});

/** Lo que se aplica de un evento: el checkout (ids) y la suscripción leída de la API. */
async function eventInput(event: RawEvent, gateway: StripeGateway): Promise<StripeEventInput> {
  const object = event.data.object;
  if (CHECKOUT_EVENTS.has(event.type)) {
    if (object.mode !== "subscription") return { id: event.id, type: event.type };
    const subscriptionId = idOf(object.subscription);
    const businessId = typeof object.client_reference_id === "string" ? object.client_reference_id : (metadataOf(object.metadata).businessId as string | undefined) ?? null;
    return {
      id: event.id,
      type: event.type,
      checkout: { businessId, customerId: idOf(object.customer), subscriptionId },
      subscription: subscriptionId ? await gateway.retrieveSubscription(subscriptionId) : null,
    };
  }
  if (SUBSCRIPTION_EVENTS.has(event.type)) {
    const subscriptionId = idOf(object);
    return { id: event.id, type: event.type, subscription: subscriptionId ? await gateway.retrieveSubscription(subscriptionId) : null };
  }
  return { id: event.id, type: event.type };
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

export interface StripeWebhookOptions {
  db: Executor;
  /** Default: la del entorno (se relee en cada request: barata y sin estado). */
  config?: () => StripeConfig | null;
  /** Default: el SDK real con la clave de la configuración. */
  gateway?: (config: StripeConfig) => StripeGateway;
  now?: () => Date;
}

/** Handler HTTP de `/webhook/stripe` (lo monta src/app.ts). */
export function createStripeWebhookHandler(options: StripeWebhookOptions): HttpHandler {
  const configOf = options.config ?? (() => stripeConfigFromEnv());
  const gatewayOf = options.gateway ?? stripeGatewayFor;
  const now = options.now ?? (() => new Date());

  return async (req: IncomingMessage, res: ServerResponse) => {
    if ((req.method ?? "GET").toUpperCase() !== "POST") {
      res.setHeader("allow", "POST");
      return sendJson(res, 405, { error: "method_not_allowed" });
    }
    const config = configOf();
    if (!config) return sendJson(res, 503, { error: "billing_not_configured" });

    const raw = await readBodyWithLimit(req, MAX_BODY_BYTES);
    if (raw === null) {
      res.setHeader("connection", "close");
      return sendJson(res, 413, { error: "payload_too_large" });
    }
    if (!isValidStripeSignature(raw, req.headers["stripe-signature"], config.webhookSecret, now())) {
      log.warn("stripe_webhook_bad_signature", { bytes: raw.length });
      return sendJson(res, 400, { error: "invalid_signature" });
    }
    const event = parseEvent(raw);
    if (!event) return sendJson(res, 400, { error: "invalid_event" });

    try {
      if (await isEventProcessed(options.db, event.id)) return sendJson(res, 200, { received: true, outcome: "duplicate" });
      const outcome = await applyStripeEvent(options.db, config, await eventInput(event, gatewayOf(config)));
      log.info("stripe_webhook_processed", { eventId: event.id, type: event.type, outcome });
      return sendJson(res, 200, { received: true, outcome });
    } catch (e) {
      log.error("stripe_webhook_failed", { eventId: event.id, type: event.type, error: e instanceof Error ? e.message : String(e) });
      captureError(e, { webhook: "stripe", eventType: event.type });
      return sendJson(res, 500, { error: "internal_error" });
    }
  };
}
