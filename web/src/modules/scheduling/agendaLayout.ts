// ─────────────────────────────────────────────────────────────────────────────
// Geometría de la Agenda (lógica pura, sin React ni imports, para poder probarla desde el
// backend: test/unit/agendaLayout.test.ts): el rango de horas de la rejilla según el
// horario de la sucursal, las ventanas en que trabaja cada profesional y cómo se reparten
// en columnas las citas que se pisan dentro de un mismo carril (p. ej. una cancelada y la
// que tomó su lugar).
// ─────────────────────────────────────────────────────────────────────────────

export interface DayBlock {
  weekday: number;
  /** "HH:MM" local. */
  start: string;
  /** "HH:MM" local (hasta "24:00"). */
  end: string;
}

export interface Span {
  startMin: number;
  endMin: number;
}

/** Rejilla de un día sin horario (cerrado): igual se muestra algo razonable. */
export const DEFAULT_GRID: Span = { startMin: 8 * 60, endMin: 18 * 60 };

export function minutesOf(time: string): number {
  const [h, m] = time.split(":");
  return Number(h) * 60 + Number(m);
}

/** 570 → "09:30". */
export function hhmm(minutes: number): string {
  const m = ((Math.round(minutes) % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

/** "AAAA-MM-DD" + n días. */
export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, "0")}-${String(t.getUTCDate()).padStart(2, "0")}`;
}

/** Día de la semana de una fecha local (0 = domingo). */
export function weekdayOf(date: string): number {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** Lunes a domingo de la semana de `date`. */
export function weekDates(date: string): string[] {
  const monday = addDays(date, -((weekdayOf(date) + 6) % 7));
  return Array.from({ length: 7 }, (_, i) => addDays(monday, i));
}

/**
 * Rango de la rejilla de un día: de la apertura más temprana al cierre más tarde de la
 * sucursal (redondeado a horas enteras), estirado para que entren las citas que haya.
 */
export function gridRange(locationHours: readonly DayBlock[], weekday: number, items: readonly Span[] = []): Span {
  const today = locationHours.filter((h) => h.weekday === weekday);
  let start = today.length ? Math.min(...today.map((h) => minutesOf(h.start))) : DEFAULT_GRID.startMin;
  let end = today.length ? Math.max(...today.map((h) => minutesOf(h.end))) : DEFAULT_GRID.endMin;
  for (const it of items) {
    start = Math.min(start, it.startMin);
    end = Math.max(end, it.endMin);
  }
  start = Math.max(0, Math.floor(start / 60) * 60);
  end = Math.min(24 * 60, Math.ceil(end / 60) * 60);
  if (end - start < 60) end = Math.min(24 * 60, start + 60);
  return { startMin: start, endMin: end };
}

/** Ventanas en que trabaja un profesional ese día: su horario ∩ el de la sucursal. */
export function workingWindows(locationHours: readonly DayBlock[], staffHours: readonly DayBlock[], weekday: number): Span[] {
  const out: Span[] = [];
  for (const a of locationHours.filter((h) => h.weekday === weekday)) {
    for (const b of staffHours.filter((h) => h.weekday === weekday)) {
      const startMin = Math.max(minutesOf(a.start), minutesOf(b.start));
      const endMin = Math.min(minutesOf(a.end), minutesOf(b.end));
      if (endMin > startMin) out.push({ startMin, endMin });
    }
  }
  return out.sort((x, y) => x.startMin - y.startMin);
}

/**
 * Reparte en columnas las citas que se pisan (dentro de un carril): cada grupo de citas
 * encadenadas por solapes usa tantas columnas como su máximo de citas simultáneas.
 */
export function layoutColumns<T extends Span>(items: readonly T[]): Array<T & { column: number; columns: number }> {
  const sorted = [...items].sort((a, b) => a.startMin - b.startMin || b.endMin - a.endMin);
  const out: Array<T & { column: number; columns: number }> = [];
  let group: Array<T & { column: number; columns: number }> = [];
  let groupEnd = -1;
  const flush = () => {
    const columns = group.reduce((n, it) => Math.max(n, it.column + 1), 1);
    for (const it of group) it.columns = columns;
    out.push(...group);
    group = [];
  };
  for (const item of sorted) {
    if (group.length > 0 && item.startMin >= groupEnd) flush();
    const taken = new Set(group.filter((g) => g.endMin > item.startMin).map((g) => g.column));
    let column = 0;
    while (taken.has(column)) column++;
    group.push({ ...item, column, columns: 1 });
    groupEnd = Math.max(groupEnd, item.endMin);
  }
  if (group.length > 0) flush();
  return out;
}
