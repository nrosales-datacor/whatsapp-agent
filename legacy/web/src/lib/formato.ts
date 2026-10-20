// Helpers de formato del panel (es-CR; los montos, en la moneda del negocio). React escapa el texto solo, así que acá
// NO hace falta el `esc()` que tenía el inbox.html (concatenaba HTML a mano).

/** Hora local "HH:mm" a partir de un ISO; "" si no hay fecha. */
export function hora(iso: string | null | undefined): string {
  return iso ? new Date(iso).toLocaleTimeString("es-CR", { hour: "2-digit", minute: "2-digit" }) : "";
}

function pad2(n: number): string {
  return n < 10 ? "0" + n : String(n);
}

/**
 * Fecha en formato dd/mm/yyyy fijo (no depende del locale del navegador); "—" si no
 * hay fecha o es inválida. Un string "YYYY-MM-DD" puro (sin hora, ej. `Cita.fecha`)
 * se interpreta en UTC para no correr un día por el offset de zona horaria del
 * cliente; un ISO con hora se interpreta en la zona local, como corresponde a un
 * instante real.
 */
export function fechaCorta(iso: string | null | undefined): string {
  if (!iso) return "—";
  const soloFecha = /^\d{4}-\d{2}-\d{2}$/.test(iso);
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const dia = soloFecha ? d.getUTCDate() : d.getDate();
  const mes = (soloFecha ? d.getUTCMonth() : d.getMonth()) + 1;
  const anio = soloFecha ? d.getUTCFullYear() : d.getFullYear();
  return `${pad2(dia)}/${pad2(mes)}/${anio}`;
}

/** Fecha dd/mm/yyyy + hora "HH:mm" a partir de un ISO; "—" si no hay fecha. */
export function fechaHora(iso: string | null | undefined): string {
  if (!iso) return "—";
  return `${fechaCorta(iso)} ${hora(iso)}`;
}

/** Número de WhatsApp (E.164 sin "+") a formato visible. */
export function fmtNum(wa: string): string {
  return "+" + wa;
}

// ── Montos en la moneda del negocio (E11) ──
// ⚠️ Copia gemela de src/config/moneda.ts (el panel es otro paquete y no importa de
// src/). test/unit/moneda.test.ts verifica que las dos den exactamente lo mismo; si
// cambiás una, cambiá la otra.

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

/** Código ISO 4217 de la moneda del negocio ("₡" → "CRC", "usd" → "USD"), o null si no se reconoce. */
export function codigoMoneda(moneda: string | null | undefined): string | null {
  const m = String(moneda ?? "").trim();
  if (!m) return null;
  if (/^[A-Za-z]{3}$/.test(m)) return m.toUpperCase();
  return CODIGO_POR_SIMBOLO[m] ?? null;
}

function formateador(codigo: string, entero: boolean): Intl.NumberFormat | null {
  try {
    return new Intl.NumberFormat(LOCALE_POR_CODIGO[codigo] ?? "es", {
      style: "currency",
      currency: codigo,
      minimumFractionDigits: entero ? 0 : 2,
      maximumFractionDigits: entero ? 0 : 2,
    });
  } catch {
    return null;
  }
}

/**
 * Monto en la moneda del negocio ("₡15 000", "$1,500"…). Sin moneda (backend viejo
 * que no la manda en /me) cae a colones, el comportamiento previo del panel.
 */
export function monto(n: number, moneda: string | null | undefined = "₡"): string {
  const v = Number.isFinite(n) ? n : 0;
  const codigo = codigoMoneda(moneda);
  const fmt = codigo ? formateador(codigo, Number.isInteger(v)) : null;
  if (fmt) return fmt.format(v);
  return `${String(moneda ?? "").trim()}${v.toLocaleString("es")}`;
}

/** Símbolo de la moneda para el prefijo de los inputs de precio ("₡", "$", "Q"…). */
export function simboloMoneda(moneda: string | null | undefined = "₡"): string {
  const codigo = codigoMoneda(moneda);
  const fmt = codigo ? formateador(codigo, true) : null;
  const simbolo = fmt?.formatToParts(0).find((p) => p.type === "currency")?.value;
  return simbolo ?? (String(moneda ?? "").trim() || "₡");
}

/** Tiempo restante hasta un ISO futuro, "Xh Ym" o "Ym" (ventana de 24h, Carril D 0.3). "" si no hay fecha. */
export function restante(iso: string | null | undefined): string {
  if (!iso) return "";
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return "0m";
  const horas = Math.floor(ms / (60 * 60 * 1000));
  const minutos = Math.floor((ms % (60 * 60 * 1000)) / (60 * 1000));
  return horas > 0 ? `${horas}h ${minutos}m` : `${minutos}m`;
}

/** Tiempo transcurrido desde un ISO pasado, "Xh Ym" o "Ym" (bandeja: "Sin responder hace…"). "" si no hay fecha. */
export function transcurrido(iso: string | null | undefined): string {
  if (!iso) return "";
  const ms = Date.now() - new Date(iso).getTime();
  if (ms <= 0) return "0m";
  const horas = Math.floor(ms / (60 * 60 * 1000));
  const minutos = Math.floor((ms % (60 * 60 * 1000)) / (60 * 1000));
  return horas > 0 ? `${horas}h ${minutos}m` : `${minutos}m`;
}

/** Iniciales del nombre del negocio para el chip de marca sin logo (máx. 2 letras). */
export function iniciales(nombre: string): string {
  const palabras = nombre.trim().split(/\s+/).filter(Boolean);
  if (palabras.length === 0) return "";
  if (palabras.length === 1) return palabras[0].slice(0, 2).toUpperCase();
  return (palabras[0][0] + palabras[1][0]).toUpperCase();
}
