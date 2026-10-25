import { eq } from "drizzle-orm";
import { withTenant, type Executor } from "../../platform/db/scope";
import { log } from "../../platform/observability/log";
import { getBusinessContext } from "../business";
import type { AgentRunner } from "./agentContract";
import { recordTokenStatus } from "./channels";
import { createGraphApi, type MetaSignupApi, type WhatsAppApi } from "./graph";
import { noGrowth, type GrowthResolver } from "./growth";
import { noAiLimits, type AiLimitsResolver } from "./limits";
import { supabaseMediaStorage, whisperTranscriber, type AudioTranscriber, type MediaStorage } from "./media";
import { sendPushToBusiness, webPushTransport, type PushTransport } from "./push";
import { aiSettings } from "./schema";
import { registerFor, type TextProfile } from "./texts";

// ─────────────────────────────────────────────────────────────────────────────
// Dependencias del módulo (red, almacenamiento, IA, push y límites del plan), en un solo
// objeto inyectable: la composición arma el real con `createWhatsAppDeps(db, …)` y los
// tests reemplazan las piezas (Graph y OpenAI nunca salen a la red en un test).
//
// Punto de inyección del agente de IA: `agent`. Sin él, `handoffAgentRunner` pasa cada
// conversación a una persona (el bot no inventa respuestas). Los límites del plan:
// `getAiLimits` (la composición los saca del plan del negocio, src/plans.ts; sin
// inyectar, sin tope: lo usan las rutas del panel y los tests, ver ./limits.ts). Lo de
// crecimiento del plan (consentimiento, reseñas, rescate, upsell): `getGrowth` (./growth.ts;
// sin inyectar, nada).
// ─────────────────────────────────────────────────────────────────────────────

export interface WhatsAppDeps {
  api: WhatsAppApi & MetaSignupApi;
  storage: MediaStorage;
  transcribe: AudioTranscriber;
  /** Transporte de push (null = sin VAPID: no se manda nada). */
  push: () => PushTransport | null;
  agent: AgentRunner;
  getAiLimits: AiLimitsResolver;
  getGrowth: GrowthResolver;
  now: () => Date;
}

/** Runner por defecto (sin agente compuesto): pasa la conversación a una persona. */
export const handoffAgentRunner: AgentRunner = async () => ({
  replies: [],
  actions: [{ type: "handoff", reason: "El agente de IA no está configurado: atendé esta conversación a mano." }],
  usage: { inputTokens: 0, outputTokens: 0, costMicros: 0 },
});

export function createWhatsAppDeps(db: Executor, overrides: Partial<WhatsAppDeps> = {}): WhatsAppDeps {
  return {
    api: overrides.api ?? createGraphApi({ onTokenStatus: (channel, valid) => void recordTokenStatus(db, channel, valid) }),
    storage: overrides.storage ?? supabaseMediaStorage,
    transcribe: overrides.transcribe ?? whisperTranscriber,
    push: overrides.push ?? webPushTransport,
    agent: overrides.agent ?? handoffAgentRunner,
    getAiLimits: overrides.getAiLimits ?? noAiLimits,
    getGrowth: overrides.getGrowth ?? noGrowth,
    now: overrides.now ?? (() => new Date()),
  };
}

/** Cómo se le habla al cliente de este negocio (registro y textos propios). */
export async function loadTextProfile(db: Executor, businessId: string): Promise<TextProfile> {
  const ctx = await getBusinessContext(db, businessId);
  const [settings] = await withTenant(db, businessId, (tx) =>
    tx.select({ register: aiSettings.register, texts: aiSettings.texts }).from(aiSettings).where(eq(aiSettings.businessId, businessId)).limit(1),
  );
  return {
    register: registerFor(settings?.register, ctx?.business.country),
    overrides: settings?.texts ?? {},
    businessName: ctx?.business.name ?? "",
  };
}

/** Ruta del panel de una conversación (la abre el push). */
export function conversationUrl(conversationId: string): string {
  return `/panel/whatsapp/conversations/${conversationId}`;
}

/**
 * Avisa al equipo que una conversación necesita a una persona (push a sus dispositivos).
 * Best-effort: nunca lanza. `body` puede traer un fragmento del mensaje del cliente (va
 * al teléfono del equipo, no a los logs).
 */
export async function notifyTeam(
  db: Executor,
  deps: Pick<WhatsAppDeps, "push">,
  businessId: string,
  conversation: { id: string; clientName: string },
  body: string,
): Promise<void> {
  const result = await sendPushToBusiness(
    db,
    businessId,
    { title: `💬 ${conversation.clientName}`, body: body.slice(0, 120), url: conversationUrl(conversation.id), tag: conversation.id },
    { transport: deps.push() },
  );
  log.info("whatsapp_team_notified", { businessId, conversationId: conversation.id, sent: result.sent, failed: result.failed });
}
