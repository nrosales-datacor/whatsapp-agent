// ─────────────────────────────────────────────────────────────────────────────
// Borrador del editor de horario semanal (lógica pura, sin React): pasa de los tramos de
// la API a un borrador por día y de vuelta, valida igual que el backend
// (src/modules/business/hours.ts) y ubica los errores del servidor (`body.hours.3.start`)
// en el tramo que corresponde. Lo usan el editor y la API simulada.
//
// "24:00" (abierto hasta medianoche) no entra en un <input type="time">: en el borrador
// se escribe "00:00" como fin y se manda "24:00".
//
// Sin imports a propósito: test/unit/panelSettings.test.ts lo prueba desde el backend.
// ─────────────────────────────────────────────────────────────────────────────

/** Tramo semanal de la API: 0 = domingo … 6 = sábado, horas locales "HH:MM" ([start, end), end hasta "24:00"). */
export interface WeeklyBlock {
  weekday: number;
  start: string;
  end: string;
}

export interface DraftBlock {
  start: string;
  end: string;
}

/** Borrador: índice = día (0 = domingo … 6 = sábado). */
export type HoursDraft = DraftBlock[][];

/** Días en el orden en que se muestran (lunes primero). */
export const DISPLAY_WEEKDAYS = [1, 2, 3, 4, 5, 6, 0] as const;

export const WEEKDAY_NAMES = ["Domingo", "Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado"] as const;
export const WEEKDAY_SHORT = ["Dom", "Lun", "Mar", "Mié", "Jue", "Vie", "Sáb"] as const;

export const MAX_BLOCKS_PER_DAY = 6;

const RE_TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

export function minutesOf(time: string): number {
  const [h, m] = time.split(":");
  return Number(h) * 60 + Number(m);
}

export function emptyDraft(): HoursDraft {
  return Array.from({ length: 7 }, () => []);
}

export function draftFromBlocks(blocks: readonly WeeklyBlock[]): HoursDraft {
  const draft = emptyDraft();
  for (const b of [...blocks].sort((x, y) => minutesOf(x.start) - minutesOf(y.start))) {
    draft[b.weekday]?.push({ start: b.start, end: b.end === "24:00" ? "00:00" : b.end });
  }
  return draft;
}

/** Fin efectivo en minutos ("00:00" como fin = medianoche = 1440). */
function endMinutes(block: DraftBlock): number {
  return block.end === "00:00" ? 24 * 60 : minutesOf(block.end);
}

/** Lo que espera la API, en orden de día (como se muestran) y hora; `index[i]` dice de qué tramo salió el bloque i. */
export function blocksFromDraft(draft: HoursDraft): { blocks: WeeklyBlock[]; index: Array<{ weekday: number; i: number }> } {
  const blocks: WeeklyBlock[] = [];
  const index: Array<{ weekday: number; i: number }> = [];
  for (const weekday of DISPLAY_WEEKDAYS) {
    draft[weekday].forEach((b, i) => {
      blocks.push({ weekday, start: b.start, end: b.end === "00:00" ? "24:00" : b.end });
      index.push({ weekday, i });
    });
  }
  return { blocks, index };
}

/** Clave de error de un tramo del borrador. */
export const blockKey = (weekday: number, i: number) => `${weekday}.${i}`;

/** Errores del borrador (clave `día.tramo`), con las mismas reglas que el backend. */
export function validateDraft(draft: HoursDraft): Record<string, string> {
  const errors: Record<string, string> = {};
  draft.forEach((day, weekday) => {
    day.forEach((b, i) => {
      if (!RE_TIME.test(b.start) || !RE_TIME.test(b.end)) errors[blockKey(weekday, i)] = "Completá las dos horas.";
      else if (endMinutes(b) <= minutesOf(b.start)) errors[blockKey(weekday, i)] = "La hora de fin tiene que ser después de la de inicio.";
    });
    if (day.length > MAX_BLOCKS_PER_DAY) errors[blockKey(weekday, MAX_BLOCKS_PER_DAY)] = `Máximo ${MAX_BLOCKS_PER_DAY} tramos por día.`;
    const order = day.map((_, i) => i).sort((a, b) => minutesOf(day[a].start) - minutesOf(day[b].start));
    for (let k = 1; k < order.length; k++) {
      const prev = day[order[k - 1]];
      const cur = day[order[k]];
      const key = blockKey(weekday, order[k]);
      if (!errors[key] && RE_TIME.test(cur.start) && RE_TIME.test(prev.end) && minutesOf(cur.start) < endMinutes(prev)) {
        errors[key] = "Este tramo se cruza con otro del mismo día.";
      }
    }
  });
  return errors;
}

/** Errores del servidor (`body.hours.3.start`) → claves del borrador. */
export function mapServerErrors(fields: Readonly<Record<string, string>>, index: Array<{ weekday: number; i: number }>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [field, message] of Object.entries(fields)) {
    const m = /^body\.hours\.(\d+)\./.exec(field);
    const target = m ? index[Number(m[1])] : undefined;
    if (target) out[blockKey(target.weekday, target.i)] ??= message;
  }
  return out;
}

function hm(time: string): string {
  return time.replace(/^0(\d)/, "$1");
}

/** Resumen corto de un horario: "Lun–Vie 8:00–18:00 · Sáb 8:00–12:00" (vacío = "Cerrado toda la semana"). */
export function summarizeHours(blocks: readonly WeeklyBlock[], closedLabel = "Sin horario"): string {
  const byDay = new Map<number, string>();
  for (const weekday of DISPLAY_WEEKDAYS) {
    const day = blocks
      .filter((b) => b.weekday === weekday)
      .sort((a, b) => minutesOf(a.start) - minutesOf(b.start))
      .map((b) => `${hm(b.start)}–${hm(b.end)}`)
      .join(", ");
    if (day) byDay.set(weekday, day);
  }
  if (byDay.size === 0) return closedLabel;
  // Agrupa días seguidos (en el orden de la semana) con el mismo horario.
  const parts: string[] = [];
  let run: number[] = [];
  const flush = () => {
    if (run.length === 0) return;
    const label = run.length > 1 ? `${WEEKDAY_SHORT[run[0]]}–${WEEKDAY_SHORT[run[run.length - 1]]}` : WEEKDAY_SHORT[run[0]];
    parts.push(`${label} ${byDay.get(run[0])}`);
    run = [];
  };
  for (const weekday of DISPLAY_WEEKDAYS) {
    const value = byDay.get(weekday);
    if (value && run.length > 0 && byDay.get(run[0]) === value) run.push(weekday);
    else {
      flush();
      if (value) run = [weekday];
    }
  }
  flush();
  return parts.join(" · ");
}
