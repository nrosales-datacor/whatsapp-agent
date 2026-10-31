import { currencySymbol, formatCents } from "../../lib/money";

// ─────────────────────────────────────────────────────────────────────────────
// Formatos de Reportes e Inicio completo (es-CR).
// ─────────────────────────────────────────────────────────────────────────────

export const formatInt = (n: number): string => n.toLocaleString("es-CR");

/** Proporción (0–1) → "37,5 %"; sin base, "—". */
export function formatRate(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  return `${(Math.round(value * 1000) / 10).toLocaleString("es-CR")} %`;
}

/** Minutos → "12 h 30 min", "45 min" (se redondea al minuto antes de partir: 119,7 → "2 h"). */
export function formatMinutes(minutes: number): string {
  const total = Math.round(minutes);
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h === 0) return `${m} min`;
  return m === 0 ? `${formatInt(h)} h` : `${formatInt(h)} h ${m} min`;
}

/**
 * Monto compacto para el eje: "₡1,2 M", "₡350 k", "₡900", "-₡350 k". El signo va antes del
 * símbolo, como en `formatCents`, y la escala se elige con el valor ya redondeado (₡999 950
 * es "₡1 M", no "₡1 000 k").
 */
export function compactCents(cents: number, currency: string): string {
  const units = cents / 100;
  const abs = Math.abs(units);
  const sign = units < 0 && Math.round(abs) > 0 ? "-" : "";
  const symbol = currencySymbol(currency);
  const oneDecimal = (n: number) => n.toLocaleString("es-CR", { maximumFractionDigits: 1 });
  if (Math.round(abs / 100) >= 10_000) return `${sign}${symbol}${oneDecimal(abs / 1_000_000)} M`;
  if (Math.round(abs) >= 1_000) return `${sign}${symbol}${oneDecimal(abs / 1_000)} k`;
  return sign + formatCents(Math.round(abs) * 100, currency);
}

/** Variación contra el período anterior: "+12 % vs. período anterior", o null sin base. */
export function deltaText(current: number, previous: number): string | null {
  if (previous === 0) return current === 0 ? null : "Sin datos del período anterior";
  const pct = Math.round(((current - previous) / Math.abs(previous)) * 100);
  return `${pct > 0 ? "+" : ""}${pct.toLocaleString("es-CR")} % vs. período anterior`;
}

/** "1 oct – 30 oct 2026" (días locales, inclusive). */
export function rangeLabel(from: string, to: string): string {
  const fmt = (d: string, withYear: boolean) => {
    const [y, m, day] = d.split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, day))
      .toLocaleDateString("es-CR", { day: "numeric", month: "short", ...(withYear ? { year: "numeric" } : {}), timeZone: "UTC" })
      .replace(".", "");
  };
  return from === to ? fmt(from, true) : `${fmt(from, from.slice(0, 4) !== to.slice(0, 4))} – ${fmt(to, true)}`;
}
