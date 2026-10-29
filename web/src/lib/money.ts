// ─────────────────────────────────────────────────────────────────────────────
// Montos en la moneda del negocio (`me.business.currency`): "₡15 000", "$1,500"…
//
// ⚠️ Copia gemela de src/platform/money/currency.ts (el panel es otro paquete y no importa
// de src/). test/unit/currency.test.ts verifica que las dos den exactamente lo mismo; si
// cambiás una, cambiá la otra. Portada de legacy/web/src/lib/formato.ts.
//
// Los montos son en UNIDADES de la moneda (15000 = ₡15 000). La API nueva manda céntimos
// (`*_cents`, PLAN-GESTION.md §4): quien formatea divide antes.
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

function formatter(code: string, whole: boolean): Intl.NumberFormat | null {
  try {
    return new Intl.NumberFormat(LOCALE_BY_CODE[code] ?? "es", {
      style: "currency",
      currency: code,
      // Sin decimales si el monto es entero ("₡15 000"); con 2 si trae centavos.
      minimumFractionDigits: whole ? 0 : 2,
      maximumFractionDigits: whole ? 0 : 2,
    });
  } catch {
    return null; // código de 3 letras que Intl no conoce
  }
}

/** Monto formateado en la moneda del negocio. Moneda no reconocida: el texto configurado + número. */
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
