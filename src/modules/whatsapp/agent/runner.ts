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
import type { AppointmentBookedHook } from "../../scheduling";
import type { AgentReply, AgentRunner, AgentTurnInput, AgentTurnResult } from "../agentContract";
import {
  agentMaxOutputTokens,
  agentMaxSteps,
  agentModel,
  agentReasoningExtraTokens,
  historyMaxDays,
  historyMaxMessages,
  maxSystemPromptChars,
  openAiRetries,
  openAiTimeoutMs,
} from "./config";
import { loadAgentContext, type AgentContext } from "./context";
import { computeCostMicros, type TokenUsage } from "./cost";
import { historyToMessages, pendingUserStart, trimHistory } from "./history";
import { buildSystemPrompt, buildTurnContext, fitSystemPrompt } from "./prompt";
import { agentText } from "./texts";
import { emptyEffects, executeTool, toolDefinitionsFor, type ErrorReporter, type ToolRuntime, type TurnEffects } from "./tools";

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
//   5. Topes de tokens: cada llamada lleva `max_completion_tokens` (`AGENT_MAX_OUTPUT_TOKENS`,
//      más un margen para los modelos de razonamiento) y el prompt de sistema entra en
//      `AGENT_MAX_SYSTEM_PROMPT_CHARS` (./prompt.ts recorta si hace falta). Si la respuesta
//      sale cortada (`finish_reason: "length"`) se manda hasta la última oración completa;
//      sin texto, se le pide UNA vez que responda más corto y, si no, pasa a una persona.
//      Si el request no entra en la ventana del modelo (`context_length_exceeded`), se
//      reintenta UNA vez con la mitad del historial y, si tampoco, pasa a una persona
//      (nunca un error que se repetiría en cada mensaje).
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
  /** Tope de tokens de salida por llamada. Default: `AGENT_MAX_OUTPUT_TOKENS` (600). */
  maxOutputTokens?: number;
  /** Margen de salida extra para modelos de razonamiento. Default: `AGENT_REASONING_EXTRA_TOKENS` (3000). */
  reasoningExtraTokens?: number;
  /** Presupuesto del prompt de sistema en caracteres. Default: `AGENT_MAX_SYSTEM_PROMPT_CHARS` (32 000). */
  maxSystemPromptChars?: number;
  /** Historial: mensajes y días. Default: `AGENT_HISTORY_MAX_MESSAGES` (20) y `AGENT_HISTORY_MAX_DAYS` (30). */
  history?: { maxMessages?: number; maxDays?: number };
  /** Errores internos (tools, contexto). Default: Sentry + log. */
  reportError?: ErrorReporter;
  /** Se llama por cada tool ejecutada. */
  onToolCall?: (event: ToolCallEvent) => void;
  /** Aviso de cada cita que agenda el agente, ya confirmada (la composición cuenta el uso en `daily_usage`). */
  onAppointmentBooked?: AppointmentBookedHook;
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

/** Modelos de razonamiento (gpt-5, o1/o3/o4): no aceptan `temperature` y piensan dentro del tope de salida. */
function isReasoningModel(model: string): boolean {
  return /^(gpt-5|o\d)/.test(model);
}

/** Pedido al modelo cuando su respuesta se cortó por largo sin dejar texto. */
const SHORTER_REPLY_INSTRUCTION =
  "Tu respuesta anterior se cortó por ser demasiado larga. Respondé de nuevo al último mensaje del cliente en un mensaje MUY corto (2 o 3 frases como máximo), sin listas.";

/** ¿El request no entró en la ventana de contexto del modelo? (400 `context_length_exceeded` de OpenAI) */
export function isContextOverflowError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const e = error as { code?: unknown; status?: unknown; message?: unknown; error?: { code?: unknown } | null };
  if (e.code === "context_length_exceeded" || e.error?.code === "context_length_exceeded") return true;
  return e.status === 400 && typeof e.message === "string" && /maximum context length|context window|context_length/i.test(e.message);
}

/**
 * Texto cortado por el tope de salida → hasta la última oración completa ("." "!" "?" "…"
 * o fin de línea). Sin ninguna oración completa, vacío: un pedazo suelto no se manda.
 */
export function cutToLastSentence(text: string): string {
  const trimmed = text.trim();
  let end = -1;
  for (const m of trimmed.matchAll(/[.!?…](?=\s|$)|\n/g)) end = m.index + m[0].length;
  return end > 0 ? trimmed.slice(0, end).trim() : "";
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Arma los mensajes del primer paso (`systemPrompt`: el ya ajustado al presupuesto; default, el completo). */
export function buildMessages(
  ctx: AgentContext,
  input: AgentTurnInput,
  history: { maxMessages: number; maxDays: number },
  systemPrompt: string = buildSystemPrompt(ctx, input.growth),
): ChatCompletionMessageParam[] {
  const trimmed = trimHistory(input.history, { ...history, now: input.now });
  const start = pendingUserStart(trimmed);
  return [
    { role: "system", content: systemPrompt },
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
    const reasoning = isReasoningModel(model);
    const maxCompletionTokens = (deps.maxOutputTokens ?? agentMaxOutputTokens()) + (reasoning ? (deps.reasoningExtraTokens ?? agentReasoningExtraTokens()) : 0);
    const logContext = { businessId: input.businessId, conversationId: input.conversationId };

    const ctx = await loadAgentContext(executor, input.businessId);
    if (!ctx) throw new Error("agent: el negocio del turno no existe");

    const effects: TurnEffects = emptyEffects();
    const runtime: ToolRuntime = { executor, ctx, input, effects, onAppointmentBooked: deps.onAppointmentBooked, reportError };
    const tools = toolDefinitionsFor(input.growth);
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

    /** Respuesta final de texto (con los botones de horarios, si los ofreció). */
    const textResult = (raw: string): AgentTurnResult => {
      const text = clipReply(raw);
      const buttons = effects.buttons ?? undefined;
      const reply: AgentReply = { text: text || agentText(ctx.settings, buttons ? "pickSlot" : "notUnderstood") };
      if (buttons) reply.buttons = buttons;
      return { replies: [reply], actions: [...effects.actions], usage: usage() };
    };

    const maxPromptChars = deps.maxSystemPromptChars ?? maxSystemPromptChars();
    const fitted = fitSystemPrompt(ctx, input.growth, maxPromptChars);
    if (fitted.trimmed.length > 0 || fitted.overBudget) {
      log.warn("agent_system_prompt_trimmed", {
        businessId: input.businessId,
        originalChars: fitted.originalChars,
        chars: fitted.prompt.length,
        maxChars: maxPromptChars,
        trimmed: fitted.trimmed.join(","),
        overBudget: fitted.overBudget,
      });
    }
    // Prefijo (prompt → historial → contexto del turno → mensajes nuevos) + lo que suma el
    // turno (pedidos de tools y sus resultados): el prefijo se rearma si hay que achicarlo.
    let prefix = buildMessages(ctx, input, history, fitted.prompt);
    const turnMessages: ChatCompletionMessageParam[] = [];
    const body = (): ChatCompletionCreateParamsNonStreaming => ({
      model,
      messages: [...prefix, ...turnMessages],
      tools,
      // Con `strict`, OpenAI no garantiza el esquema en llamadas paralelas: una por paso.
      parallel_tool_calls: false,
      // Agrupa en el mismo caché las requests del negocio (comparten el prefijo largo).
      prompt_cache_key: `business:${input.businessId}`,
      max_completion_tokens: maxCompletionTokens,
      ...(reasoning ? {} : { temperature: 0.3 }),
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

    let historyHalved = false;
    /**
     * `callModel` con el desborde de contexto contemplado: reintenta UNA vez con la mitad
     * del historial. null = tampoco entró.
     */
    const callModelWithinContext = async (): Promise<ChatCompletion | null> => {
      for (;;) {
        try {
          return await callModel();
        } catch (error) {
          if (!isContextOverflowError(error)) throw error;
          if (historyHalved) {
            log.error("agent_context_overflow", { ...logContext, model, systemPromptChars: fitted.prompt.length });
            return null;
          }
          historyHalved = true;
          const included = trimHistory(input.history, { ...history, now: input.now }).length;
          const halved = { ...history, maxMessages: Math.max(1, Math.floor(included / 2)) };
          log.warn("agent_context_overflow_retry", { ...logContext, model, historyMessages: included, maxMessages: halved.maxMessages });
          prefix = buildMessages(ctx, input, halved, fitted.prompt);
        }
      }
    };

    let shorterRequested = false;
    for (let step = 0; step < maxSteps; step++) {
      let completion: ChatCompletion | null;
      try {
        completion = await callModelWithinContext();
      } catch (error) {
        // OpenAI falló DESPUÉS de guardar algo: se confirma con texto fijo (si se relanzara,
        // el reintento del job volvería a agendar). Sin nada guardado, se relanza.
        if (effects.actions.length === 0) throw error;
        reportError(error, { stage: "openai_after_action", businessId: input.businessId, conversationId: input.conversationId });
        return fallbackResult(null);
      }
      if (!completion) return fallbackResult("La conversación quedó demasiado larga para el asistente.");
      tokens.inputTokens += completion.usage?.prompt_tokens ?? 0;
      tokens.outputTokens += completion.usage?.completion_tokens ?? 0;
      tokens.cachedInputTokens += completion.usage?.prompt_tokens_details?.cached_tokens ?? 0;

      const choice = completion.choices[0];
      const message = choice?.message;
      if (choice?.finish_reason === "length") {
        // Se cortó por el tope de salida: lo que haya de tools viene a medias y no se ejecuta.
        const text = cutToLastSentence(message?.content ?? "");
        log.warn("agent_output_truncated", { ...logContext, model, step, maxCompletionTokens, partialSent: text.length > 0, partialChars: text.length, retried: shorterRequested });
        if (text || effects.buttons) return textResult(text);
        if (!shorterRequested && step + 1 < maxSteps) {
          shorterRequested = true;
          turnMessages.push({ role: "system", content: SHORTER_REPLY_INSTRUCTION });
          continue;
        }
        return fallbackResult("La respuesta del asistente se cortó por ser demasiado larga.");
      }
      // openai 6.x también puede devolver tools "custom": solo se procesan las de función.
      const calls = (message?.tool_calls ?? []).filter((c): c is ChatCompletionMessageFunctionToolCall => c.type === "function");
      if (!message || calls.length === 0) return textResult(message?.content ?? "");

      turnMessages.push({ role: "assistant", content: message.content ?? null, tool_calls: calls });
      for (const call of calls) {
        const result = await executeTool(call.function.name, call.function.arguments, runtime, reportError);
        deps.onToolCall?.({ name: call.function.name, args: parseArgs(call.function.arguments), ok: result.ok });
        turnMessages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result) });
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
