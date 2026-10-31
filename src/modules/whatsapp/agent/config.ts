import { msFromEnv } from "../../../platform/net/timeouts";

// ─────────────────────────────────────────────────────────────────────────────
// Configuración del agente por variables de entorno (todas documentadas en .env.example).
// Se leen en cada llamada (no al importar): los tests pueden cambiarlas sin reimportar.
// ─────────────────────────────────────────────────────────────────────────────

/** Entero de una env dentro de [min, max]; si falta o es inválido, el default. */
export function intFromEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  const n = raw !== undefined && raw.trim() !== "" ? Number(raw) : NaN;
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
}

/** Modelo de OpenAI (`OPENAI_MODEL`, default gpt-4o-mini). */
export function agentModel(): string {
  return process.env.OPENAI_MODEL?.trim() || "gpt-4o-mini";
}

/**
 * Timeout de UNA llamada a OpenAI (`OPENAI_TIMEOUT_MS`, default 20 s). Los defaults del
 * SDK (600 s × reintentos) dejarían el worker colgado y con él la cola de todos los
 * negocios (ver src/platform/net/timeouts.ts).
 */
export function openAiTimeoutMs(): number {
  return msFromEnv("OPENAI_TIMEOUT_MS", 20_000);
}

/** Reintentos ante un error transitorio de OpenAI dentro del mismo turno (`AGENT_OPENAI_RETRIES`, 0-3, default 1). */
export function openAiRetries(): number {
  return intFromEnv("AGENT_OPENAI_RETRIES", 1, 0, 3);
}

/** Tope de llamadas al modelo por turno (`AGENT_MAX_STEPS`, 1-10, default 5). */
export function agentMaxSteps(): number {
  return intFromEnv("AGENT_MAX_STEPS", 5, 1, 10);
}

/** Mensajes del historial que ve el agente (`AGENT_HISTORY_MAX_MESSAGES`, 2-100, default 20). */
export function historyMaxMessages(): number {
  return intFromEnv("AGENT_HISTORY_MAX_MESSAGES", 20, 2, 100);
}

/** Ventana del historial en días (`AGENT_HISTORY_MAX_DAYS`, 0-365, default 30; 0 = sin ventana). */
export function historyMaxDays(): number {
  return intFromEnv("AGENT_HISTORY_MAX_DAYS", 30, 0, 365);
}

/**
 * Tope de citas futuras vivas por cliente que puede agendar el agente
 * (`AGENT_MAX_UPCOMING_APPOINTMENTS`, 1-50, default 3): un solo número no llena la agenda.
 */
export function maxUpcomingAppointments(): number {
  return intFromEnv("AGENT_MAX_UPCOMING_APPOINTMENTS", 3, 1, 50);
}

// ── Topes de tokens (ver runner.ts y prompt.ts) ─────────────────────────────

/**
 * Tope de tokens de SALIDA de cada llamada al modelo (`AGENT_MAX_OUTPUT_TOKENS`, 100-4000,
 * default 600 ≈ 2000 caracteres: varias veces una respuesta de WhatsApp). Va como
 * `max_completion_tokens`: una respuesta desbocada no cuesta ni tarda más que esto.
 */
export function agentMaxOutputTokens(): number {
  return intFromEnv("AGENT_MAX_OUTPUT_TOKENS", 600, 100, 4000);
}

/**
 * Margen EXTRA de salida para los modelos de razonamiento (gpt-5, o1/o3/o4), que gastan
 * tokens "pensando" antes de escribir y los cuentan dentro de `max_completion_tokens`
 * (`AGENT_REASONING_EXTRA_TOKENS`, 0-30000, default 3000). Sin margen, el razonamiento se
 * come el tope y la respuesta sale vacía.
 */
export function agentReasoningExtraTokens(): number {
  return intFromEnv("AGENT_REASONING_EXTRA_TOKENS", 3000, 0, 30_000);
}

/**
 * Presupuesto del prompt de sistema en caracteres (`AGENT_MAX_SYSTEM_PROMPT_CHARS`,
 * 8000-200000, default 32 000 ≈ 9000 tokens). Se reenvía en cada paso del turno (hasta
 * `AGENT_MAX_STEPS`): al guardar la configuración se rechaza lo que lo pasa (422) y, en el
 * turno, si igual lo pasa (creció el catálogo) se recorta.
 */
export function maxSystemPromptChars(): number {
  return intFromEnv("AGENT_MAX_SYSTEM_PROMPT_CHARS", 32_000, 8000, 200_000);
}
