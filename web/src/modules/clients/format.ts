import { capitalize } from "../../app/navigation";
import type { Terminology } from "../../lib/contract";

// ─────────────────────────────────────────────────────────────────────────────
// Formatos de la sección Clientes: teléfono legible, fechas en la zona del negocio y el
// nombre a mostrar de un cliente con los datos eliminados.
// ─────────────────────────────────────────────────────────────────────────────

/** "+50688887777" → "+506 8888 7777"; "+13055550100" → "+1 305 555 0100"; el resto, tal cual. */
export function formatPhone(e164: string | null | undefined): string {
  if (!e164) return "";
  const cr = /^\+(50\d)(\d{4})(\d{4})$/.exec(e164);
  if (cr) return `+${cr[1]} ${cr[2]} ${cr[3]}`;
  const nanp = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164);
  if (nanp) return `+1 ${nanp[1]} ${nanp[2]} ${nanp[3]}`;
  return e164;
}

/** Instante ISO → "17 oct 2026" en la zona horaria del negocio. */
export function formatDay(iso: string | null | undefined, timeZone?: string): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  try {
    return date.toLocaleDateString("es-CR", { day: "numeric", month: "short", year: "numeric", timeZone });
  } catch {
    return date.toLocaleDateString("es-CR", { day: "numeric", month: "short", year: "numeric" });
  }
}

/** Fecha sin hora "AAAA-MM-DD" → "17 may 1990" (sin correrse de día por la zona horaria). */
export function formatDateOnly(value: string | null | undefined): string {
  if (!value) return "";
  const [y, m, d] = value.split("-").map(Number);
  if (!y || !m || !d) return value;
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("es-CR", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

/** Nombre a mostrar: un cliente con los datos eliminados dice "Paciente eliminado" según el rubro. */
export function displayName(client: { name: string; anonymized?: boolean }, t: Terminology): string {
  return client.anonymized ? `${capitalize(t.client)} eliminado` : client.name;
}

const digits = (text: string) => text.replace(/\D/g, "");

/**
 * ¿Lo que escribió la persona es este teléfono? Vale el número completo o sin el código de
 * país ("8888 7777" para "+50688887777"). El backend lo vuelve a verificar.
 */
export function phoneMatches(typed: string, e164: string): boolean {
  const t = digits(typed);
  const full = digits(e164);
  return t.length >= 7 && full.endsWith(t) && full.length - t.length <= 3;
}

/** Iniciales para el avatar de la ficha ("María Fernández" → "MF"). */
export function clientInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const letters = parts.length > 1 ? [parts[0], parts[parts.length - 1]] : parts;
  return letters.map((p) => p.charAt(0).toLocaleUpperCase("es")).join("") || "?";
}
