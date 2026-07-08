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
 * Devuelve los horarios de inicio disponibles para una fecha y servicio,
 * respetando el horario del negocio, el intervalo de agenda y las citas ya tomadas.
 */
export function espaciosDisponibles(
  tenant: Tenant,
  fecha: string,
  servicioId: string,
  citasDelDia: Cita[],
): string[] {
  const servicio = tenant.servicios.find((s) => s.id === servicioId);
  if (!servicio) return [];

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
    const fin = t + servicio.duracionMin;
    const choca = ocupados.some(([oi, of]) => t < of && fin > oi);
    if (!choca) libres.push(aHHMM(t));
  }
  return libres;
}
