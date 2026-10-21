// ─────────────────────────────────────────────────────────────────────────────
// Fechas en la zona del negocio o de la sucursal (no la del navegador): las ausencias
// viajan como instantes (ISO 8601 con zona) y la persona las escribe y las lee en hora
// local del negocio. Solo Intl, sin dependencias.
// ─────────────────────────────────────────────────────────────────────────────

interface WallParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

function wallParts(utcMs: number, timeZone: string): WallParts {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(new Date(utcMs));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? "0");
  return { year: get("year"), month: get("month"), day: get("day"), hour: get("hour") % 24, minute: get("minute") };
}

function offsetMs(utcMs: number, timeZone: string): number {
  const p = wallParts(utcMs, timeZone);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - Math.floor(utcMs / 60_000) * 60_000;
}

/** "2026-12-24" + "08:30" en `timeZone` → ISO 8601 en UTC. */
export function zonedToIso(date: string, time: string, timeZone: string): string {
  const [y, m, d] = date.split("-").map(Number);
  const [h, min] = time.split(":").map(Number);
  const wall = Date.UTC(y, m - 1, d, h, min);
  // Dos pasadas: la segunda corrige si el offset cambia justo en ese día (horario de verano).
  let utc = wall - offsetMs(wall, timeZone);
  utc = wall - offsetMs(utc, timeZone);
  return new Date(utc).toISOString();
}

const pad = (n: number) => String(n).padStart(2, "0");

/** ISO → fecha y hora locales de `timeZone` ("2026-12-24", "08:30"). */
export function isoToZoned(iso: string, timeZone: string): { date: string; time: string } {
  const p = wallParts(new Date(iso).getTime(), timeZone);
  return { date: `${p.year}-${pad(p.month)}-${pad(p.day)}`, time: `${pad(p.hour)}:${pad(p.minute)}` };
}

/** "2026-12-24" + n días. */
export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

/** Fecha corta legible en `timeZone` ("jue 24 dic 2026"). */
export function formatDate(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("es-CR", { timeZone, weekday: "short", day: "numeric", month: "short", year: "numeric" }).format(new Date(iso));
}

/** Fecha y hora legibles en `timeZone` ("jue 24 dic 2026, 08:30"). */
export function formatDateTime(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("es-CR", {
    timeZone,
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(iso));
}

/** ¿El rango son días completos en `timeZone`? (empieza y termina a las 00:00). */
export function isAllDay(startsAt: string, endsAt: string, timeZone: string): boolean {
  return isoToZoned(startsAt, timeZone).time === "00:00" && isoToZoned(endsAt, timeZone).time === "00:00";
}

/** Rango legible: días completos ("24 dic – 25 dic") o con hora. El fin de un día completo es exclusivo. */
export function formatRange(startsAt: string, endsAt: string, timeZone: string): string {
  if (isAllDay(startsAt, endsAt, timeZone)) {
    const lastDay = zonedToIso(addDays(isoToZoned(endsAt, timeZone).date, -1), "12:00", timeZone);
    const first = formatDate(startsAt, timeZone);
    const last = formatDate(lastDay, timeZone);
    return first === last ? `${first} (todo el día)` : `${first} – ${last}`;
  }
  return `${formatDateTime(startsAt, timeZone)} – ${formatDateTime(endsAt, timeZone)}`;
}
