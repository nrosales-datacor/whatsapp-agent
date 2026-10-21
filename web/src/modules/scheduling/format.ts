import { isoToZoned, zonedToIso } from "../settings/zonedTime";
import type { AppointmentChannel, AppointmentStatus } from "./schedulingApi";

// ─────────────────────────────────────────────────────────────────────────────
// Formatos de la Agenda, siempre en la zona horaria de la SUCURSAL (no la del navegador).
// ─────────────────────────────────────────────────────────────────────────────

export const STATUS_LABEL: Record<AppointmentStatus, string> = {
  pending: "Sin confirmar",
  confirmed: "Confirmada",
  completed: "Completada",
  cancelled: "Cancelada",
  no_show: "No asistió",
};

export const CHANNEL_LABEL: Record<AppointmentChannel, string> = {
  whatsapp_ai: "Agente de WhatsApp",
  panel: "Panel",
  phone: "Teléfono",
  walk_in: "Llegó sin cita",
  web: "Reserva web",
};

export const isActive = (status: AppointmentStatus) => status === "pending" || status === "confirmed";

/** Día local de hoy en `timeZone` ("AAAA-MM-DD"). */
export function todayIn(timeZone: string): string {
  return isoToZoned(new Date().toISOString(), timeZone).date;
}

/** Hora local legible: "9:00 a. m.". */
export function formatTime(iso: string, timeZone: string): string {
  try {
    return new Date(iso).toLocaleTimeString("es-CR", { hour: "numeric", minute: "2-digit", timeZone });
  } catch {
    return isoToZoned(iso, "UTC").time;
  }
}

/** "AAAA-MM-DD" → "lunes 26 de octubre" (sin correrse de día). */
export function formatLongDate(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("es-CR", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });
}

/** "AAAA-MM-DD" → "lun 26 oct". */
export function formatShortDate(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("es-CR", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
}

/** Fecha y hora de una cita: "lun 26 oct, 9:00 a. m.". */
export function formatWhen(iso: string, timeZone: string): string {
  return `${formatShortDate(isoToZoned(iso, timeZone).date)}, ${formatTime(iso, timeZone)}`;
}

/** Minutos desde la medianoche local de un instante. */
export function minuteOfDay(iso: string, timeZone: string): number {
  const { time } = isoToZoned(iso, timeZone);
  return Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
}

/** [inicio, fin) del día local como ISO (para pedir las citas del día). */
export function dayRange(date: string, timeZone: string, days = 1): { from: string; to: string } {
  const [y, m, d] = date.split("-").map(Number);
  const next = new Date(Date.UTC(y, m - 1, d + days));
  const nextDate = `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, "0")}-${String(next.getUTCDate()).padStart(2, "0")}`;
  return { from: zonedToIso(date, "00:00", timeZone), to: zonedToIso(nextDate, "00:00", timeZone) };
}

/** Duración legible: 75 → "1 h 15 min". */
export function formatMinutes(total: number): string {
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h && m) return `${h} h ${m} min`;
  return h ? `${h} h` : `${m} min`;
}
