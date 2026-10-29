import { isoToZoned } from "../settings/zonedTime";
import { formatPhone } from "../clients/format";
import { formatShortDate, formatTime, todayIn } from "../scheduling/format";
import type { ConversationClient, ConversationMode, MessageAuthor } from "./whatsappApi";

// ─────────────────────────────────────────────────────────────────────────────
// Formatos de WhatsApp IA, en la zona horaria del negocio (no la del navegador).
// ─────────────────────────────────────────────────────────────────────────────

export const MODE_LABEL: Record<ConversationMode, string> = { bot: "Agente", human: "Persona" };
export const AUTHOR_LABEL: Record<MessageAuthor, string> = { client: "Cliente", bot: "Agente", human: "Persona" };

/** Nombre a mostrar: el de la ficha o, si no tiene, el teléfono. */
export function clientLabel(client: ConversationClient): string {
  return client.name?.trim() || formatPhone(client.phone) || "Sin nombre";
}

/** Iniciales para el avatar ("María Fernández" → "MF"); sin nombre, los últimos dígitos del teléfono. */
export function avatarText(client: ConversationClient): string {
  const name = client.name?.trim();
  if (name) {
    const parts = name.split(/\s+/).filter(Boolean);
    const letters = parts.length > 1 ? [parts[0], parts[parts.length - 1]] : parts;
    return letters.map((p) => p.charAt(0).toLocaleUpperCase("es")).join("");
  }
  return (client.phone ?? "").replace(/\D/g, "").slice(-2) || "?";
}

/** Día local "AAAA-MM-DD" de un instante. */
export function localDate(iso: string, timeZone: string): string {
  return isoToZoned(iso, timeZone).date;
}

export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const next = new Date(Date.UTC(y, m - 1, d + days));
  return `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, "0")}-${String(next.getUTCDate()).padStart(2, "0")}`;
}


/** Hora corta de la bandeja: hoy → "9:24 a. m."; ayer → "Ayer"; esta semana → "lun"; si no, "12 oct". */
export function formatListTime(iso: string, timeZone: string): string {
  const day = localDate(iso, timeZone);
  const today = todayIn(timeZone);
  if (day === today) return formatTime(iso, timeZone);
  if (day === addDays(today, -1)) return "Ayer";
  const [y, m, d] = day.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  if (day > addDays(today, -7)) return date.toLocaleDateString("es-CR", { weekday: "short", timeZone: "UTC" }).replace(".", "");
  return date.toLocaleDateString("es-CR", { day: "numeric", month: "short", timeZone: "UTC" }).replace(".", "");
}

/** Separador de día del chat: "Hoy", "Ayer" o "lunes 19 de octubre". */
export function formatDayLabel(date: string, timeZone: string): string {
  const today = todayIn(timeZone);
  if (date === today) return "Hoy";
  if (date === addDays(today, -1)) return "Ayer";
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("es-CR", {
    weekday: "long",
    day: "numeric",
    month: "long",
    ...(date.slice(0, 4) !== today.slice(0, 4) ? { year: "numeric" } : {}),
    timeZone: "UTC",
  });
}

/** Cita próxima corta: "lun 26 oct, 9:00 a. m.". */
export function formatAppointment(iso: string, timeZone: string): string {
  return `${formatShortDate(localDate(iso, timeZone))}, ${formatTime(iso, timeZone)}`;
}

/** Costo de IA (millonésimas de dólar) → "US$12,40". */
export function formatAiCost(micros: number): string {
  return new Intl.NumberFormat("es-CR", { style: "currency", currency: "USD", currencyDisplay: "symbol", minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(micros / 1_000_000);
}

/** Porcentaje entero de una parte sobre el total ("—" si no hay total). */
export function formatPercent(part: number, total: number): string {
  if (!total) return "—";
  return `${Math.round((part / total) * 100)} %`;
}

export const formatInt = (n: number) => new Intl.NumberFormat("es-CR").format(n);
