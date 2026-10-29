// ─────────────────────────────────────────────────────────────────────────────
// Formato de montos según la moneda del negocio. Sin esto el backend armaba
// `${moneda}${monto.toLocaleString("es-CR")}` y el panel ponía "₡" fijo, así que un
// negocio en dólares o pesos veía colones o "USD15 000".
//
// La moneda llega como código ISO 4217 ("CRC", "USD") o como símbolo ("₡", "$"): se
// aceptan ambos. El símbolo se mapea a su código y el formato lo hace
// `Intl.NumberFormat` con el locale típico de esa moneda.
//
// Los montos de acá son en UNIDADES de la moneda (15000 = ₡15 000). El esquema nuevo
// guarda céntimos (`*_cents`, PLAN-GESTION.md §4): quien formatea divide antes.
//
// ⚠️ Copia gemela en web/src/lib/formato.ts (el panel es otro paquete y no importa de
// src/). test/unit/currency.test.ts verifica que las dos den lo mismo.
// ─────────────────────────────────────────────────────────────────────────────

/** Símbolos comunes → código ISO 4217. "$" solo es ambiguo: se toma como USD. */
const CODE_BY_SYMBOL: Record<string, string> = {
  "₡": "CRC",
  "$": "USD",
  "US$": "USD",
  "USD$": "USD",
  Q: "GTQ",
  "C$": "NIO",
  L: "HNL",
  "B/.": "PAB",
  "S/": "PEN",
  "S/.": "PEN",
  "RD$": "DOP",
  "€": "EUR",
  "MX$": "MXN",
  "COL$": "COP",
};

/** Locale con el que se formatea cada moneda (el del país que la usa). */
const LOCALE_BY_CODE: Record<string, string> = {
  CRC: "es-CR",
  USD: "es-US",
  MXN: "es-MX",
  GTQ: "es-GT",
  NIO: "es-NI",
  HNL: "es-HN",
  PAB: "es-PA",
  PEN: "es-PE",
  DOP: "es-DO",
  COP: "es-CO",
  CLP: "es-CL",
  ARS: "es-AR",
  UYU: "es-UY",
  PYG: "es-PY",
  BOB: "es-BO",
  VES: "es-VE",
  EUR: "es-ES",
};

/** Código ISO 4217 de la moneda ("₡" → "CRC", "usd" → "USD"), o null si no se reconoce. */
export function currencyCode(currency: string | null | undefined): string | null {
  const c = String(currency ?? "").trim();
  if (!c) return null;
  if (/^[A-Za-z]{3}$/.test(c)) return c.toUpperCase();
  return CODE_BY_SYMBOL[c] ?? null;
}

/** Locale para formatear una moneda (default "es": español neutro). */
export function currencyLocale(code: string): string {
  return LOCALE_BY_CODE[code] ?? "es";
}

function formatter(code: string, whole: boolean): Intl.NumberFormat | null {
  try {
    return new Intl.NumberFormat(currencyLocale(code), {
      style: "currency",
      currency: code,
      // Sin decimales si el monto es entero (así se cotiza casi siempre: "₡15 000",
      // "$1,500"); con 2 si trae centavos.
      minimumFractionDigits: whole ? 0 : 2,
      maximumFractionDigits: whole ? 0 : 2,
    });
  } catch {
    return null; // código de 3 letras que Intl no conoce
  }
}

/**
 * Monto formateado en la moneda del negocio: "₡15 000", "$1,500", "Q 250.50"… Si la
 * moneda no se reconoce, cae al texto configurado + número en español.
 */
export function formatAmount(amount: number, currency: string | null | undefined): string {
  const n = Number.isFinite(amount) ? amount : 0;
  const code = currencyCode(currency);
  const fmt = code ? formatter(code, Number.isInteger(n)) : null;
  if (fmt) return fmt.format(n);
  return `${String(currency ?? "").trim()}${n.toLocaleString("es")}`;
}

/** Símbolo de la moneda para prefijos de inputs ("₡", "$", "Q"…). */
export function currencySymbol(currency: string | null | undefined): string {
  const code = currencyCode(currency);
  const fmt = code ? formatter(code, true) : null;
  const symbol = fmt?.formatToParts(0).find((p) => p.type === "currency")?.value;
  return symbol ?? (String(currency ?? "").trim() || "₡");
}
