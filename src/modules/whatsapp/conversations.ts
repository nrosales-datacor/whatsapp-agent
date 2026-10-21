import { and, desc, eq, gt, isNull, lte, max, or, sql } from "drizzle-orm";
import { withTenant, type Executor } from "../../platform/db/scope";
import { conversations, messages, type Conversation, type ConversationMode, type Message } from "./schema";

// ─────────────────────────────────────────────────────────────────────────────
// Acceso a conversaciones y mensajes que comparten el pipeline y la bandeja. Todo con el
// contexto del negocio (`withTenant`): un negocio no ve ni toca conversaciones de otro.
// ─────────────────────────────────────────────────────────────────────────────

export async function getConversation(db: Executor, businessId: string, conversationId: string): Promise<Conversation | null> {
  const [row] = await withTenant(db, businessId, (tx) =>
    tx
      .select()
      .from(conversations)
      .where(and(eq(conversations.businessId, businessId), eq(conversations.id, conversationId)))
      .limit(1),
  );
  return row ?? null;
}

export async function getMessage(db: Executor, businessId: string, messageId: string): Promise<Message | null> {
  const [row] = await withTenant(db, businessId, (tx) =>
    tx
      .select()
      .from(messages)
      .where(and(eq(messages.businessId, businessId), eq(messages.id, messageId)))
      .limit(1),
  );
  return row ?? null;
}

/** Cambia el modo. `human` fija `human_since` (lo usa el vencimiento); `bot` lo limpia. */
export async function setConversationMode(db: Executor, businessId: string, conversationId: string, mode: ConversationMode, now: Date = new Date()): Promise<void> {
  await withTenant(db, businessId, (tx) =>
    tx
      .update(conversations)
      .set({ mode, humanSince: mode === "human" ? now : null })
      .where(and(eq(conversations.businessId, businessId), eq(conversations.id, conversationId))),
  );
}

/** Modo actual (lectura liviana: se revalida después del LLM). null si la conversación ya no existe. */
export async function currentMode(db: Executor, businessId: string, conversationId: string): Promise<ConversationMode | null> {
  const [row] = await withTenant(db, businessId, (tx) =>
    tx
      .select({ mode: conversations.mode })
      .from(conversations)
      .where(and(eq(conversations.businessId, businessId), eq(conversations.id, conversationId)))
      .limit(1),
  );
  return (row?.mode as ConversationMode | undefined) ?? null;
}

export interface OutgoingMessage {
  content: string;
  byHuman?: boolean;
  /** id sintético único (p. ej. el aviso de límite): si ya existe no se guarda y devuelve null. */
  waMessageId?: string;
  at?: Date;
}

/** Guarda un mensaje saliente (del agente o de una persona). null si el id sintético ya existía. */
export async function saveOutgoingMessage(db: Executor, businessId: string, conversationId: string, message: OutgoingMessage): Promise<Message | null> {
  const at = message.at ?? new Date();
  const rows = await withTenant(db, businessId, (tx) =>
    tx
      .insert(messages)
      .values({
        businessId,
        conversationId,
        role: "assistant",
        content: message.content,
        byHuman: message.byHuman ?? false,
        waMessageId: message.waMessageId ?? null,
        createdAt: at,
        updatedAt: at,
      })
      .onConflictDoNothing({ target: messages.waMessageId })
      .returning(),
  );
  return rows[0] ?? null;
}

/** Último mensaje del CLIENTE (base de la ventana de 24 h). */
export async function lastInboundAt(db: Executor, businessId: string, conversationId: string): Promise<Date | null> {
  const [row] = await withTenant(db, businessId, (tx) =>
    tx
      .select({ at: max(messages.createdAt) })
      .from(messages)
      .where(and(eq(messages.businessId, businessId), eq(messages.conversationId, conversationId), eq(messages.role, "user"))),
  );
  return row?.at ? new Date(row.at) : null;
}

/** Último mensaje escrito por una persona desde la bandeja (vencimiento del modo humano). */
export async function lastHumanReplyAt(db: Executor, businessId: string, conversationId: string): Promise<Date | null> {
  const [row] = await withTenant(db, businessId, (tx) =>
    tx
      .select({ at: max(messages.createdAt) })
      .from(messages)
      .where(and(eq(messages.businessId, businessId), eq(messages.conversationId, conversationId), eq(messages.byHuman, true))),
  );
  return row?.at ? new Date(row.at) : null;
}

/**
 * Historial para el agente: los últimos `limit` mensajes hasta el actual INCLUSIVE (por
 * fecha y, a igual fecha, por id), del más viejo al más nuevo, sin los más viejos que
 * `maxAgeDays`. Los mensajes posteriores al actual no entran (los responde su propio turno).
 */
export async function historyUpTo(
  db: Executor,
  businessId: string,
  current: Pick<Message, "id" | "conversationId" | "createdAt">,
  options: { limit: number; maxAgeDays: number },
): Promise<Message[]> {
  const since = new Date(current.createdAt.getTime() - options.maxAgeDays * 86_400_000);
  const rows = await withTenant(db, businessId, (tx) =>
    tx
      .select()
      .from(messages)
      .where(
        and(
          eq(messages.businessId, businessId),
          eq(messages.conversationId, current.conversationId),
          gt(messages.createdAt, since),
          or(lte(messages.createdAt, current.createdAt), eq(messages.id, current.id)),
        ),
      )
      .orderBy(desc(messages.createdAt), desc(messages.id))
      .limit(options.limit),
  );
  return rows.reverse();
}

/** Marca que ya se le avisó al cliente que lo atiende un bot. */
export async function markBotNoticeSent(db: Executor, businessId: string, conversationId: string, at: Date): Promise<void> {
  await withTenant(db, businessId, (tx) =>
    tx
      .update(conversations)
      .set({ botNoticeSentAt: at })
      .where(and(eq(conversations.businessId, businessId), eq(conversations.id, conversationId), isNull(conversations.botNoticeSentAt))),
  );
}

/** Actualiza contenido y adjunto de un mensaje (transcripción, ruta en Storage). */
export async function updateMessage(
  db: Executor,
  businessId: string,
  messageId: string,
  changes: { content?: string; mediaPath?: string | null },
): Promise<void> {
  if (changes.content === undefined && changes.mediaPath === undefined) return;
  await withTenant(db, businessId, (tx) =>
    tx
      .update(messages)
      .set({ ...(changes.content !== undefined ? { content: changes.content } : {}), ...(changes.mediaPath !== undefined ? { mediaPath: changes.mediaPath } : {}) })
      .where(and(eq(messages.businessId, businessId), eq(messages.id, messageId))),
  );
}

/** Mensajes del cliente de una ventana reciente (detección de bucles), más nuevos primero. */
export async function recentInbound(db: Executor, businessId: string, conversationId: string, since: Date): Promise<{ content: string }[]> {
  return withTenant(db, businessId, (tx) =>
    tx
      .select({ content: messages.content })
      .from(messages)
      .where(and(eq(messages.businessId, businessId), eq(messages.conversationId, conversationId), eq(messages.role, "user"), gt(messages.createdAt, since)))
      .orderBy(desc(messages.createdAt))
      .limit(100),
  );
}

/** Respuestas del bot en la ventana (sin las de una persona ni los avisos sintéticos) y si ya hubo aviso de límite. */
export async function botActivitySince(
  db: Executor,
  businessId: string,
  conversationId: string,
  since: Date,
  noticePrefix: string,
): Promise<{ botTurns: number; noticeSent: boolean }> {
  const [row] = await withTenant(db, businessId, (tx) =>
    tx
      .select({
        turns: sql<number>`count(*) filter (where ${messages.role} = 'assistant' and ${messages.byHuman} = false and ${messages.waMessageId} is null)`.mapWith(Number),
        notices: sql<number>`count(*) filter (where ${messages.waMessageId} like ${`${noticePrefix}%`})`.mapWith(Number),
      })
      .from(messages)
      .where(and(eq(messages.businessId, businessId), eq(messages.conversationId, conversationId), gt(messages.createdAt, since))),
  );
  return { botTurns: row?.turns ?? 0, noticeSent: (row?.notices ?? 0) > 0 };
}

/** Conversaciones del canal y cliente (o null): recordatorios y reapertura. */
export async function findConversation(db: Executor, businessId: string, channelId: string, clientId: string): Promise<Conversation | null> {
  const [row] = await withTenant(db, businessId, (tx) =>
    tx
      .select()
      .from(conversations)
      .where(and(eq(conversations.businessId, businessId), eq(conversations.channelId, channelId), eq(conversations.clientId, clientId)))
      .limit(1),
  );
  return row ?? null;
}

/** La conversación del canal y cliente, creándola si no existe (recordatorio a alguien que nunca escribió). */
export async function ensureConversation(db: Executor, businessId: string, channelId: string, clientId: string): Promise<Conversation> {
  return withTenant(db, businessId, async (tx) => {
    const inserted = await tx
      .insert(conversations)
      .values({ businessId, channelId, clientId })
      .onConflictDoNothing({ target: [conversations.channelId, conversations.clientId] })
      .returning();
    if (inserted[0]) return inserted[0];
    const [row] = await tx
      .select()
      .from(conversations)
      .where(and(eq(conversations.businessId, businessId), eq(conversations.channelId, channelId), eq(conversations.clientId, clientId)))
      .limit(1);
    return row;
  });
}
