import { createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Executor } from "../../platform/db/scope";
import { readBodyWithLimit, type HttpHandler } from "../../platform/net/http";
import { msFromEnv } from "../../platform/net/timeouts";
import { log } from "../../platform/observability/log";
import { captureError } from "../../platform/observability/sentry";
import { resolveChannelByPhoneNumberId } from "./channels";
import { ingestInboundMessage } from "./ingest";
import { classifyWebhookPayload, payloadIds, splitWebhookPayload } from "./payload";
import { reprocessRawWebhooks, saveRawWebhook, type ReprocessAttempt, type ReprocessResult } from "./rawWebhooks";

// ─────────────────────────────────────────────────────────────────────────────
// Webhook de WhatsApp (`GET|POST /webhook/whatsapp`, fuera de /api/panel: lo llama Meta,
// no el panel). Portado de la fase 1 de legacy/src/handleWebhook.ts.
//
//   GET  → verificación de la suscripción (hub.mode=subscribe + WHATSAPP_VERIFY_TOKEN).
//   POST → 1) tope del cuerpo (413); 2) firma `X-Hub-Signature-256` = HMAC-SHA256 del
//          cuerpo CRUDO con WHATSAPP_APP_SECRET, en tiempo constante (401 si falta o no
//          coincide: sin secreto configurado no se acepta nada); 3) se parte en mensajes,
//          cada uno se rutea por `phone_number_id` → canal → negocio y se ingesta
//          (./ingest.ts); lo que no rutea o no se sabe leer va a `raw_webhooks`; los
//          estados (entregado/leído) se ignoran. 4) 200 recién con todo persistido: si la
//          base falla se responde 500 y Meta reintenta (la ingesta es idempotente).
// ─────────────────────────────────────────────────────────────────────────────

export const WHATSAPP_WEBHOOK_PATH = "/webhook/whatsapp";
const MAX_BODY_BYTES = msFromEnv("WHATSAPP_WEBHOOK_MAX_BODY_BYTES", 1024 * 1024);

/** ¿La firma de Meta corresponde al cuerpo crudo? */
export function isValidSignature(rawBody: Buffer, header: string | string[] | undefined, secret: string | undefined): boolean {
  if (!secret || typeof header !== "string") return false;
  const expected = Buffer.from(`sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`);
  const given = Buffer.from(header.trim());
  return expected.length === given.length && timingSafeEqual(expected, given);
}

/** Verificación de la suscripción: el challenge si el token coincide, null si no. */
export function verifySubscription(params: URLSearchParams, verifyToken: string | undefined): string | null {
  if (!verifyToken) return null;
  if (params.get("hub.mode") !== "subscribe") return null;
  const given = Buffer.from(params.get("hub.verify_token") ?? "");
  const expected = Buffer.from(verifyToken);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  return params.get("hub.challenge") ?? "";
}

export type PartOutcome = "queued" | "duplicate" | "stored" | "ignored" | "unknown_channel" | "unparseable";

/**
 * Procesa UN pedazo (un mensaje) del webhook. Con `saveRaw`, lo que no se pudo ingestar
 * queda en `raw_webhooks`; sin él (el reproceso) solo informa el resultado.
 */
export async function processWebhookPart(db: Executor, part: unknown, options: { saveRaw: boolean; now?: Date }): Promise<PartOutcome> {
  const classified = classifyWebhookPayload(part);
  if (classified.type === "ignorable") return "ignored";
  const ids = payloadIds(part);
  if (classified.type === "unparseable") {
    if (options.saveRaw) await saveRawWebhook(db, { payload: part, ...ids, reason: "unparseable" });
    return "unparseable";
  }
  const channel = await resolveChannelByPhoneNumberId(db, classified.message.phoneNumberId);
  if (!channel) {
    if (options.saveRaw) await saveRawWebhook(db, { payload: part, ...ids, reason: "unknown_channel" });
    return "unknown_channel";
  }
  const outcome = await ingestInboundMessage(db, channel, classified.message, { now: options.now });
  if (outcome === "invalid") {
    if (options.saveRaw) await saveRawWebhook(db, { payload: part, ...ids, reason: "unparseable" });
    return "unparseable";
  }
  return outcome;
}

/** Procesa un POST completo de Meta (ya verificado). */
export async function processWebhookBody(db: Executor, body: unknown, options: { now?: Date } = {}): Promise<PartOutcome[]> {
  const outcomes: PartOutcome[] = [];
  for (const part of splitWebhookPayload(body)) outcomes.push(await processWebhookPart(db, part, { saveRaw: true, now: options.now }));
  return outcomes;
}

/** Reinyección de un crudo guardado por el mismo camino (lo usa el reproceso). */
export function reingestRawPayload(db: Executor): (payload: unknown) => Promise<ReprocessAttempt> {
  return async (payload) => {
    const outcome = await processWebhookPart(db, payload, { saveRaw: false });
    return outcome === "queued" || outcome === "duplicate" || outcome === "stored" ? "ingested" : "unresolved";
  };
}

/** Reprocesa lo que llegó para un número antes de que estuviera conectado. */
export function reprocessForPhoneNumber(db: Executor, phoneNumberId: string): Promise<ReprocessResult> {
  return reprocessRawWebhooks(db, reingestRawPayload(db), { phoneNumberId });
}

function sendText(res: ServerResponse, status: number, text: string): void {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
  res.end(text);
}

export interface WebhookHandlerOptions {
  db: Executor;
  /** Default: WHATSAPP_APP_SECRET / WHATSAPP_VERIFY_TOKEN (se leen en cada request). */
  appSecret?: () => string | undefined;
  verifyToken?: () => string | undefined;
}

/** Handler HTTP de `/webhook/whatsapp` (lo monta src/app.ts). */
export function createWhatsAppWebhookHandler(options: WebhookHandlerOptions): HttpHandler {
  const appSecret = options.appSecret ?? (() => process.env.WHATSAPP_APP_SECRET?.trim() || undefined);
  const verifyToken = options.verifyToken ?? (() => process.env.WHATSAPP_VERIFY_TOKEN?.trim() || undefined);

  return async (req: IncomingMessage, res: ServerResponse) => {
    const method = (req.method ?? "GET").toUpperCase();
    const url = new URL(req.url ?? "/", "http://localhost");

    if (method === "GET") {
      const challenge = verifySubscription(url.searchParams, verifyToken());
      if (challenge === null) return sendText(res, 403, "Forbidden");
      return sendText(res, 200, challenge);
    }
    if (method !== "POST") {
      res.setHeader("allow", "GET, POST");
      return sendText(res, 405, "Method Not Allowed");
    }

    const raw = await readBodyWithLimit(req, MAX_BODY_BYTES);
    if (raw === null) {
      res.setHeader("connection", "close");
      return sendText(res, 413, "Payload Too Large");
    }
    if (!isValidSignature(raw, req.headers["x-hub-signature-256"], appSecret())) {
      log.warn("whatsapp_webhook_bad_signature", { bytes: raw.length });
      return sendText(res, 401, "Unauthorized");
    }

    let body: unknown;
    try {
      body = JSON.parse(raw.toString("utf8"));
    } catch {
      // Firmado por Meta pero no es JSON: se guarda tal cual para diagnóstico.
      body = { unparsedBody: raw.toString("utf8").slice(0, 100_000) };
    }

    try {
      const outcomes = await processWebhookBody(options.db, body);
      if (outcomes.some((o) => o !== "ignored")) log.info("whatsapp_webhook", { parts: outcomes.length, outcomes });
      sendText(res, 200, "OK");
    } catch (e) {
      // Sin persistir no se confirma: Meta reintenta y la ingesta es idempotente.
      log.error("whatsapp_webhook_failed", { error: e instanceof Error ? e.message : String(e) });
      captureError(e, { route: "whatsapp_webhook" });
      sendText(res, 500, "Error");
    }
  };
}
