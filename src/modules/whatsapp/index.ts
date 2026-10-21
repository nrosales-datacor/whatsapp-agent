// API pública del módulo whatsapp: lo único que otros módulos (y la composición en src/)
// pueden importar de acá (test/architecture/moduleBoundaries.test.ts).
//
// Qué compone src/ (ver src/routes.ts, src/jobs.ts y src/app.ts):
//   • `createWhatsAppDeps(db, { agent, getAiLimits })`: dependencias reales del módulo. El
//     punto de inyección del agente de IA es `agent` (sin él, `handoffAgentRunner` pasa
//     todo a una persona) y el de los límites del plan, `getAiLimits` (TODO(billing)).
//   • `whatsappRoutes({ db, deps })` → API del panel; `whatsappClientEraser` → borrador de
//     datos para `clientsRoutes({ clientErasers })`; `countConversationsWaiting` → Inicio.
//   • `createWhatsAppWebhookHandler({ db })` en `WHATSAPP_WEBHOOK_PATH` (fuera de /api/panel).
//   • `whatsappJobHandlers(deps)` y `startWhatsAppSchedulers(db)` → cola y loops.
//   • `isWhatsAppConnected` y `queueWhatsAppReminder` → inyección en `handleReminderJob`.
export type { AgentAction, AgentHistoryMessage, AgentReply, AgentRunner, AgentTurnInput, AgentTurnResult } from "./agentContract";
export { channelForLocation, isWhatsAppConnected, listChannels, type ChannelView, type TokenStatus } from "./channels";
export { createAgentRunner, type AgentRunnerDeps } from "./agent";
export { createWhatsAppDeps, handoffAgentRunner, loadTextProfile, type WhatsAppDeps } from "./deps";
export { WHATSAPP_MEDIA_ERASE_JOB, whatsappClientEraser } from "./eraser";
export {
  createGraphApi,
  GraphError,
  toWhatsAppNumber,
  type ChannelCredentials,
  type MetaSignupApi,
  type ReplyButton,
  type TemplateMessage,
  type WhatsAppApi,
} from "./graph";
export { countConversationsWaiting } from "./inbox";
export { WHATSAPP_INBOUND_JOB } from "./ingest";
export { startWhatsAppSchedulers, whatsappJobHandlers, type WhatsAppJobSpec } from "./jobs";
export { defaultAiLimits, type AiLimits, type AiLimitsResolver } from "./limits";
export type { AudioTranscriber, MediaStorage } from "./media";
export type { PushTransport } from "./push";
export { queueWhatsAppReminder, WHATSAPP_REMINDER_JOB } from "./reminders";
export { whatsappRoutes, type WhatsAppRouteDeps } from "./routes";
export { getAiSettings, updateAiSettings } from "./settings";
export { settingsRoutes as whatsappSettingsRoutes } from "./settingsRoutes";
export { PIPELINE_TEXT_KEYS, pipelineText, registerFor, type PipelineTextKey, type TextProfile } from "./texts";
export { createWhatsAppWebhookHandler, WHATSAPP_WEBHOOK_PATH } from "./webhook";
export type {
  AiRegister,
  AiSettings,
  AiUsageMonthly,
  ChannelStatus,
  ChannelTemplate,
  ChannelTemplates,
  Conversation,
  ConversationMode,
  ConversationStatus,
  DeclinedUpsell,
  FaqEntry,
  FollowUp,
  FollowUpSentiment,
  KnowledgeBase,
  KnowledgeSection,
  Message,
  MessageMediaType,
  MessageRole,
  NewAiSettings,
  NewAiUsageMonthly,
  NewConversation,
  NewFollowUp,
  NewMessage,
  NewQuote,
  NewRawWebhook,
  NewWhatsappChannel,
  Quote,
  QuoteRecoverySettings,
  QuoteStatus,
  RawWebhook,
  RawWebhookReason,
  RawWebhookStatus,
  WhatsappChannel,
} from "./schema";
