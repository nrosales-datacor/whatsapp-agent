import { randomUUID } from "node:crypto";
import { and, eq, lt, max } from "drizzle-orm";
import { withTenant, type Executor } from "../../platform/db/scope";
import { ValidationError } from "../../platform/http/errors";
import { incrementDailyUsage, USAGE_METRICS } from "../../platform/observability/dailyUsage";
import { log } from "../../platform/observability/log";
import { recordEvent } from "../../platform/observability/metrics";
import { enqueue } from "../../platform/queue";
import { getBusinessContext } from "../business";
import { findOrCreateClientByPhone } from "../clients";
import { localDate } from "../scheduling";
import type { RoutedChannel } from "./channels";
import { directActionOf, type DirectAction } from "./commands";
import { allowIngest, INGEST_DEFER_MS } from "./limits";
import { storedContent, type InboundKind, type InboundMessage } from "./payload";
import { WINDOW_MS } from "./rules";
import { conversations, messages } from "./schema";
import { incrementAiUsage } from "./usage";

// ─────────────────────────────────────────────────────────────────────────────
// Ingesta de un mensaje entrante (fase 1, ANTES del 200 a Meta): cliente, conversación,
// mensaje guardado y job `whatsapp.inbound` encolado en la MISMA transacción (outbox).
//
//   • Idempotente: el `wa_message_id` es único; un reintento de Meta no duplica el mensaje
//     ni el job (además el job lleva `dedupeKey`).
//   • Un job por mensaje, con `groupKey` = la conversación: la cola los corre de a uno y en
//     orden. Las marcas `groupable` / `rereadsHistory` alimentan las ráfagas (ver
//     ./pipeline.ts): un texto común cede ante un turno más nuevo que relee el historial;
//     la BAJA, "Confirmo", pedir una persona, fotos y audios se procesan siempre.
//   • Freno de ingesta por negocio: al pasarse, el job sale diferido unos segundos.
//   • Negocio pausado (falta de pago): el mensaje se guarda para que el equipo lo vea al
//     reactivarse, pero no se encola nada (nadie le responde).
//   • Uso del mes: mensajes entrantes y "conversación iniciada" (primer mensaje del
//     cliente tras 24 h de silencio, como cobra Meta); la conversación iniciada también va
//     a `daily_usage` (`ai_conversations`, por día local) para el superadmin.
// ─────────────────────────────────────────────────────────────────────────────

export const WHATSAPP_INBOUND_JOB = "whatsapp.inbound";

/** Payload del job: ids y marcas, nunca el contenido (el handler lo relee). */
export interface InboundJobPayload {
  messageId: string;
  conversationId: string;
  waMessageId: string;
  kind: InboundKind;
  action: DirectAction | null;
  mediaId?: string;
  mimeType?: string;
  interactiveId?: string;
  buttonText?: string;
  /** Un texto común: puede ceder ante un turno más nuevo de la misma conversación. */
  groupable: boolean;
  /** Un turno del agente (texto, foto o audio): relee el historial y absorbe textos anteriores. */
  rereadsHistory: boolean;
  /** Para seguir el recorrido de este mensaje en los logs. */
  correlationId: string;
}

export type IngestOutcome = "queued" | "duplicate" | "stored" | "invalid";

const mediaTypeOf = (kind: InboundKind): "image" | "audio" | "document" | null =>
  kind === "image" || kind === "audio" || kind === "document" ? kind : null;

export async function ingestInboundMessage(
  db: Executor,
  channel: RoutedChannel,
  message: InboundMessage,
  options: { now?: Date } = {},
): Promise<IngestOutcome> {
  const now = options.now ?? new Date();
  const { businessId } = channel;
  const ctx = await getBusinessContext(db, businessId);
  if (!ctx) return "invalid";

  let clientId: string;
  try {
    const { client } = await findOrCreateClientByPhone(db, businessId, {
      phone: `+${message.from}`,
      name: message.profileName,
      source: "WhatsApp",
    });
    clientId = client.id;
  } catch (e) {
    if (e instanceof ValidationError) return "invalid";
    throw e;
  }

  const action = directActionOf(message);
  const agentTurn = action === null && (message.kind === "text" || message.kind === "image" || message.kind === "audio");
  const correlationId = randomUUID();
  const businessActive = ctx.business.status === "active";

  const result = await withTenant(db, businessId, async (tx) => {
    const inserted = await tx
      .insert(conversations)
      .values({ businessId, clientId, channelId: channel.id })
      .onConflictDoNothing({ target: [conversations.channelId, conversations.clientId] })
      .returning({ id: conversations.id, status: conversations.status });
    const [conversation] = inserted.length
      ? inserted
      : await tx
          .select({ id: conversations.id, status: conversations.status })
          .from(conversations)
          .where(and(eq(conversations.channelId, channel.id), eq(conversations.clientId, clientId)))
          .limit(1);

    const [previous] = await tx
      .select({ at: max(messages.createdAt) })
      .from(messages)
      .where(and(eq(messages.conversationId, conversation.id), eq(messages.role, "user"), lt(messages.createdAt, now)));

    const [saved] = await tx
      .insert(messages)
      .values({
        businessId,
        conversationId: conversation.id,
        role: "user",
        content: storedContent(message),
        waMessageId: message.waMessageId,
        mediaType: mediaTypeOf(message.kind),
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing({ target: messages.waMessageId })
      .returning({ id: messages.id });
    if (!saved) return { outcome: "duplicate" as const, conversationId: conversation.id };

    // El cliente escribió: la conversación vuelve a la cola del operador.
    if (conversation.status !== "open") {
      await tx.update(conversations).set({ status: "open" }).where(eq(conversations.id, conversation.id));
    }

    const lastInbound = previous?.at ? new Date(previous.at) : null;
    const started = !lastInbound || now.getTime() - lastInbound.getTime() > WINDOW_MS;
    if (!businessActive) return { outcome: "stored" as const, conversationId: conversation.id };

    await incrementAiUsage(tx, businessId, { messagesIn: 1, conversationsStarted: started ? 1 : 0 }, now);
    // Por día local del negocio (métricas de producto del superadmin, I5): atómico con el mensaje.
    if (started) {
      await incrementDailyUsage(tx, businessId, { date: localDate(now, ctx.business.timezone), metric: USAGE_METRICS.aiConversations });
    }
    const deferred = !allowIngest(businessId, now.getTime());
    await enqueue<InboundJobPayload>(tx, {
      type: WHATSAPP_INBOUND_JOB,
      businessId,
      groupKey: conversation.id,
      dedupeKey: `wa-in:${message.waMessageId}`,
      ...(deferred ? { runAfter: new Date(now.getTime() + INGEST_DEFER_MS) } : {}),
      payload: {
        messageId: saved.id,
        conversationId: conversation.id,
        waMessageId: message.waMessageId,
        kind: message.kind,
        action,
        ...(message.mediaId ? { mediaId: message.mediaId } : {}),
        ...(message.mimeType ? { mimeType: message.mimeType } : {}),
        ...(message.interactiveId ? { interactiveId: message.interactiveId } : {}),
        ...(message.buttonText ? { buttonText: message.buttonText } : {}),
        groupable: agentTurn && message.kind === "text",
        rereadsHistory: agentTurn,
        correlationId,
      },
    });
    if (deferred) log.warn("whatsapp_ingest_rate_limited", { businessId, deferMs: INGEST_DEFER_MS });
    return { outcome: "queued" as const, conversationId: conversation.id };
  });

  if (result.outcome !== "duplicate") recordEvent(businessId);
  log.info("whatsapp_inbound_ingested", {
    businessId,
    conversationId: result.conversationId,
    kind: message.kind,
    outcome: result.outcome,
    correlationId,
  });
  return result.outcome;
}
