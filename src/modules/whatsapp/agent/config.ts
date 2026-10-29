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
