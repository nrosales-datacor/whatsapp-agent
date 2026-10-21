import { z } from "zod";

// ─────────────────────────────────────────────────────────────────────────────
// Horarios semanales (PLAN-GESTION.md §4: `weekday` + `time`): la forma única con la que
// la API y la API pública hablan de horarios, tanto de una sucursal (location_hours) como
// de un profesional por sucursal (staff_hours, módulo team).
//
//   • Un tramo es `{ weekday, start, end }`: día 0 = domingo … 6 = sábado (Date#getDay),
//     horas LOCALES de la sucursal en "HH:MM", intervalo [start, end).
//   • Varios tramos el mismo día = turnos con descanso (09:00–12:00 y 13:00–18:00). Sin
//     tramos un día = cerrado / no trabaja.
//   • Reglas: `end` después de `start`; los tramos del mismo día no se cruzan (pegados sí:
//     12:00–13:00 y 13:00–14:00); a lo sumo MAX_BLOCKS_PER_DAY por día. `end` puede ser
//     "24:00" (abierto hasta medianoche); `start` no.
// ─────────────────────────────────────────────────────────────────────────────

/** Tramo de un horario semanal (horas locales de la sucursal, [start, end)). */
export interface WeeklyBlock {
  /** 0 = domingo … 6 = sábado. */
  weekday: number;
  /** "HH:MM". */
  start: string;
  /** "HH:MM" (hasta "24:00"). */
  end: string;
}

export const MAX_BLOCKS_PER_DAY = 6;
const MAX_BLOCKS = MAX_BLOCKS_PER_DAY * 7;

const RE_START = /^([01]\d|2[0-3]):[0-5]\d$/;
const RE_END = /^(([01]\d|2[0-3]):[0-5]\d|24:00)$/;

/** Minutos desde la medianoche de "HH:MM" o "HH:MM:SS" (lo que devuelve una columna `time`). */
export function minutesOfDay(time: string): number {
  const [h, m] = time.split(":");
  return Number(h) * 60 + Number(m);
}

/** "09:00:00" (columna `time`) → "09:00". */
export function fromDbTime(time: string): string {
  return time.slice(0, 5);
}

const StartTime = z.string().regex(RE_START, "Hora inválida (formato HH:MM).");
const EndTime = z.string().regex(RE_END, "Hora inválida (formato HH:MM).");

export const WeeklyBlockSchema = z.object({
  weekday: z.int().min(0).max(6),
  start: StartTime,
  end: EndTime,
});

function isWellFormed(b: unknown): b is WeeklyBlock {
  const x = b as Partial<WeeklyBlock> | null;
  return (
    typeof x === "object" &&
    x !== null &&
    Number.isInteger(x.weekday) &&
    typeof x.start === "string" &&
    RE_START.test(x.start) &&
    typeof x.end === "string" &&
    RE_END.test(x.end)
  );
}

interface IssueSink {
  addIssue(issue: { code: "custom"; message: string; path: (string | number)[] }): void;
}

/**
 * Reglas de un horario semanal sobre una lista de tramos ya validados uno por uno:
 * rango, cruces y tope por día. Agrega los errores al contexto de Zod con la ruta del
 * tramo (`hours.3.end`), así el panel los muestra junto al campo.
 */
export function checkWeeklyBlocks(blocks: readonly WeeklyBlock[], ctx: IssueSink): void {
  const byDay = new Map<number, number[]>();
  blocks.forEach((b, i) => {
    // Zod corre este chequeo aunque algún tramo ya haya fallado su propia validación: ese
    // tramo ya tiene su error y acá se saltea.
    if (!isWellFormed(b)) return;
    if (minutesOfDay(b.end) <= minutesOfDay(b.start)) {
      ctx.addIssue({ code: "custom", message: "La hora de fin tiene que ser después de la de inicio.", path: [i, "end"] });
      return;
    }
    const list = byDay.get(b.weekday) ?? [];
    list.push(i);
    byDay.set(b.weekday, list);
  });
  for (const indexes of byDay.values()) {
    if (indexes.length > MAX_BLOCKS_PER_DAY) {
      ctx.addIssue({ code: "custom", message: `Máximo ${MAX_BLOCKS_PER_DAY} tramos por día.`, path: [indexes[MAX_BLOCKS_PER_DAY], "start"] });
    }
    const sorted = [...indexes].sort((a, b) => minutesOfDay(blocks[a].start) - minutesOfDay(blocks[b].start));
    for (let k = 1; k < sorted.length; k++) {
      const prev = blocks[sorted[k - 1]];
      const cur = blocks[sorted[k]];
      if (minutesOfDay(cur.start) < minutesOfDay(prev.end)) {
        ctx.addIssue({ code: "custom", message: "Este tramo se cruza con otro del mismo día.", path: [sorted[k], "start"] });
      }
    }
  }
}

/** Lista de tramos de un horario semanal, con todas las reglas. */
export const WeeklyHoursSchema = z
  .array(WeeklyBlockSchema)
  .max(MAX_BLOCKS)
  .superRefine((blocks, ctx) => checkWeeklyBlocks(blocks, ctx));

/** Orden canónico: por día y hora de inicio. */
export function sortBlocks<T extends WeeklyBlock>(blocks: readonly T[]): T[] {
  return [...blocks].sort((a, b) => a.weekday - b.weekday || minutesOfDay(a.start) - minutesOfDay(b.start));
}

/**
 * ¿Algún tramo de `a` se cruza con alguno de `b` el mismo día? (p. ej. un profesional
 * no puede estar en dos sucursales a la vez). Devuelve los índices de `a` que chocan.
 */
export function overlappingBlocks(a: readonly WeeklyBlock[], b: readonly WeeklyBlock[]): number[] {
  const out: number[] = [];
  a.forEach((x, i) => {
    const hit = b.some(
      (y) => y.weekday === x.weekday && minutesOfDay(x.start) < minutesOfDay(y.end) && minutesOfDay(y.start) < minutesOfDay(x.end),
    );
    if (hit) out.push(i);
  });
  return out;
}
