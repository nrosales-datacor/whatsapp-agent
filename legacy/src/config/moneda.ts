// ─────────────────────────────────────────────────────────────────────────────
// Formato de montos según la moneda del negocio (E11). Antes el backend armaba
// `${tenant.moneda}${monto.toLocaleString("es-CR")}` y el panel ponía "₡" fijo, así
// que un negocio en dólares o pesos veía colones o "USD15 000".
//
// `tenant.moneda` es texto libre histórico: el alta sugería el SÍMBOLO ("₡") y los
// tests/fixtures usan el código ISO ("CRC"). Se aceptan ambos: el símbolo se mapea a
// su código ISO 4217 y el formato lo hace `Intl.NumberFormat` con el locale típico de
// esa moneda. Con "₡"/"CRC" el resultado es idéntico al de antes ("₡15 000").
//
// ⚠️ Copia gemela en web/src/lib/formato.ts (el panel es otro paquete y no importa de
// src/). test/unit/moneda.test.ts verifica que las dos den lo mismo.
// ─────────────────────────────────────────────────────────────────────────────

/** Símbolos comunes → código ISO 4217. "$" solo es ambiguo: se toma como USD. */
const CODIGO_POR_SIMBOLO: Record<string, string> = {
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
const LOCALE_POR_CODIGO: Record<string, string> = {
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

/** Código ISO 4217 de la moneda del tenant ("₡" → "CRC", "usd" → "USD"), o null si no se reconoce. */
export function codigoMoneda(moneda: string | null | undefined): string | null {
  const m = String(moneda ?? "").trim();
  if (!m) return null;
  if (/^[A-Za-z]{3}$/.test(m)) return m.toUpperCase();
  return CODIGO_POR_SIMBOLO[m] ?? null;
}

/** Locale para formatear una moneda (default "es": español neutro). */
export function localeDeMoneda(codigo: string): string {
  return LOCALE_POR_CODIGO[codigo] ?? "es";
}

function formateador(codigo: string, entero: boolean): Intl.NumberFormat | null {
  try {
    return new Intl.NumberFormat(localeDeMoneda(codigo), {
      style: "currency",
      currency: codigo,
      // Sin decimales si el monto es entero (así se cotiza casi siempre: "₡15 000",
      // "$1,500"); con 2 si trae centavos.
      minimumFractionDigits: entero ? 0 : 2,
      maximumFractionDigits: entero ? 0 : 2,
    });
  } catch {
    return null; // código de 3 letras que Intl no conoce
  }
}

/**
 * Monto formateado en la moneda del negocio: "₡15 000", "$1,500", "Q 250.50"…
 * Si la moneda no se reconoce, cae al texto configurado + número en español.
 */
export function formatearMonto(monto: number, moneda: string | null | undefined): string {
  const n = Number.isFinite(monto) ? monto : 0;
  const codigo = codigoMoneda(moneda);
  const fmt = codigo ? formateador(codigo, Number.isInteger(n)) : null;
  if (fmt) return fmt.format(n);
  return `${String(moneda ?? "").trim()}${n.toLocaleString("es")}`;
}

/** Símbolo de la moneda para prefijos de inputs ("₡", "$", "Q"…). */
export function simboloMoneda(moneda: string | null | undefined): string {
  const codigo = codigoMoneda(moneda);
  const fmt = codigo ? formateador(codigo, true) : null;
  const simbolo = fmt?.formatToParts(0).find((p) => p.type === "currency")?.value;
  return simbolo ?? (String(moneda ?? "").trim() || "₡");
}
