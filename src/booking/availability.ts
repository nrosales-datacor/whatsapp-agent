import type { Cita, Tenant } from "../types";

/** Convierte "HH:mm" a minutos desde medianoche. */
function aMin(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

/** Convierte minutos desde medianoche a "HH:mm". */
function aHHMM(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** Día de la semana (0=domingo..6=sábado) de una fecha "YYYY-MM-DD" en la zona del tenant. */
function diaSemana(fecha: string, timezone: string): number {
  // Se interpreta el mediodía para evitar saltos por zona horaria.
  const d = new Date(`${fecha}T12:00:00`);
  const nombre = d.toLocaleDateString("en-US", { weekday: "short", timeZone: timezone });
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(nombre);
}

/**
 * Fecha ("YYYY-MM-DD") y minutos desde medianoche AHORA, en la zona del negocio.
 * Una sola pasada de Intl para que la fecha y la hora no puedan quedar de días
 * distintos si la llamada cae justo en el cambio de día.
 */
export function ahoraEnTz(timezone: string, ref: Date = new Date()): { fecha: string; minutos: number } {
  const partes = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(ref);
  const p = (tipo: string) => partes.find((x) => x.type === tipo)?.value ?? "00";
  // Algunas versiones de ICU devuelven "24" para la medianoche con hour12:false.
  const hora = Number(p("hour")) % 24;
  return { fecha: `${p("year")}-${p("month")}-${p("day")}`, minutos: hora * 60 + Number(p("minute")) };
}

/**
 * Margen mínimo (minutos) entre "ahora" y el primer horario que se ofrece para HOY.
 * Nadie agenda para dentro de 5 minutos: el cliente necesita tiempo para llegar.
 * Configurable por .env; per-tenant queda pendiente (ver ROADMAP Carril E).
 */
const MARGEN_RESERVA_DEFAULT_MIN = 30;

function margenReservaMin(): number {
  const n = Number(process.env.AGENDA_MARGEN_MINIMO_MIN);
  return Number.isFinite(n) && n >= 0 ? n : MARGEN_RESERVA_DEFAULT_MIN;
}

/**
 * Devuelve los horarios de inicio disponibles para una fecha y servicio,
 * respetando el horario del negocio, el intervalo de agenda y las citas ya tomadas.
 *
 * ⚠️ AUDITORÍA BLOQ-09 (verificado el 2026-07-27 con `scripts/simulacion/simular.ts`):
 * el bucle arrancaba en la hora de APERTURA sin mirar el reloj, así que a las 09:24 el
 * bot ofrecía 08:00, 08:30 y 09:00 como disponibles — y al tocar "8:00 a.m." la cita
 * se creaba de verdad, hora y veinte en el pasado (`agendar_cita` confía en que lo que
 * ofreció esta función es válido). Ahora, cuando la fecha es HOY, se descartan los
 * horarios anteriores a `ahora + margen`; y una fecha ya pasada no ofrece nada.
 *
 * Esto solo acota lo que se OFRECE (lista del bot, selector de la Agenda, rescate).
 * La creación manual de citas desde el panel sigue pudiendo registrar una hora ya
 * transcurrida del día de hoy (`POST /citas` no exige que la hora esté en esta lista):
 * el dueño necesita poder anotar el walk-in de la mañana a las 3 de la tarde.
 *
 * `ahora` se puede inyectar para los tests; en producción es el reloj real.
 */
export function espaciosDisponibles(
  tenant: Tenant,
  fecha: string,
  servicioId: string,
  citasDelDia: Cita[],
  ahora: Date = new Date(),
): string[] {
  const servicio = tenant.servicios.find((s) => s.id === servicioId);
  if (!servicio) return [];

  // Piso temporal: nada de ofrecer el pasado.
  const hoyAhora = ahoraEnTz(tenant.timezone, ahora);
  if (fecha < hoyAhora.fecha) return [];
  const pisoMinutos = fecha === hoyAhora.fecha ? hoyAhora.minutos + margenReservaMin() : -1;

  const dia = diaSemana(fecha, tenant.timezone);
  const h = tenant.horario[dia];
  if (!h || !h.abre || !h.cierra) return []; // cerrado ese día

  // Feriado/vacaciones puntuales (ROADMAP C2.2), fuera del horario semanal recurrente.
  if (tenant.bloqueos?.some((b) => fecha >= b.desde && fecha <= b.hasta)) return [];

  const apertura = aMin(h.abre);
  const cierre = aMin(h.cierra);
  const paso = tenant.intervaloAgendaMin;

  // Rangos ocupados por citas existentes (inicio, fin) en minutos.
  const ocupados = citasDelDia
    .filter((c) => c.estado === "agendada")
    .map((c) => {
      const ini = aMin(c.hora);
      const dur = tenant.servicios.find((s) => s.id === c.servicioId)?.duracionMin ?? paso;
      return [ini, ini + dur] as const;
    });

  const libres: string[] = [];
  for (let t = apertura; t + servicio.duracionMin <= cierre; t += paso) {
    if (t < pisoMinutos) continue; // hora ya pasada (o demasiado próxima) de HOY
    const fin = t + servicio.duracionMin;
    const choca = ocupados.some(([oi, of]) => t < of && fin > oi);
    if (!choca) libres.push(aHHMM(t));
  }
  return libres;
}
