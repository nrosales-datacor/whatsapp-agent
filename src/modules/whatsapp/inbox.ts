import { and, count, countDistinct, desc, eq, gte, inArray, lt, or, sql, type SQL } from "drizzle-orm";
import { rowsOf } from "../../platform/db/rows";
import { isTenantId, withTenant, type Executor } from "../../platform/db/scope";
import { HttpError } from "../../platform/http/errors";
import { readDailyUsage } from "../../platform/observability/dailyUsage";
import { log } from "../../platform/observability/log";
import { getBusinessContext } from "../business";
import { getClient, getClientsByIds, listClients } from "../clients";
import { addDays, countBookingsByChannel, localDate, localDayBounds, mondayOf, nextAppointmentsForClients } from "../scheduling";
import { credentialsOf, getChannelRow, listChannelRows } from "./channels";
import { getConversation, lastInboundAt, saveOutgoingMessage, setConversationMode } from "./conversations";
import { loadTextProfile, type WhatsAppDeps } from "./deps";
import { followUpStats, type FollowUpStats } from "./followUps";
import { quoteStats, type QuoteStats } from "./quotes";
import { windowState } from "./rules";
import { conversations, messages, type Conversation, type ConversationMode, type Message } from "./schema";
import { pipelineText } from "./texts";
import { aiCostMicrosBetween, incrementAiUsage } from "./usage";

// ─────────────────────────────────────────────────────────────────────────────
// Bandeja (API del panel): lista y detalle de conversaciones, respuesta humana, modo,
// estado, leído, reapertura con plantilla, resumen y métricas del agente. El contrato de
// las formas lo consume el panel (web/): no cambiarlo sin cambiar el panel.
//
// Visibilidad por sucursal: una sesión limitada a algunas sucursales ve las conversaciones
// de los números de ESAS sucursales y las de los números que atienden todas (sin
// sucursal). Con X-Location-Id se acota a esa sucursal (más los de todas).
//
// En la base el estado "atendida" se guarda como `resolved`; la API habla de `attended`.
// ─────────────────────────────────────────────────────────────────────────────

export type InboxStatus = "open" | "attended";
export type InboxFilter = InboxStatus | "all";

export interface ConversationItem {
  id: string;
  client: { id: string; name: string; phone: string | null };
  lastMessage: { text: string; at: string; direction: "in" | "out" } | null;
  unread: number;
  mode: ConversationMode;
  status: InboxStatus;
  windowOpen: boolean;
  nextAppointment: { id: string; startsAt: string } | null;
}

export interface MessageItem {
  id: string;
  direction: "in" | "out";
  by: "client" | "bot" | "human";
  text: string;
  mediaUrl?: string;
  mediaType?: "image" | "audio";
  at: string;
}

const PAGE_SIZE = 30;
const MESSAGES_PAGE = 50;

const toApiStatus = (s: string): InboxStatus => (s === "open" ? "open" : "attended");
const toDbStatus = (s: InboxStatus) => (s === "open" ? "open" : "resolved");

const notFound = () => new HttpError(404, "No encontramos esa conversación.", "not_found");

function encodeCursor(at: Date, id: string): string {
  return Buffer.from(`${at.toISOString()}|${id}`, "utf8").toString("base64url");
}

function decodeCursor(cursor: string): { at: Date; id: string } | null {
  const [when, id] = Buffer.from(cursor, "base64url").toString("utf8").split("|");
  const at = new Date(when ?? "");
  return Number.isNaN(at.getTime()) || !isTenantId(id) ? null : { at, id };
}

/** Sucursales que ve el request: null = todas. */
export function visibleLocations(sessionLocations: readonly string[] | "all", requested: string | null): readonly string[] | null {
  if (requested) return [requested];
  return sessionLocations === "all" ? null : sessionLocations;
}

/** Números visibles para esas sucursales (null = todos). Un número sin sucursal atiende todas. */
async function visibleChannelIds(db: Executor, businessId: string, locations: readonly string[] | null): Promise<string[] | null> {
  if (locations === null) return null;
  const rows = await listChannelRows(db, businessId);
  return rows.filter((r) => r.locationId === null || locations.includes(r.locationId)).map((r) => r.id);
}

/** Arma los ítems de la lista para un lote de conversaciones (en su orden). */
async function toItems(db: Executor, businessId: string, rows: Conversation[], now: Date): Promise<ConversationItem[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const { lastMessages, stats } = await withTenant(db, businessId, async (tx) => {
    const lastMessages = await tx
      .selectDistinctOn([messages.conversationId], {
        conversationId: messages.conversationId,
        content: messages.content,
        role: messages.role,
        createdAt: messages.createdAt,
      })
      .from(messages)
      .where(and(eq(messages.businessId, businessId), inArray(messages.conversationId, ids)))
      .orderBy(messages.conversationId, desc(messages.createdAt), desc(messages.id));
    const stats = await tx
      .select({
        conversationId: messages.conversationId,
        unread: sql<number>`count(*) filter (where ${messages.role} = 'user' and (${conversations.readUntil} is null or ${messages.createdAt} > ${conversations.readUntil}))`.mapWith(Number),
        lastInbound: sql<string | Date | null>`max(${messages.createdAt}) filter (where ${messages.role} = 'user')`,
      })
      .from(messages)
      .innerJoin(conversations, eq(conversations.id, messages.conversationId))
      .where(and(eq(messages.businessId, businessId), inArray(messages.conversationId, ids)))
      .groupBy(messages.conversationId);
    return { lastMessages, stats };
  });
  const clients = new Map((await getClientsByIds(db, businessId, rows.map((r) => r.clientId))).map((c) => [c.id, c]));
  const next = await nextAppointmentsForClients(db, businessId, rows.map((r) => r.clientId), { now });
  const lastBy = new Map(lastMessages.map((m) => [m.conversationId, m]));
  const statsBy = new Map(stats.map((s) => [s.conversationId, s]));
  return rows.map((r) => {
    const c = clients.get(r.clientId);
    const last = lastBy.get(r.id);
    const s = statsBy.get(r.id);
    const lastInbound = s?.lastInbound ? new Date(s.lastInbound) : null;
    return {
      id: r.id,
      client: { id: r.clientId, name: c?.name ?? "", phone: c?.phone ?? null },
      lastMessage: last ? { text: last.content, at: last.createdAt.toISOString(), direction: last.role === "user" ? "in" : "out" } : null,
      unread: s?.unread ?? 0,
      mode: r.mode as ConversationMode,
      status: toApiStatus(r.status),
      windowOpen: windowState(lastInbound, now).open,
      nextAppointment: next.get(r.clientId) ?? null,
    };
  });
}

/** Conversación del negocio visible para esas sucursales, o 404. */
async function visibleConversation(db: Executor, businessId: string, conversationId: string, locations: readonly string[] | null): Promise<Conversation> {
  if (!isTenantId(conversationId)) throw notFound();
  const conversation = await getConversation(db, businessId, conversationId);
  if (!conversation) throw notFound();
  const channels = await visibleChannelIds(db, businessId, locations);
  if (channels && !channels.includes(conversation.channelId)) throw notFound();
  return conversation;
}

export interface ListInput {
  status: InboxFilter;
  q?: string;
  cursor?: string;
  limit?: number;
  locations: readonly string[] | null;
  now?: Date;
}

export async function listConversations(db: Executor, businessId: string, input: ListInput): Promise<{ items: ConversationItem[]; nextCursor: string | null }> {
  const now = input.now ?? new Date();
  const limit = Math.min(Math.max(input.limit ?? PAGE_SIZE, 1), 100);
  const conditions: SQL[] = [eq(conversations.businessId, businessId)];
  const channels = await visibleChannelIds(db, businessId, input.locations);
  if (channels) {
    if (channels.length === 0) return { items: [], nextCursor: null };
    conditions.push(inArray(conversations.channelId, channels));
  }
  if (input.status !== "all") conditions.push(eq(conversations.status, toDbStatus(input.status)));
  const q = input.q?.trim();
  if (q) {
    // Búsqueda por nombre o teléfono con el buscador de clientes (los 100 mejores).
    const matches = await listClients(db, businessId, { q, limit: 100 });
    if (matches.items.length === 0) return { items: [], nextCursor: null };
    conditions.push(inArray(conversations.clientId, matches.items.map((c) => c.id)));
  }
  if (input.cursor) {
    const c = decodeCursor(input.cursor);
    if (!c) throw new HttpError(400, "El cursor no es válido.", "invalid_cursor");
    const after = or(lt(conversations.lastActivityAt, c.at), and(eq(conversations.lastActivityAt, c.at), lt(conversations.id, c.id)));
    if (after) conditions.push(after);
  }
  const rows = await withTenant(db, businessId, (tx) =>
    tx
      .select()
      .from(conversations)
      .where(and(...conditions))
      .orderBy(desc(conversations.lastActivityAt), desc(conversations.id))
      .limit(limit + 1),
  );
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    items: await toItems(db, businessId, page, now),
    nextCursor: rows.length > limit && last ? encodeCursor(last.lastActivityAt, last.id) : null,
  };
}

async function toMessageItem(deps: Pick<WhatsAppDeps, "storage">, m: Message): Promise<MessageItem> {
  const item: MessageItem = {
    id: m.id,
    direction: m.role === "user" ? "in" : "out",
    by: m.role === "user" ? "client" : m.byHuman ? "human" : "bot",
    text: m.content,
    at: m.createdAt.toISOString(),
  };
  if (m.mediaType === "image" || m.mediaType === "audio") {
    item.mediaType = m.mediaType;
    const url = m.mediaPath ? await deps.storage.signedUrl(m.mediaPath) : undefined;
    if (url) item.mediaUrl = url;
  }
  return item;
}

export async function getConversationDetail(
  db: Executor,
  deps: Pick<WhatsAppDeps, "storage">,
  businessId: string,
  conversationId: string,
  input: { before?: string; locations: readonly string[] | null; now?: Date },
): Promise<{ conversation: ConversationItem; messages: MessageItem[]; nextBefore: string | null }> {
  const now = input.now ?? new Date();
  const conversation = await visibleConversation(db, businessId, conversationId, input.locations);
  const conditions: SQL[] = [eq(messages.businessId, businessId), eq(messages.conversationId, conversation.id)];
  if (input.before) {
    const c = decodeCursor(input.before);
    if (!c) throw new HttpError(400, "El cursor no es válido.", "invalid_cursor");
    const older = or(lt(messages.createdAt, c.at), and(eq(messages.createdAt, c.at), lt(messages.id, c.id)));
    if (older) conditions.push(older);
  }
  const rows = await withTenant(db, businessId, (tx) =>
    tx
      .select()
      .from(messages)
      .where(and(...conditions))
      .orderBy(desc(messages.createdAt), desc(messages.id))
      .limit(MESSAGES_PAGE + 1),
  );
  const page = rows.slice(0, MESSAGES_PAGE);
  const oldest = page[page.length - 1];
  const [item] = await toItems(db, businessId, [conversation], now);
  return {
    conversation: item,
    messages: await Promise.all(page.reverse().map((m) => toMessageItem(deps, m))),
    nextBefore: rows.length > MESSAGES_PAGE && oldest ? encodeCursor(oldest.createdAt, oldest.id) : null,
  };
}

async function itemOf(db: Executor, businessId: string, conversationId: string, now: Date): Promise<ConversationItem> {
  const conversation = await getConversation(db, businessId, conversationId);
  if (!conversation) throw notFound();
  const [item] = await toItems(db, businessId, [conversation], now);
  return item;
}

/** Contexto para escribirle al cliente desde la bandeja. */
async function outbound(db: Executor, businessId: string, conversation: Conversation) {
  const channel = await getChannelRow(db, businessId, conversation.channelId);
  const credentials = channel ? credentialsOf(channel) : null;
  const client = await getClient(db, businessId, conversation.clientId);
  if (!channel || !credentials || !client?.phone) {
    throw new HttpError(409, "Este número de WhatsApp no está conectado o el cliente no tiene teléfono.", "channel_unavailable");
  }
  return { channel, credentials, phone: client.phone };
}

/** Respuesta de una persona desde la bandeja (texto libre: solo dentro de la ventana de 24 h). */
export async function sendHumanMessage(
  db: Executor,
  deps: Pick<WhatsAppDeps, "api" | "storage" | "now">,
  businessId: string,
  conversationId: string,
  input: { text: string; locations: readonly string[] | null },
): Promise<MessageItem> {
  const now = deps.now();
  const conversation = await visibleConversation(db, businessId, conversationId, input.locations);
  if (!windowState(await lastInboundAt(db, businessId, conversation.id), now).open) {
    throw new HttpError(409, "Pasaron más de 24 h desde el último mensaje del cliente: reabrí la conversación con una plantilla.", "window_closed");
  }
  const { credentials, phone } = await outbound(db, businessId, conversation);
  try {
    await deps.api.sendText(credentials, phone, input.text);
  } catch (e) {
    log.warn("whatsapp_human_send_failed", { businessId, conversationId: conversation.id, error: e instanceof Error ? e.message.slice(0, 200) : String(e) });
    throw new HttpError(502, "No se pudo enviar el mensaje por WhatsApp. Probá de nuevo.", "send_failed");
  }
  // Responder a mano toma la conversación: el bot deja de contestar.
  if (conversation.mode !== "human") await setConversationMode(db, businessId, conversation.id, "human", now);
  const saved = await saveOutgoingMessage(db, businessId, conversation.id, { content: input.text, byHuman: true, at: now });
  await markRead(db, businessId, conversation.id, now);
  await incrementAiUsage(db, businessId, { messagesOut: 1 }, now);
  if (!saved) throw new Error("sendHumanMessage: no se guardó el mensaje");
  return toMessageItem(deps, saved);
}

/** Reabre una conversación fuera de la ventana con la plantilla de reapertura del número. */
export async function reopenConversation(
  db: Executor,
  deps: Pick<WhatsAppDeps, "api" | "now">,
  businessId: string,
  conversationId: string,
  input: { locations: readonly string[] | null },
): Promise<ConversationItem> {
  const now = deps.now();
  const conversation = await visibleConversation(db, businessId, conversationId, input.locations);
  if (windowState(await lastInboundAt(db, businessId, conversation.id), now).open) {
    throw new HttpError(409, "La conversación está dentro de las 24 h: podés escribirle directamente.", "window_open");
  }
  const { channel, credentials, phone } = await outbound(db, businessId, conversation);
  const template = channel.templates?.reopen;
  if (!template) {
    throw new HttpError(409, "Configurá la plantilla de reapertura del número antes de reabrir conversaciones.", "template_missing");
  }
  try {
    await deps.api.sendTemplate(credentials, phone, { name: template.name, language: template.language });
  } catch (e) {
    log.warn("whatsapp_reopen_failed", { businessId, conversationId: conversation.id, error: e instanceof Error ? e.message.slice(0, 200) : String(e) });
    throw new HttpError(502, "No se pudo enviar la plantilla por WhatsApp. Probá de nuevo.", "send_failed");
  }
  const texts = await loadTextProfile(db, businessId);
  await saveOutgoingMessage(db, businessId, conversation.id, { content: pipelineText(texts, "reopenTemplateSent"), byHuman: true, at: now });
  await incrementAiUsage(db, businessId, { messagesOut: 1, utilityTemplates: 1 }, now);
  return itemOf(db, businessId, conversation.id, now);
}

export async function changeMode(
  db: Executor,
  businessId: string,
  conversationId: string,
  input: { mode: ConversationMode; locations: readonly string[] | null; now?: Date },
): Promise<ConversationItem> {
  const now = input.now ?? new Date();
  const conversation = await visibleConversation(db, businessId, conversationId, input.locations);
  if (conversation.mode !== input.mode) await setConversationMode(db, businessId, conversation.id, input.mode, now);
  return itemOf(db, businessId, conversation.id, now);
}

export async function changeStatus(
  db: Executor,
  businessId: string,
  conversationId: string,
  input: { status: InboxStatus; locations: readonly string[] | null; now?: Date },
): Promise<ConversationItem> {
  const now = input.now ?? new Date();
  const conversation = await visibleConversation(db, businessId, conversationId, input.locations);
  await withTenant(db, businessId, (tx) =>
    tx
      .update(conversations)
      .set({ status: toDbStatus(input.status) })
      .where(and(eq(conversations.businessId, businessId), eq(conversations.id, conversation.id))),
  );
  return itemOf(db, businessId, conversation.id, now);
}

async function markRead(db: Executor, businessId: string, conversationId: string, now: Date): Promise<void> {
  await withTenant(db, businessId, (tx) =>
    tx
      .update(conversations)
      .set({ readUntil: now })
      .where(and(eq(conversations.businessId, businessId), eq(conversations.id, conversationId))),
  );
}

export async function markConversationRead(
  db: Executor,
  businessId: string,
  conversationId: string,
  input: { locations: readonly string[] | null; now?: Date },
): Promise<ConversationItem> {
  const now = input.now ?? new Date();
  const conversation = await visibleConversation(db, businessId, conversationId, input.locations);
  await markRead(db, businessId, conversation.id, now);
  return itemOf(db, businessId, conversation.id, now);
}

// ── Resumen y métricas ───────────────────────────────────────────────────────

/** Condición "conversación de un número visible" (null = todas). */
function channelScope(channels: string[] | null): SQL | undefined {
  return channels ? inArray(conversations.channelId, channels) : undefined;
}

/** Conversaciones esperando a una persona: abiertas y en modo humano. (Inicio y resumen.) */
export async function countConversationsWaiting(db: Executor, businessId: string, locations: readonly string[] | null): Promise<number> {
  const channels = await visibleChannelIds(db, businessId, locations);
  if (channels && channels.length === 0) return 0;
  const [row] = await withTenant(db, businessId, (tx) =>
    tx
      .select({ n: count() })
      .from(conversations)
      .where(and(eq(conversations.businessId, businessId), eq(conversations.status, "open"), eq(conversations.mode, "human"), channelScope(channels))),
  );
  return Number(row?.n ?? 0);
}

async function timeZoneFor(db: Executor, businessId: string, locationId: string | null): Promise<string> {
  const ctx = await getBusinessContext(db, businessId);
  if (!ctx) throw new HttpError(404, "Negocio no encontrado.", "not_found");
  return (locationId ? ctx.locations.find((l) => l.id === locationId)?.timezone : null) ?? ctx.business.timezone;
}

/** Conversaciones distintas con mensajes del cliente en [from, to), por número visible. */
async function conversationsWithInbound(db: Executor, businessId: string, channels: string[] | null, from: Date, to: Date): Promise<number> {
  const [row] = await withTenant(db, businessId, (tx) =>
    tx
      .select({ n: countDistinct(messages.conversationId) })
      .from(messages)
      .innerJoin(conversations, eq(conversations.id, messages.conversationId))
      .where(and(eq(messages.businessId, businessId), eq(messages.role, "user"), gte(messages.createdAt, from), lt(messages.createdAt, to), channelScope(channels))),
  );
  return Number(row?.n ?? 0);
}

async function sumHandoffs(db: Executor, businessId: string, fromDate: string, toDate: string): Promise<number> {
  return (await readDailyUsage(db, businessId, { metric: "whatsapp_handoffs", from: fromDate, to: toDate })).reduce((n, r) => n + r.value, 0);
}

export interface InboxSummary {
  conversationsWaiting: number;
  openConversations: number;
  conversationsThisWeek: number;
  bookingsByAgentThisWeek: number;
  handoffsThisWeek: number;
}

export async function inboxSummary(
  db: Executor,
  businessId: string,
  input: { locations: readonly string[] | null; locationId: string | null; now?: Date },
): Promise<InboxSummary> {
  const now = input.now ?? new Date();
  const tz = await timeZoneFor(db, businessId, input.locationId);
  const today = localDate(now, tz);
  const monday = mondayOf(today);
  const weekStart = localDayBounds(monday, tz).start;
  const channels = await visibleChannelIds(db, businessId, input.locations);
  const none = channels !== null && channels.length === 0;
  const [open] = none
    ? [{ n: 0 }]
    : await withTenant(db, businessId, (tx) =>
        tx
          .select({ n: count() })
          .from(conversations)
          .where(and(eq(conversations.businessId, businessId), eq(conversations.status, "open"), channelScope(channels))),
      );
  const bookings = await countBookingsByChannel(db, businessId, {
    channel: "whatsapp_ai",
    from: weekStart,
    to: new Date(now.getTime() + 1),
    timeZone: tz,
    locationIds: input.locations,
  });
  return {
    conversationsWaiting: none ? 0 : await countConversationsWaiting(db, businessId, input.locations),
    openConversations: Number(open?.n ?? 0),
    conversationsThisWeek: none ? 0 : await conversationsWithInbound(db, businessId, channels, weekStart, new Date(now.getTime() + 1)),
    bookingsByAgentThisWeek: bookings.total,
    handoffsThisWeek: await sumHandoffs(db, businessId, monday, today),
  };
}

export interface AgentMetrics {
  conversations: number;
  resolvedWithoutHuman: number;
  bookingsByAgent: number;
  handoffs: number;
  aiCostMicros: number;
  byDay: { date: string; conversations: number; bookings: number }[];
  /** Crecimiento (I6) en el rango, de todo el negocio: seguimientos y reseñas, y rescate de cotizaciones. */
  growth: { followUps: FollowUpStats; quotes: QuoteStats };
}

/** Rango máximo de las métricas (días). */
export const MAX_METRICS_DAYS = 366;

export async function agentMetrics(
  db: Executor,
  businessId: string,
  input: { from?: string; to?: string; locations: readonly string[] | null; locationId: string | null; now?: Date },
): Promise<AgentMetrics> {
  const now = input.now ?? new Date();
  const tz = await timeZoneFor(db, businessId, input.locationId);
  const toDate = input.to ?? localDate(now, tz);
  const fromDate = input.from ?? addDays(toDate, -29);
  if (fromDate > toDate) throw new HttpError(400, "La fecha de inicio es posterior a la de fin.", "invalid_range");
  const start = localDayBounds(fromDate, tz).start;
  const end = localDayBounds(toDate, tz).end;
  if (end.getTime() - start.getTime() > MAX_METRICS_DAYS * 86_400_000 + 2 * 3_600_000) {
    throw new HttpError(400, `El rango máximo es de ${MAX_METRICS_DAYS} días.`, "invalid_range");
  }
  const channels = await visibleChannelIds(db, businessId, input.locations);
  const none = channels !== null && channels.length === 0;

  let conversationsTotal = 0;
  let resolvedWithoutHuman = 0;
  let convByDay = new Map<string, number>();
  if (!none) {
    conversationsTotal = await conversationsWithInbound(db, businessId, channels, start, end);
    const scope = channels ? sql`AND c.channel_id IN (${sql.join(channels.map((id) => sql`${id}::uuid`), sql`, `)})` : sql``;
    const resolved = rowsOf<{ n: number | string }>(
      await withTenant(db, businessId, (tx) =>
        tx.execute(sql`
          SELECT count(*) AS n
            FROM conversations c
           WHERE c.business_id = ${businessId}::uuid ${scope}
             AND EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = c.id AND m.role = 'user'
                          AND m.created_at >= ${start.toISOString()}::timestamptz AND m.created_at < ${end.toISOString()}::timestamptz)
             AND NOT EXISTS (SELECT 1 FROM messages h WHERE h.conversation_id = c.id AND h.by_human
                          AND h.created_at >= ${start.toISOString()}::timestamptz AND h.created_at < ${end.toISOString()}::timestamptz)
             AND NOT (c.human_since IS NOT NULL AND c.human_since >= ${start.toISOString()}::timestamptz AND c.human_since < ${end.toISOString()}::timestamptz)
        `),
      ),
    );
    resolvedWithoutHuman = Number(resolved[0]?.n ?? 0);
    const perDay = rowsOf<{ day: string; n: number | string }>(
      await withTenant(db, businessId, (tx) =>
        tx.execute(sql`
          SELECT to_char(m.created_at AT TIME ZONE ${tz}, 'YYYY-MM-DD') AS day, count(DISTINCT m.conversation_id) AS n
            FROM messages m
            JOIN conversations c ON c.id = m.conversation_id
           WHERE m.business_id = ${businessId}::uuid ${scope} AND m.role = 'user'
             AND m.created_at >= ${start.toISOString()}::timestamptz AND m.created_at < ${end.toISOString()}::timestamptz
           GROUP BY 1
        `),
      ),
    );
    convByDay = new Map(perDay.map((r) => [r.day, Number(r.n)]));
  }
  const bookings = await countBookingsByChannel(db, businessId, { channel: "whatsapp_ai", from: start, to: end, timeZone: tz, locationIds: input.locations });
  const bookingsByDay = new Map(bookings.byDay.map((b) => [b.date, b.count]));
  const byDay: AgentMetrics["byDay"] = [];
  for (let d = fromDate; d <= toDate; d = addDays(d, 1)) {
    byDay.push({ date: d, conversations: convByDay.get(d) ?? 0, bookings: bookingsByDay.get(d) ?? 0 });
  }
  return {
    conversations: conversationsTotal,
    resolvedWithoutHuman,
    bookingsByAgent: bookings.total,
    handoffs: await sumHandoffs(db, businessId, fromDate, toDate),
    aiCostMicros: await aiCostMicrosBetween(db, businessId, start, new Date(end.getTime() - 1)),
    byDay,
    growth: {
      followUps: await followUpStats(db, businessId, { from: start, to: end }),
      quotes: await quoteStats(db, businessId, { from: start, to: end }),
    },
  };
}
