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

/** Minutos → "12 h 30 min", "45 min". */
export function formatMinutes(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  if (h === 0) return `${m} min`;
  return m === 0 ? `${formatInt(h)} h` : `${formatInt(h)} h ${m} min`;
}

/** Monto compacto para el eje: "₡1,2 M", "₡350 k", "₡900". */
export function compactCents(cents: number, currency: string): string {
  const units = cents / 100;
  const abs = Math.abs(units);
  const symbol = currencySymbol(currency);
  if (abs >= 1_000_000) return `${symbol}${(units / 1_000_000).toLocaleString("es-CR", { maximumFractionDigits: 1 })} M`;
  if (abs >= 1_000) return `${symbol}${(units / 1_000).toLocaleString("es-CR", { maximumFractionDigits: 1 })} k`;
  return formatCents(Math.round(units) * 100, currency);
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
