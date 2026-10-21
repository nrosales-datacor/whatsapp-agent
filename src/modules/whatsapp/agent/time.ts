// ─────────────────────────────────────────────────────────────────────────────
// Fechas para el agente, en la zona de la sucursal o del negocio (nunca la del servidor).
// El modelo habla en "AAAA-MM-DD" y "HH:MM" locales; los servicios del núcleo reciben
// instantes. Solo Intl, con la corrección de dos pasadas para el horario de verano (misma
// regla que scheduling, que no expone estas utilidades en su API).
// ─────────────────────────────────────────────────────────────────────────────

const MINUTE_MS = 60_000;
export const DAY_MS = 24 * 60 * MINUTE_MS;
const RE_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const RE_TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

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
    else if (p.type === "hour") out.h = Number(p.value) % 24;
    else if (p.type === "minute") out.mi = Number(p.value);
  }
  return out;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** ¿"AAAA-MM-DD" válido (fecha que existe)? */
export function isLocalDate(value: string): boolean {
  const m = RE_DATE.exec(value);
  if (!m) return false;
  const t = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return t.getUTCFullYear() === Number(m[1]) && t.getUTCMonth() === Number(m[2]) - 1 && t.getUTCDate() === Number(m[3]);
}

/** ¿"HH:MM" de 24 h válido? */
export function isLocalTime(value: string): boolean {
  return RE_TIME.test(value);
}

/** Día local ("AAAA-MM-DD") de un instante. */
export function localDate(instant: Date, timeZone: string): string {
  const p = parts(instant.getTime(), timeZone);
  return `${p.y}-${pad(p.mo)}-${pad(p.d)}`;
}

/** Hora local ("HH:MM") de un instante. */
export function localTime(instant: Date, timeZone: string): string {
  const p = parts(instant.getTime(), timeZone);
  return `${pad(p.h)}:${pad(p.mi)}`;
}

/** "AAAA-MM-DD" + n días. */
export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

/** Días calendario entre dos fechas locales (b − a). */
export function daysBetween(a: string, b: string): number {
  const [ya, ma, da] = a.split("-").map(Number);
  const [yb, mb, db] = b.split("-").map(Number);
  return Math.round((Date.UTC(yb, mb - 1, db) - Date.UTC(ya, ma - 1, da)) / DAY_MS);
}

function offsetMs(ms: number, timeZone: string): number {
  const p = parts(ms, timeZone);
  return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi) - Math.floor(ms / MINUTE_MS) * MINUTE_MS;
}

/** Instante de la hora local "HH:MM" (o minutos desde la medianoche) del día `date` en la zona. */
export function zonedInstant(date: string, time: string | number, timeZone: string): Date {
  const minute = typeof time === "number" ? time : Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
  const [y, m, d] = date.split("-").map(Number);
  const wall = Date.UTC(y, m - 1, d, 0, minute);
  let utc = wall - offsetMs(wall, timeZone);
  utc = wall - offsetMs(utc, timeZone);
  return new Date(utc);
}

/** [inicio, fin) del día local como instantes. */
export function localDayRange(date: string, timeZone: string): { from: Date; to: Date } {
  return { from: zonedInstant(date, 0, timeZone), to: zonedInstant(addDays(date, 1), 0, timeZone) };
}

/** "miércoles 22 de octubre" de una fecha local (aritmética UTC: no depende de la zona). */
export function readableDate(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Intl.DateTimeFormat("es-CR", { timeZone: "UTC", weekday: "long", day: "numeric", month: "long" })
    .format(new Date(Date.UTC(y, m - 1, d, 12)))
    .replace(",", "");
}

/** "mié 22" de una fecha local (para títulos de botones, ≤ 20 caracteres). */
export function shortDate(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  const weekday = new Intl.DateTimeFormat("es-CR", { timeZone: "UTC", weekday: "short" })
    .format(new Date(Date.UTC(y, m - 1, d, 12)))
    .replace(/\.$/, "");
  return `${weekday} ${d}`;
}

const WEEKDAYS = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];

/** Nombre del día de la semana (0 = domingo). */
export function weekdayName(weekday: number): string {
  return WEEKDAYS[weekday] ?? String(weekday);
}
