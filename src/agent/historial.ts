import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import type { MensajeConversacion } from "../types";

// ─────────────────────────────────────────────────────────────────────────────
// Historial que ve el agente (revisión pre-venta 2026-10).
//
// Antes el agente recibía hasta 100 mensajes (la lectura del panel) sin fecha: un
// cliente recurrente costaba muchos más tokens —×4, porque cada paso de tool-calling
// reenvía todo— y un "mañana" dicho hace una semana se reinterpretaba como mañana de
// hoy. Ahora (1) se recorta a los últimos N mensajes dentro de una ventana de días y
// (2) los mensajes de días anteriores van precedidos de un separador con su fecha.
// ─────────────────────────────────────────────────────────────────────────────

/** Lee un entero de una env var dentro de [min, max]; si falta o es inválido, el default. */
function enteroEnv(valor: string | undefined, porDefecto: number, min: number, max: number): number {
  const n = valor !== undefined && valor.trim() !== "" ? Number(valor) : NaN;
  return Number.isInteger(n) && n >= min && n <= max ? n : porDefecto;
}

/** Máximo de mensajes previos que ve el agente. Env `AGENTE_HISTORIAL_MAX_MENSAJES` (2-100, default 20). */
export const HISTORIAL_MAX_MENSAJES = enteroEnv(process.env.AGENTE_HISTORIAL_MAX_MENSAJES, 20, 2, 100);

/**
 * Ventana de tiempo del historial: los mensajes con más de N días no entran al prompt.
 * Env `AGENTE_HISTORIAL_MAX_DIAS` (0-365, default 30; 0 = sin ventana, solo el tope de
 * mensajes). Un cliente que vuelve al mes no necesita la charla vieja para agendar.
 */
export const HISTORIAL_MAX_DIAS = enteroEnv(process.env.AGENTE_HISTORIAL_MAX_DIAS, 30, 0, 365);

const MS_DIA = 24 * 60 * 60 * 1000;

/**
 * Recorta el historial a la ventana de días y a los últimos `maxMensajes`. Los mensajes
 * con `creadoEn` ilegible se conservan (mejor de más que perder contexto por un dato raro).
 */
export function recortarHistorial(
  mensajes: MensajeConversacion[],
  opts: { maxMensajes?: number; maxDias?: number; ahora?: Date } = {},
): MensajeConversacion[] {
  const maxMensajes = opts.maxMensajes ?? HISTORIAL_MAX_MENSAJES;
  const maxDias = opts.maxDias ?? HISTORIAL_MAX_DIAS;
  const ahora = (opts.ahora ?? new Date()).getTime();
  const enVentana =
    maxDias > 0
      ? mensajes.filter((m) => {
          const t = Date.parse(m.creadoEn);
          return !Number.isFinite(t) || ahora - t <= maxDias * MS_DIA;
        })
      : mensajes;
  return maxMensajes > 0 ? enVentana.slice(-maxMensajes) : [];
}

/** "YYYY-MM-DD" del instante `fecha` en la zona del tenant. */
function diaEnTz(fecha: Date, timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(
    fecha,
  );
}

/** Días calendario entre dos "YYYY-MM-DD" (b - a). */
function diasEntre(a: string, b: string): number {
  const [ya, ma, da] = a.split("-").map(Number);
  const [yb, mb, db] = b.split("-").map(Number);
  return Math.round((Date.UTC(yb, mb - 1, db) - Date.UTC(ya, ma - 1, da)) / MS_DIA);
}

/** Separador de un día anterior: fecha legible + relativa, y aviso de cómo leer "mañana". */
function separadorDia(instante: Date, dia: string, hoy: string, timezone: string): string {
  const legible = new Intl.DateTimeFormat("es-CR", {
    timeZone: timezone,
    weekday: "long",
    day: "numeric",
    month: "long",
  }).format(instante);
  const n = diasEntre(dia, hoy);
  const relativo = n === 1 ? "ayer" : `hace ${n} días`;
  return `[Mensajes del ${legible} (${relativo}). En estos mensajes, "hoy", "mañana", "el lunes", etc. se refieren a ESA fecha, no a la de hoy.]`;
}

const SEPARADOR_HOY = "[Mensajes de hoy]";

/**
 * Convierte el historial a mensajes de OpenAI, anteponiendo un separador (`role:
 * "system"`) cada vez que empieza un día distinto de hoy (en la zona del tenant), y uno
 * de "hoy" cuando la conversación vuelve al día actual. Si todo el historial es de hoy,
 * sale idéntico al de antes (sin separadores).
 *
 * Decisión deliberada: separadores aparte en vez de un prefijo "[hace 7 días]" dentro de
 * cada mensaje. Con el prefijo dentro de los mensajes del asistente, el modelo tiende a
 * imitar el formato y a empezar sus respuestas con "[hoy] …"; además el contenido de
 * cada mensaje queda tal cual se guardó (el dedup del turno actual compara contenido).
 */
export function historialParaModelo(
  historial: MensajeConversacion[],
  timezone: string,
  ahora: Date = new Date(),
): ChatCompletionMessageParam[] {
  const hoy = diaEnTz(ahora, timezone);
  const salida: ChatCompletionMessageParam[] = [];
  let diaAnterior: string | null = null;
  let huboDiasViejos = false;
  for (const m of historial) {
    const instante = new Date(m.creadoEn);
    const dia = Number.isFinite(instante.getTime()) ? diaEnTz(instante, timezone) : hoy;
    if (dia !== diaAnterior) {
      if (dia < hoy) {
        salida.push({ role: "system", content: separadorDia(instante, dia, hoy, timezone) });
        huboDiasViejos = true;
      } else if (huboDiasViejos) {
        salida.push({ role: "system", content: SEPARADOR_HOY });
      }
      diaAnterior = dia;
    }
    salida.push({ role: m.rol, content: m.contenido } as ChatCompletionMessageParam);
  }
  return salida;
}
