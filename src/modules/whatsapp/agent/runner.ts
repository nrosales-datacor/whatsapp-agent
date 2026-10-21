import OpenAI from "openai";
import type {
  ChatCompletion,
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionMessageFunctionToolCall,
  ChatCompletionMessageParam,
} from "openai/resources/chat/completions";
import type { Executor } from "../../../platform/db/scope";
import { isTransientError } from "../../../platform/net/transient";
import { log } from "../../../platform/observability/log";
import { captureError } from "../../../platform/observability/sentry";
import type { AgentReply, AgentRunner, AgentTurnInput, AgentTurnResult } from "../agentContract";
import { agentMaxSteps, agentModel, historyMaxDays, historyMaxMessages, openAiRetries, openAiTimeoutMs } from "./config";
import { loadAgentContext, type AgentContext } from "./context";
import { computeCostMicros, type TokenUsage } from "./cost";
import { historyToMessages, pendingUserStart, trimHistory } from "./history";
import { buildSystemPrompt, buildTurnContext } from "./prompt";
import { agentText } from "./texts";
import { emptyEffects, executeTool, TOOL_DEFINITIONS, type ErrorReporter, type ToolRuntime, type TurnEffects } from "./tools";

// ─────────────────────────────────────────────────────────────────────────────
// Bucle del agente (puerto de legacy/src/agent/runAgent.ts sobre el contrato nuevo,
// ../agentContract.ts). Un turno:
//
//   1. Arma el contexto del negocio (núcleo + ai_settings) y los mensajes: prompt estable
//      (cacheable) → historial previo acotado y con fechas → contexto del turno (fecha y
//      hora, sucursal del canal, nombre del cliente) → mensajes nuevos del cliente.
//   2. Llama al modelo hasta `AGENT_MAX_STEPS` veces: cada pedido de tools se ejecuta (con
//      los servicios del núcleo) y su resultado vuelve al modelo. Termina con la respuesta
//      de texto, con `handoff_to_human`, o al agotar los pasos (→ traspaso).
//   3. Cada llamada lleva timeout (`OPENAI_TIMEOUT_MS`) y, ante un error transitorio
//      (red, 429, 5xx), se reintenta dentro del turno (`AGENT_OPENAI_RETRIES`). Si igual
//      falla: sin acciones guardadas se relanza (la cola reintenta el job con backoff, ver
//      src/platform/net/transient.ts); con acciones ya guardadas se responde la
//      confirmación fija, para que un reintento no duplique la cita.
//   4. Suma el uso de tokens de todos los pasos y estima el costo en micro-dólares.
//
// Resultado (`AgentTurnResult`): `replies` (con botones si ofreció horarios), `actions`
// (traspaso y citas agendadas/movidas/canceladas) y `usage`. El pipeline lo aplica.
// ─────────────────────────────────────────────────────────────────────────────

/** Lo mínimo del cliente de OpenAI que usa el agente (en los tests, un doble). */
export interface ChatCompletionsClient {
  chat: {
    completions: {
      create(
        body: ChatCompletionCreateParamsNonStreaming,
        options?: { signal?: AbortSignal; timeout?: number; maxRetries?: number },
      ): PromiseLike<ChatCompletion>;
    };
  };
}

/** Un paso de tool ejecutado (observabilidad, evals y tests). */
export interface ToolCallEvent {
  name: string;
  args: Record<string, unknown>;
  ok: boolean;
}

export interface AgentRunnerDeps {
  /** Cliente de OpenAI. Default: uno real, creado al primer uso (lee OPENAI_API_KEY). */
  openai?: ChatCompletionsClient;
  /** Modelo. Default: `OPENAI_MODEL` o gpt-4o-mini. */
  model?: string;
  /** Tope de llamadas al modelo por turno. Default: `AGENT_MAX_STEPS` (5). */
  maxSteps?: number;
  /** Timeout de cada llamada en ms. Default: `OPENAI_TIMEOUT_MS` (20 s). */
  timeoutMs?: number;
  /** Reintentos ante un error transitorio. Default: `AGENT_OPENAI_RETRIES` (1). */
  retries?: number;
  /** Espera antes de cada reintento en ms (se multiplica por el intento). Default 500. */
  retryDelayMs?: number;
  /** Historial: mensajes y días. Default: `AGENT_HISTORY_MAX_MESSAGES` (20) y `AGENT_HISTORY_MAX_DAYS` (30). */
  history?: { maxMessages?: number; maxDays?: number };
  /** Errores internos (tools, contexto). Default: Sentry + log. */
  reportError?: ErrorReporter;
  /** Se llama por cada tool ejecutada. */
  onToolCall?: (event: ToolCallEvent) => void;
}

/** Largo máximo de un mensaje de WhatsApp (Meta corta en 4096). */
const MAX_REPLY_CHARS = 4000;

const defaultReportError: ErrorReporter = (error, context) => {
  log.error("agent_internal_error", { ...context, error: error instanceof Error ? error.message : String(error) });
  captureError(error, context);
};

let sharedClient: OpenAI | null = null;
/** Cliente real perezoso: el server arranca aunque falte OPENAI_API_KEY; recién se exige al primer turno. */
function defaultClient(): OpenAI {
  // maxRetries 0: los reintentos los maneja el bucle (con su propio tope y timeout por llamada).
  sharedClient ??= new OpenAI({ timeout: openAiTimeoutMs(), maxRetries: 0 });
  return sharedClient;
}

/** Los modelos de razonamiento (gpt-5, o1/o3/o4) no aceptan `temperature`. */
function supportsTemperature(model: string): boolean {
  return !/^(gpt-5|o\d)/.test(model);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Arma los mensajes del primer paso. */
export function buildMessages(ctx: AgentContext, input: AgentTurnInput, history: { maxMessages: number; maxDays: number }): ChatCompletionMessageParam[] {
  const trimmed = trimHistory(input.history, { ...history, now: input.now });
  const start = pendingUserStart(trimmed);
  return [
    { role: "system", content: buildSystemPrompt(ctx) },
    ...historyToMessages(trimmed.slice(0, start), ctx.timezone, input.now),
    { role: "system", content: buildTurnContext(ctx, { now: input.now, channelLocationId: input.locationId, clientName: input.clientName }) },
    ...historyToMessages(trimmed.slice(start), ctx.timezone, input.now).filter((m) => m.role !== "system"),
  ];
}

function clipReply(text: string): string {
  const chars = Array.from(text.trim());
  return chars.length <= MAX_REPLY_CHARS ? chars.join("") : `${chars.slice(0, MAX_REPLY_CHARS - 1).join("")}…`;
}

function parseArgs(raw: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(raw || "{}");
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * Crea el `AgentRunner` del contrato. La composición (src/jobs.ts) lo inyecta al pipeline
 * de WhatsApp; los tests le pasan un doble de OpenAI.
 */
export function createAgentRunner(deps: AgentRunnerDeps = {}): AgentRunner {
  const reportError = deps.reportError ?? defaultReportError;

  return async function runAgentTurn(executor: Executor, input: AgentTurnInput): Promise<AgentTurnResult> {
    const model = deps.model ?? agentModel();
    const maxSteps = Math.max(1, deps.maxSteps ?? agentMaxSteps());
    const timeoutMs = deps.timeoutMs ?? openAiTimeoutMs();
    const retries = Math.max(0, deps.retries ?? openAiRetries());
    const retryDelayMs = deps.retryDelayMs ?? 500;
    const history = { maxMessages: deps.history?.maxMessages ?? historyMaxMessages(), maxDays: deps.history?.maxDays ?? historyMaxDays() };
    const client = deps.openai ?? defaultClient();

    const ctx = await loadAgentContext(executor, input.businessId);
    if (!ctx) throw new Error("agent: el negocio del turno no existe");

    const effects: TurnEffects = emptyEffects();
    const runtime: ToolRuntime = { executor, ctx, input, effects };
    const tokens: TokenUsage = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 };
    const usage = () => ({
      inputTokens: tokens.inputTokens,
      outputTokens: tokens.outputTokens,
      costMicros: computeCostMicros(model, tokens),
    });
    const handoffText = () => agentText(ctx.settings, "handoff");
    /** Respuesta de un turno que no termina en un texto del modelo: lo guardado + el traspaso (si hay). */
    const fallbackResult = (handoffReason: string | null): AgentTurnResult => {
      const replies: AgentReply[] = effects.confirmations.map((text) => ({ text }));
      const actions = [...effects.actions];
      if (handoffReason !== null) {
        replies.push({ text: handoffText() });
        actions.push({ type: "handoff", reason: handoffReason });
      }
      return { replies, actions, usage: usage() };
    };

    const messages = buildMessages(ctx, input, history);
    const body = (): ChatCompletionCreateParamsNonStreaming => ({
      model,
      messages,
      tools: TOOL_DEFINITIONS,
      // Con `strict`, OpenAI no garantiza el esquema en llamadas paralelas: una por paso.
      parallel_tool_calls: false,
      // Agrupa en el mismo caché las requests del negocio (comparten el prefijo largo).
      prompt_cache_key: `business:${input.businessId}`,
      ...(supportsTemperature(model) ? { temperature: 0.3 } : {}),
    });

    async function callModel(): Promise<ChatCompletion> {
      for (let attempt = 0; ; attempt++) {
        try {
          return await client.chat.completions.create(body(), { signal: AbortSignal.timeout(timeoutMs), timeout: timeoutMs, maxRetries: 0 });
        } catch (error) {
          const aborted = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
          if (attempt >= retries || !(aborted || isTransientError(error))) throw error;
          log.warn("agent_openai_retry", { businessId: input.businessId, attempt: attempt + 1, error: error instanceof Error ? error.name : "unknown" });
          await sleep(retryDelayMs * (attempt + 1));
        }
      }
    }

    for (let step = 0; step < maxSteps; step++) {
      let completion: ChatCompletion;
      try {
        completion = await callModel();
      } catch (error) {
        // OpenAI falló DESPUÉS de guardar algo: se confirma con texto fijo (si se relanzara,
        // el reintento del job volvería a agendar). Sin nada guardado, se relanza.
        if (effects.actions.length === 0) throw error;
        reportError(error, { stage: "openai_after_action", businessId: input.businessId, conversationId: input.conversationId });
        return fallbackResult(null);
      }
      tokens.inputTokens += completion.usage?.prompt_tokens ?? 0;
      tokens.outputTokens += completion.usage?.completion_tokens ?? 0;
      tokens.cachedInputTokens += completion.usage?.prompt_tokens_details?.cached_tokens ?? 0;

      const message = completion.choices[0]?.message;
      // openai 6.x también puede devolver tools "custom": solo se procesan las de función.
      const calls = (message?.tool_calls ?? []).filter((c): c is ChatCompletionMessageFunctionToolCall => c.type === "function");
      if (!message || calls.length === 0) {
        const text = clipReply(message?.content ?? "");
        const buttons = effects.buttons ?? undefined;
        const reply: AgentReply = { text: text || agentText(ctx.settings, buttons ? "pickSlot" : "notUnderstood") };
        if (buttons) reply.buttons = buttons;
        return { replies: [reply], actions: [...effects.actions], usage: usage() };
      }

      messages.push({ role: "assistant", content: message.content ?? null, tool_calls: calls });
      for (const call of calls) {
        const result = await executeTool(call.function.name, call.function.arguments, runtime, reportError);
        deps.onToolCall?.({ name: call.function.name, args: parseArgs(call.function.arguments), ok: result.ok });
        messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result) });
      }
      if (effects.handoff) return fallbackResult(effects.handoff.reason);
    }

    // Se agotaron los pasos sin respuesta: si algo quedó guardado se confirma; si no, el
    // agente quedó trabado y pasa a una persona (mejor que dejar al cliente sin respuesta).
    if (effects.actions.length > 0) return fallbackResult(null);
    log.warn("agent_max_steps", { businessId: input.businessId, conversationId: input.conversationId, maxSteps });
    return fallbackResult("El asistente no pudo completar la solicitud.");
  };
}
