import type { IncomingMessage, ServerResponse } from "node:http";
import type { Executor } from "../../platform/db/scope";
import { sendJson } from "../../platform/http/http";
import { readBodyWithLimit, type HttpHandler } from "../../platform/net/http";
import { log } from "../../platform/observability/log";
import { captureError } from "../../platform/observability/sentry";
import { readStripeConfig, readStripeWebhookSecret } from "./stripeConfig";
import { verifyStripeEvent } from "./stripeGateway";
import { processStripeEvent } from "./stripeSync";

// ─────────────────────────────────────────────────────────────────────────────
// Webhook de Stripe (`POST /webhook/stripe`, fuera de /api/panel: lo llama Stripe, no el
// panel; sin sesión ni CSRF). Pasos:
//
//   1. Solo POST (405), cuerpo con tope (413).
//   2. Sin STRIPE_WEBHOOK_SECRET → 503 `billing_not_configured` (no se acepta nada sin firma).
//   3. Firma `Stripe-Signature` sobre el cuerpo CRUDO con el secreto (tolerancia 5 min) →
//      400 `invalid_signature` si no corresponde.
//   4. Se procesa (./stripeSync.ts, idempotente por id de evento) → 200 `{ received: true }`
//      siempre que se haya guardado (también si el evento no nos sirve: no se reintenta).
//      Si la base falla → 500 y Stripe reintenta.
// ─────────────────────────────────────────────────────────────────────────────

export const STRIPE_WEBHOOK_PATH = "/webhook/stripe";

/** Los eventos de Stripe pesan unos pocos KB; 512 KB es holgado. */
const MAX_BODY_BYTES = 512 * 1024;

export interface StripeWebhookOptions {
  db: Executor;
  env?: Record<string, string | undefined>;
  now?: () => Date;
}

export function createStripeWebhookHandler(options: StripeWebhookOptions): HttpHandler {
  return async (req: IncomingMessage, res: ServerResponse) => {
    res.setHeader("cache-control", "no-store");
    if ((req.method ?? "GET").toUpperCase() !== "POST") {
      res.setHeader("allow", "POST");
      return sendJson(res, 405, { ok: false, error: "Método no permitido.", code: "method_not_allowed" });
    }
    const raw = await readBodyWithLimit(req, MAX_BODY_BYTES);
    if (raw === null) {
      res.setHeader("connection", "close");
      return sendJson(res, 413, { ok: false, error: "El cuerpo de la solicitud es demasiado grande.", code: "payload_too_large" });
    }
    const secret = readStripeWebhookSecret(options.env);
    if (!secret) {
      log.warn("stripe_webhook_not_configured");
      return sendJson(res, 503, { ok: false, error: "El cobro en línea (Stripe) no está configurado.", code: "billing_not_configured" });
    }
    const signature = req.headers["stripe-signature"];
    let event;
    try {
      if (typeof signature !== "string" || !signature) throw new Error("sin firma");
      event = verifyStripeEvent(raw, signature, secret);
    } catch {
      log.warn("stripe_webhook_bad_signature", { bytes: raw.length });
      return sendJson(res, 400, { ok: false, error: "Firma de Stripe inválida.", code: "invalid_signature" });
    }

    try {
      const config = readStripeConfig(options.env);
      const result = await processStripeEvent(options.db, event, { prices: config?.prices ?? null, now: options.now });
      log.info("stripe_webhook_event", { eventType: event.type, outcome: result.outcome, businessId: result.businessId });
      return sendJson(res, 200, { ok: true, data: { received: true, outcome: result.outcome } });
    } catch (error) {
      log.error("stripe_webhook_failed", { eventType: event.type, error: error instanceof Error ? error.message : String(error) });
      captureError(error, { webhook: "stripe", eventType: event.type });
      return sendJson(res, 500, { ok: false, error: "Error interno.", code: "internal_error" });
    }
  };
}
