import { sql } from "drizzle-orm";
import { bigint, boolean, check, date, index, integer, jsonb, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { instant, oneOf, timestamps, uuidPk } from "../../platform/db/columns";
import { systemOnlyPolicy, tenantPolicy } from "../../platform/db/rls";
import { businesses, locations } from "../business/schema";
import { services } from "../catalog/schema";
import { clients } from "../clients/schema";
import { appointments } from "../scheduling/schema";

// ─────────────────────────────────────────────────────────────────────────────
// Módulo whatsapp: canales (números conectados), configuración del agente IA,
// conversaciones y mensajes, rescate de cotizaciones, seguimiento post-servicio, uso
// mensual de IA y la red de ingesta cruda del webhook (PLAN-GESTION.md §4). Es lo del
// esquema viejo (`wa_*`), en inglés, colgado del cliente (`client_id`) y del canal
// (`channel_id`) en vez de un teléfono suelto.
//
// El núcleo no importa nada de acá (test/architecture/moduleBoundaries.test.ts): este
// módulo depende del núcleo, nunca al revés.
// ─────────────────────────────────────────────────────────────────────────────

export const CHANNEL_STATUSES = ["pending", "active", "disconnected"] as const;
export type ChannelStatus = (typeof CHANNEL_STATUSES)[number];

export const AI_REGISTERS = ["vos", "tu", "usted"] as const;
export type AiRegister = (typeof AI_REGISTERS)[number];

/** `bot`: responde el agente. `human`: una persona tomó el control desde la bandeja. */
export const CONVERSATION_MODES = ["bot", "human"] as const;
export type ConversationMode = (typeof CONVERSATION_MODES)[number];

/** Cola del operador: `open` necesita atención; vuelve a `open` sola cuando el cliente escribe. */
export const CONVERSATION_STATUSES = ["open", "resolved"] as const;
export type ConversationStatus = (typeof CONVERSATION_STATUSES)[number];

export const MESSAGE_ROLES = ["user", "assistant"] as const;
export type MessageRole = (typeof MESSAGE_ROLES)[number];

export const MESSAGE_MEDIA_TYPES = ["image", "audio", "document"] as const;
export type MessageMediaType = (typeof MESSAGE_MEDIA_TYPES)[number];

export const QUOTE_STATUSES = [
  "pending",
  "first_touch",
  "second_touch",
  "booked",
  "recovered",
  "discarded",
  "opted_out",
] as const;
export type QuoteStatus = (typeof QUOTE_STATUSES)[number];

export const FOLLOW_UP_SENTIMENTS = ["positive", "neutral", "negative"] as const;
export type FollowUpSentiment = (typeof FOLLOW_UP_SENTIMENTS)[number];

export const RAW_WEBHOOK_STATUSES = ["pending", "processed", "discarded"] as const;
export type RawWebhookStatus = (typeof RAW_WEBHOOK_STATUSES)[number];

/** `unknown_channel`: el phone_number_id no resolvió a ningún canal. `unparseable`: forma desconocida. */
export const RAW_WEBHOOK_REASONS = ["unknown_channel", "unparseable"] as const;
export type RawWebhookReason = (typeof RAW_WEBHOOK_REASONS)[number];

/** Plantilla aprobada en Meta para ESTE número (las plantillas se aprueban por WABA). */
export interface ChannelTemplate {
  name: string;
  /** Idioma con el que se aprobó ("es", "es_MX", "en_US"…). */
  language: string;
}

export interface ChannelTemplates {
  reminder?: ChannelTemplate;
  marketing?: ChannelTemplate;
  /** Utilidad, para reabrir una conversación fuera de la ventana de 24 h. */
  reopen?: ChannelTemplate;
  quoteRecovery?: ChannelTemplate;
}

/** Sección de conocimiento nombrada por el dueño ("Precios", "Tratamientos"…), un ítem por línea. */
export interface KnowledgeSection {
  id: string;
  title: string;
  items: string[];
}

/** Base de conocimiento del agente (va directo al prompt, sin RAG). */
export interface KnowledgeBase {
  facts?: string[];
  policies?: string[];
  sections?: KnowledgeSection[];
}

export interface FaqEntry {
  question: string;
  answer: string;
}

/** Rescate de cotizaciones abandonadas: hasta dos toques automáticos. */
export interface QuoteRecoverySettings {
  enabled?: boolean;
  waitHours?: number;
  firstTouchText?: string;
  secondTouchText?: string;
}

/** Upsell que el cliente rechazó: no se le vuelve a ofrecer antes de un tiempo. */
export interface DeclinedUpsell {
  serviceId: string;
  /** "YYYY-MM-DD". */
  date: string;
}

const businessId = () =>
  uuid("business_id")
    .notNull()
    .references(() => businesses.id, { onDelete: "cascade" });

// ─────────────────────────────────────────────────────────────────────────────
// Números de WhatsApp conectados. Uno puede atender todas las sucursales (sin
// `location_id`: el agente pregunta cuál) o una sola. `phone_number_id` es único en la
// plataforma: el webhook rutea por él (contexto de sistema) al negocio dueño.
// ─────────────────────────────────────────────────────────────────────────────
export const whatsappChannels = pgTable(
  "whatsapp_channels",
  {
    id: uuidPk(),
    businessId: businessId(),
    locationId: uuid("location_id").references(() => locations.id),
    phoneNumberId: text("phone_number_id").notNull(),
    wabaId: text("waba_id"),
    // Número visible ("+506 8888 7777"), solo para mostrar.
    displayPhone: text("display_phone"),
    // Token del WABA cifrado con src/platform/crypto/secrets.ts. Nunca en claro.
    accessTokenEncrypted: text("access_token_encrypted"),
    templates: jsonb("templates").$type<ChannelTemplates>().notNull().default({}),
    status: text("status").notNull().default("pending"),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("whatsapp_channels_phone_number_id_uq").on(t.phoneNumberId),
    index("whatsapp_channels_business_idx").on(t.businessId),
    check("whatsapp_channels_status_check", oneOf(t.status, CHANNEL_STATUSES)),
    tenantPolicy(),
  ],
).enableRLS();

// ─────────────────────────────────────────────────────────────────────────────
// Configuración del agente IA: una fila por negocio (la clave es el negocio).
// ─────────────────────────────────────────────────────────────────────────────
export const aiSettings = pgTable(
  "ai_settings",
  {
    businessId: uuid("business_id")
      .primaryKey()
      .references(() => businesses.id, { onDelete: "cascade" }),
    // Texto corto ("cordial y breve"); null = default del prompt.
    tone: text("tone"),
    // Registro con el que se le habla al cliente; null = se infiere del país.
    register: text("register"),
    // Reglas particulares del negocio, texto libre.
    instructions: text("instructions"),
    knowledge: jsonb("knowledge").$type<KnowledgeBase>().notNull().default({}),
    faq: jsonb("faq").$type<FaqEntry[]>().notNull().default([]),
    // Override de los textos del sistema al cliente final: clave del catálogo → plantilla.
    texts: jsonb("texts").$type<Record<string, string>>().notNull().default({}),
    quoteRecovery: jsonb("quote_recovery").$type<QuoteRecoverySettings>().notNull().default({}),
    // Reseñas de Google: link para pedir la reseña y Place ID para el rating diario.
    reviewUrl: text("review_url"),
    googlePlaceId: text("google_place_id"),
    ...timestamps(),
  },
  (t) => [check("ai_settings_register_check", oneOf(t.register, AI_REGISTERS)), tenantPolicy()],
).enableRLS();

// ─────────────────────────────────────────────────────────────────────────────
// Conversación de un cliente con un número del negocio. `last_activity_at` lo mantiene un
// trigger sobre `messages` (0002_domain_constraints.sql): la bandeja ordena y pagina por
// esa columna con índice, sin calcular el último mensaje de todas las conversaciones.
// El canal es NO ACTION: desconectar un número cambia su estado, no borra el historial.
// ─────────────────────────────────────────────────────────────────────────────
export const conversations = pgTable(
  "conversations",
  {
    id: uuidPk(),
    businessId: businessId(),
    // CASCADE: el derecho de supresión del cliente se lleva sus conversaciones.
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "cascade" }),
    channelId: uuid("channel_id")
      .notNull()
      .references(() => whatsappChannels.id),
    mode: text("mode").notNull().default("bot"),
    humanSince: instant("human_since"),
    status: text("status").notNull().default("open"),
    // Hasta cuándo leyó el operador: los mensajes del cliente posteriores cuentan como
    // "sin leer" (sin contador que se pise entre procesos).
    readUntil: instant("read_until"),
    declinedUpsells: jsonb("declined_upsells").$type<DeclinedUpsell[]>().notNull().default([]),
    // Cuándo se le avisó al cliente que lo atiende un bot (transparencia). No es
    // consentimiento de marketing (eso vive en `clients`).
    botNoticeSentAt: instant("bot_notice_sent_at"),
    lastActivityAt: instant("last_activity_at").notNull().defaultNow(),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("conversations_channel_client_uq").on(t.channelId, t.clientId),
    // Bandeja: conversaciones del negocio por última actividad.
    index("conversations_business_activity_idx").on(t.businessId, t.lastActivityAt),
    index("conversations_client_idx").on(t.clientId),
    check("conversations_mode_check", oneOf(t.mode, CONVERSATION_MODES)),
    check("conversations_status_check", oneOf(t.status, CONVERSATION_STATUSES)),
    tenantPolicy(),
  ],
).enableRLS();

export const messages = pgTable(
  "messages",
  {
    id: uuidPk(),
    businessId: businessId(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    role: text("role").notNull(),
    content: text("content").notNull(),
    // Saliente escrito por una persona desde la bandeja (no por el agente).
    byHuman: boolean("by_human").notNull().default(false),
    // id del mensaje en WhatsApp: único → el webhook es idempotente ante los reintentos de
    // Meta. null en los salientes (varios NULL no chocan).
    waMessageId: text("wa_message_id"),
    // Ruta del adjunto en Storage (bucket privado, URL firmada al leer), no los bytes.
    mediaPath: text("media_path"),
    mediaType: text("media_type"),
    ...timestamps(),
  },
  (t) => [
    // Historial de una conversación (agente y bandeja).
    index("messages_conversation_created_idx").on(t.conversationId, t.createdAt),
    uniqueIndex("messages_wa_message_id_uq").on(t.waMessageId),
    check("messages_role_check", oneOf(t.role, MESSAGE_ROLES)),
    check("messages_media_type_check", oneOf(t.mediaType, MESSAGE_MEDIA_TYPES)),
    tenantPolicy(),
  ],
).enableRLS();

// ─────────────────────────────────────────────────────────────────────────────
// Cotizaciones que dio el agente, para el rescate de las abandonadas (hasta dos toques).
// ─────────────────────────────────────────────────────────────────────────────
export const quotes = pgTable(
  "quotes",
  {
    id: uuidPk(),
    businessId: businessId(),
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "cascade" }),
    serviceId: uuid("service_id").references(() => services.id, { onDelete: "set null" }),
    amountCents: bigint("amount_cents", { mode: "number" }).notNull(),
    status: text("status").notNull().default("pending"),
    // La cita que la cerró (si se agendó).
    appointmentId: uuid("appointment_id").references(() => appointments.id, { onDelete: "set null" }),
    recoveredCents: bigint("recovered_cents", { mode: "number" }),
    firstTouchAt: instant("first_touch_at"),
    secondTouchAt: instant("second_touch_at"),
    ...timestamps(),
  },
  (t) => [
    // Candidatas a un toque, por negocio y antigüedad.
    index("quotes_business_status_created_idx").on(t.businessId, t.status, t.createdAt),
    index("quotes_client_idx").on(t.clientId),
    check("quotes_status_check", oneOf(t.status, QUOTE_STATUSES)),
    check("quotes_amount_check", sql`${t.amountCents} >= 0`),
    tenantPolicy(),
  ],
).enableRLS();

// ─────────────────────────────────────────────────────────────────────────────
// Seguimiento post-servicio (satisfacción + pedido de reseña). Uno por cita.
// ─────────────────────────────────────────────────────────────────────────────
export const followUps = pgTable(
  "follow_ups",
  {
    id: uuidPk(),
    businessId: businessId(),
    appointmentId: uuid("appointment_id")
      .notNull()
      .references(() => appointments.id, { onDelete: "cascade" }),
    sentAt: instant("sent_at").notNull().defaultNow(),
    // null = todavía no respondió.
    sentiment: text("sentiment"),
    reviewRequested: boolean("review_requested").notNull().default(false),
    responseText: text("response_text"),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("follow_ups_appointment_uq").on(t.appointmentId),
    index("follow_ups_business_sent_idx").on(t.businessId, t.sentAt),
    check("follow_ups_sentiment_check", oneOf(t.sentiment, FOLLOW_UP_SENTIMENTS)),
    tenantPolicy(),
  ],
).enableRLS();

// ─────────────────────────────────────────────────────────────────────────────
// Uso mensual del agente por negocio (conversaciones, mensajes, plantillas, tokens y costo
// del LLM): base del tope de conversaciones del plan Básico. Una fila por negocio y mes,
// con incrementos atómicos (INSERT … ON CONFLICT DO UPDATE SET x = x + n).
// ─────────────────────────────────────────────────────────────────────────────
export const aiUsageMonthly = pgTable(
  "ai_usage_monthly",
  {
    id: uuidPk(),
    businessId: businessId(),
    // Primer día del mes.
    month: date("month").notNull(),
    // "Conversación iniciada" ≈ primer mensaje tras 24 h de silencio (como cobra Meta).
    conversationsStarted: integer("conversations_started").notNull().default(0),
    messagesIn: integer("messages_in").notNull().default(0),
    messagesOut: integer("messages_out").notNull().default(0),
    marketingTemplates: integer("marketing_templates").notNull().default(0),
    utilityTemplates: integer("utility_templates").notNull().default(0),
    inputTokens: bigint("input_tokens", { mode: "number" }).notNull().default(0),
    outputTokens: bigint("output_tokens", { mode: "number" }).notNull().default(0),
    // Costo estimado en MILLONÉSIMOS de dólar (entero: un acumulado que crece miles de
    // veces por mes no se lleva en float).
    estimatedCostUsdMicros: bigint("estimated_cost_usd_micros", { mode: "number" }).notNull().default(0),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("ai_usage_monthly_business_month_uq").on(t.businessId, t.month),
    check("ai_usage_monthly_month_check", sql`extract(day from ${t.month}) = 1`),
    tenantPolicy(),
  ],
).enableRLS();

// ─────────────────────────────────────────────────────────────────────────────
// Red de ingesta cruda del webhook. Se guarda el payload (ya verificado por firma) cuando
// el phone_number_id no resuelve a ningún canal o la forma no se sabe leer: es la ÚNICA
// copia que sobrevive de esos mensajes, para reprocesarlos. No se guardan los eventos de
// estado (entregado/leído). Sin negocio todavía → solo contexto de sistema.
// ─────────────────────────────────────────────────────────────────────────────
export const rawWebhooks = pgTable(
  "raw_webhooks",
  {
    id: uuidPk(),
    payload: jsonb("payload").notNull(),
    // null si el payload es tan raro que ni eso se pudo leer.
    phoneNumberId: text("phone_number_id"),
    waMessageId: text("wa_message_id"),
    receivedAt: instant("received_at").notNull().defaultNow(),
    status: text("status").notNull().default("pending"),
    reason: text("reason").notNull(),
    attempts: integer("attempts").notNull().default(0),
    updatedAt: instant("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex("raw_webhooks_wa_message_id_uq").on(t.waMessageId),
    // Reproceso y alertas: pendientes, más viejos primero.
    index("raw_webhooks_status_received_idx").on(t.status, t.receivedAt),
    check("raw_webhooks_status_check", oneOf(t.status, RAW_WEBHOOK_STATUSES)),
    check("raw_webhooks_reason_check", oneOf(t.reason, RAW_WEBHOOK_REASONS)),
    systemOnlyPolicy(),
  ],
).enableRLS();

export type WhatsappChannel = typeof whatsappChannels.$inferSelect;
export type NewWhatsappChannel = typeof whatsappChannels.$inferInsert;
export type AiSettings = typeof aiSettings.$inferSelect;
export type NewAiSettings = typeof aiSettings.$inferInsert;
export type Conversation = typeof conversations.$inferSelect;
export type NewConversation = typeof conversations.$inferInsert;
export type Message = typeof messages.$inferSelect;
export type NewMessage = typeof messages.$inferInsert;
export type Quote = typeof quotes.$inferSelect;
export type NewQuote = typeof quotes.$inferInsert;
export type FollowUp = typeof followUps.$inferSelect;
export type NewFollowUp = typeof followUps.$inferInsert;
export type AiUsageMonthly = typeof aiUsageMonthly.$inferSelect;
export type NewAiUsageMonthly = typeof aiUsageMonthly.$inferInsert;
export type RawWebhook = typeof rawWebhooks.$inferSelect;
export type NewRawWebhook = typeof rawWebhooks.$inferInsert;
