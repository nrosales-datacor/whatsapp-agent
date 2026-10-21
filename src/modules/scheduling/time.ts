// ─────────────────────────────────────────────────────────────────────────────
// Fechas y horas en la zona horaria de la SUCURSAL (nunca la del servidor ni la del
// navegador). La agenda piensa en "día local" (AAAA-MM-DD) y "minuto del día" (0–1440) de
// la sucursal; la base guarda instantes (`timestamptz`). Estas funciones convierten entre
// las dos cosas solo con Intl (sin dependencias), cuidando el cambio de horario de verano:
// la conversión hora local → instante corrige el offset en dos pasadas.
// ─────────────────────────────────────────────────────────────────────────────

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;
const RE_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Partes del reloj de pared de un instante en una zona. */
export interface WallClock {
  /** "AAAA-MM-DD". */
  date: string;
  /** Minutos desde la medianoche local (0–1439). */
  minute: number;
  /** 0 = domingo … 6 = sábado. */
  weekday: number;
}

// Construir un Intl.DateTimeFormat cuesta: uno por zona, reutilizado.
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
    formatters.set(timeZone, f);
  }
  return f;
}

function parts(ms: number, timeZone: string): { y: number; mo: number; d: number; h: number; mi: number } {
  const out = { y: 0, mo: 0, d: 0, h: 0, mi: 0 };
  for (const p of formatterFor(timeZone).formatToParts(new Date(ms))) {
    if (p.type === "year") out.y = Number(p.value);
    else if (p.type === "month") out.mo = Number(p.value);
    else if (p.type === "day") out.d = Number(p.value);
    else if (p.type === "hour") out.h = Number(p.value) % 24; // algunas versiones de ICU dan "24"
    else if (p.type === "minute") out.mi = Number(p.value);
  }
  return out;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** ¿Es una zona IANA que Intl conoce? */
export function isKnownTimeZone(timeZone: string): boolean {
  try {
    formatterFor(timeZone);
    return true;
  } catch {
    return false;
  }
}

/** ¿"AAAA-MM-DD" válido (fecha que existe)? */
export function isLocalDate(value: string): boolean {
  const m = RE_DATE.exec(value);
  if (!m) return false;
  const t = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return t.getUTCFullYear() === Number(m[1]) && t.getUTCMonth() === Number(m[2]) - 1 && t.getUTCDate() === Number(m[3]);
}

/** Reloj de pared de `instant` en `timeZone`. */
export function wallClock(instant: Date, timeZone: string): WallClock {
  const p = parts(instant.getTime(), timeZone);
  const date = `${p.y}-${pad(p.mo)}-${pad(p.d)}`;
  return { date, minute: p.h * 60 + p.mi, weekday: weekdayOf(date) };
}

/** Día local ("AAAA-MM-DD") de un instante en una zona. */
export function localDate(instant: Date, timeZone: string): string {
  return wallClock(instant, timeZone).date;
}

/** Día de la semana de una fecha local (0 = domingo). Aritmética UTC: no depende de zona. */
export function weekdayOf(date: string): number {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** "AAAA-MM-DD" + n días. */
export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

/** Offset de la zona en un instante (ms que hay que sumarle al UTC para leer la hora local). */
function offsetMs(ms: number, timeZone: string): number {
  const p = parts(ms, timeZone);
  return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi) - Math.floor(ms / MINUTE_MS) * MINUTE_MS;
}

/**
 * Instante de la hora local `minute` (minutos desde la medianoche; 1440 = la medianoche
 * siguiente) del día `date` en `timeZone`. Dos pasadas: la segunda corrige si el offset
 * cambia justo ese día (horario de verano). Una hora que no existe (el salto de la
 * primavera) cae en la hora siguiente, como hacen los relojes.
 */
export function zonedInstant(date: string, minute: number, timeZone: string): Date {
  const [y, m, d] = date.split("-").map(Number);
  const wall = Date.UTC(y, m - 1, d, 0, minute);
  let utc = wall - offsetMs(wall, timeZone);
  utc = wall - offsetMs(utc, timeZone);
  return new Date(utc);
}

/** [inicio, fin) del día local `date` en `timeZone`, como instantes. */
export function localDayBounds(date: string, timeZone: string): { start: Date; end: Date } {
  return { start: zonedInstant(date, 0, timeZone), end: zonedInstant(addDays(date, 1), 0, timeZone) };
}

/** Lunes (día local) de la semana de `date`. */
export function mondayOf(date: string): string {
  return addDays(date, -((weekdayOf(date) + 6) % 7));
}

/** Días locales que toca [from, to) en `timeZone`, en orden. */
export function localDatesBetween(from: Date, to: Date, timeZone: string): string[] {
  if (to.getTime() <= from.getTime()) return [];
  const last = localDate(new Date(to.getTime() - 1), timeZone);
  const out: string[] = [];
  for (let date = localDate(from, timeZone); date <= last && out.length < 400; date = addDays(date, 1)) out.push(date);
  return out;
}

export const minutes = (n: number) => n * MINUTE_MS;
export { DAY_MS, MINUTE_MS };
