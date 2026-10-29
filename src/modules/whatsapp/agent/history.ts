import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import type { AgentHistoryMessage } from "../agentContract";
import { DAY_MS, daysBetween, localDate, readableDate } from "./time";

// ─────────────────────────────────────────────────────────────────────────────
// Historial que ve el agente (puerto de legacy/src/agent/historial.ts).
//
//   1. Acotado en cantidad y antigüedad: un cliente recurrente no paga tokens por la
//      charla de hace meses (×N: cada paso de tools reenvía todo) y un "mañana" dicho hace
//      una semana no se reinterpreta como mañana de hoy.
//   2. Con fechas: antes de los mensajes de un día anterior va un separador `system` con
//      la fecha y cuánto hace ("ayer", "hace 7 días"). Separadores aparte y no un prefijo
//      dentro de cada mensaje: con el prefijo, el modelo imita el formato en sus respuestas.
//   3. Los mensajes que escribió una persona del equipo desde la bandeja van precedidos de
//      una nota: el agente no tiene que contradecir lo que dijo un humano.
//   4. Cada mensaje se corta a un largo máximo (un texto pegado enorme no infla el turno).
// ─────────────────────────────────────────────────────────────────────────────

/** Largo máximo de un mensaje del historial en el prompt. */
export const MAX_HISTORY_MESSAGE_CHARS = 2000;

/** Tope de mensajes NUEVOS del cliente que se conservan siempre (una ráfaga larga). */
const MAX_PENDING_USER_MESSAGES = 10;

export interface TrimOptions {
  maxMessages: number;
  /** 0 = sin ventana de días. */
  maxDays: number;
  now: Date;
}

/** Índice donde empieza la racha final de mensajes del cliente (los del turno actual). */
export function pendingUserStart(history: readonly AgentHistoryMessage[]): number {
  let i = history.length;
  while (i > 0 && history[i - 1].role === "user") i--;
  return i;
}

/**
 * Recorta el historial a la ventana de días y a los últimos `maxMessages`. Los mensajes
 * nuevos del cliente (la racha final) se conservan aunque sean más viejos que la ventana
 * (hasta 10): son lo que hay que contestar.
 */
export function trimHistory(history: readonly AgentHistoryMessage[], options: TrimOptions): AgentHistoryMessage[] {
  const start = pendingUserStart(history);
  const pending = history.slice(start).slice(-MAX_PENDING_USER_MESSAGES);
  const now = options.now.getTime();
  const previous = history
    .slice(0, start)
    .filter((m) => options.maxDays <= 0 || !Number.isFinite(m.at.getTime()) || now - m.at.getTime() <= options.maxDays * DAY_MS);
  const room = Math.max(0, options.maxMessages - pending.length);
  return [...(room > 0 ? previous.slice(-room) : []), ...pending];
}

function clip(text: string): string {
  const chars = Array.from(text);
  return chars.length <= MAX_HISTORY_MESSAGE_CHARS ? text : `${chars.slice(0, MAX_HISTORY_MESSAGE_CHARS).join("")}…`;
}

function daySeparator(day: string, today: string): string {
  const n = daysBetween(day, today);
  const relative = n === 1 ? "ayer" : `hace ${n} días`;
  return `[Mensajes del ${readableDate(day)} (${relative}). En estos mensajes, "hoy", "mañana", "el lunes", etc. se refieren a ESA fecha, no a la de hoy.]`;
}

const TODAY_SEPARATOR = "[Mensajes de hoy]";
const HUMAN_NOTE = "[El siguiente mensaje lo escribió una persona del equipo desde la bandeja, no vos.]";

/**
 * Convierte el historial (ya recortado) a mensajes de OpenAI, con separadores de día en la
 * zona del negocio. Si todo es de hoy, sale sin separadores.
 */
export function historyToMessages(history: readonly AgentHistoryMessage[], timeZone: string, now: Date): ChatCompletionMessageParam[] {
  const today = localDate(now, timeZone);
  const out: ChatCompletionMessageParam[] = [];
  let previousDay: string | null = null;
  let sawOlderDays = false;
  for (const m of history) {
    const day = Number.isFinite(m.at.getTime()) ? localDate(m.at, timeZone) : today;
    if (day !== previousDay) {
      if (day < today) {
        out.push({ role: "system", content: daySeparator(day, today) });
        sawOlderDays = true;
      } else if (sawOlderDays) {
        out.push({ role: "system", content: TODAY_SEPARATOR });
      }
      previousDay = day;
    }
    if (m.role === "assistant" && m.byHuman) out.push({ role: "system", content: HUMAN_NOTE });
    out.push(m.role === "user" ? { role: "user", content: clip(m.text) } : { role: "assistant", content: clip(m.text) });
  }
  return out;
}
