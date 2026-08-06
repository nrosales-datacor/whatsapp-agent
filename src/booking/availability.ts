import type { Cita, Empleado, Tenant } from "../types";

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
 * Empleados que PUEDEN atender un servicio en una fecha dada (ALTO-07): activos, que
 * sepan hacer ese servicio, y sin un día libre puntual que cubra esa fecha.
 *
 * `serviciosIds` vacío o ausente = hace todos los servicios (default amable: el dueño
 * que solo carga nombres no tiene que configurar nada más).
 */
export function empleadosElegibles(tenant: Tenant, fecha: string, servicioId: string): Empleado[] {
  return (tenant.empleados ?? []).filter(
    (e) =>
      e.activo &&
      (!e.serviciosIds || e.serviciosIds.length === 0 || e.serviciosIds.includes(servicioId)) &&
      !e.bloqueos?.some((b) => fecha >= b.desde && fecha <= b.hasta),
  );
}

/** Un espacio libre y quiénes podrían atenderlo. `empleados` vacío = negocio sin equipo cargado. */
export interface EspacioLibre {
  hora: string; // "HH:mm"
  /**
   * Ids de los empleados que tienen ese espacio libre. Vacío cuando el negocio no cargó
   * equipo (modo recurso único), NO cuando no hay nadie disponible: en ese caso el
   * espacio directamente no se devuelve.
   */
  empleados: string[];
}

/**
 * Espacios libres de una fecha/servicio, CON el detalle de quién puede tomar cada uno.
 * Es la primitiva; `espaciosDisponibles` es la vista simplificada para quien solo
 * necesita las horas.
 *
 * Respeta el horario del negocio, el intervalo de agenda, los feriados y las citas ya
 * tomadas. Reglas de capacidad (ALTO-07 — la agenda modelaba UN solo recurso, así que
 * un negocio con 2 personas perdía la mitad de su capacidad):
 *
 * - **Sin equipo cargado** (`tenant.empleados` vacío): cualquier solape bloquea el
 *   horario. Es EXACTAMENTE el comportamiento anterior, así que los negocios que ya
 *   existen no cambian en nada hasta que el dueño cargue su equipo.
 * - **Con equipo cargado**: un horario se ofrece si queda al menos un empleado elegible
 *   sin solape. Dos clientes distintos pueden tener cita a la misma hora con personas
 *   distintas; lo que nunca se permite es duplicarle el horario a UNA misma persona.
 * - **Citas sin asignar** (`empleadoId` undefined: histórico previo a esta columna, o
 *   walk-ins anotados a mano): ocupan a *alguien*, pero no sabemos a quién. Se tratan
 *   como consumo genérico de capacidad — restan un cupo del total disponible. Es lo más
 *   conservador que se puede hacer sin inventar una asignación.
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
export function espaciosPorEmpleado(
  tenant: Tenant,
  fecha: string,
  servicioId: string,
  citasDelDia: Cita[],
  ahora: Date = new Date(),
): EspacioLibre[] {
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

  // Equipo que puede atender este servicio hoy. Ojo con la distinción: un negocio SIN
  // empleados cargados corre en modo recurso único (legacy); uno CON empleados cargados
  // pero ninguno elegible (nadie sabe hacer ese servicio, o todos de vacaciones) no
  // tiene disponibilidad — y eso es una afirmación real de su configuración, no un bug.
  const hayEquipo = (tenant.empleados ?? []).length > 0;
  const elegibles = hayEquipo ? empleadosElegibles(tenant, fecha, servicioId) : [];
  if (hayEquipo && elegibles.length === 0) return [];

  const apertura = aMin(h.abre);
  const cierre = aMin(h.cierra);
  const paso = tenant.intervaloAgendaMin;

  // Rangos ocupados por citas existentes (inicio, fin, quién) en minutos.
  const ocupados = citasDelDia
    .filter((c) => c.estado === "agendada")
    .map((c) => {
      const ini = aMin(c.hora);
      const dur = tenant.servicios.find((s) => s.id === c.servicioId)?.duracionMin ?? paso;
      return { ini, fin: ini + dur, empleadoId: c.empleadoId };
    });

  const libres: EspacioLibre[] = [];
  for (let t = apertura; t + servicio.duracionMin <= cierre; t += paso) {
    if (t < pisoMinutos) continue; // hora ya pasada (o demasiado próxima) de HOY
    const fin = t + servicio.duracionMin;
    const solapan = ocupados.filter((o) => t < o.fin && fin > o.ini);

    if (!hayEquipo) {
      // Modo recurso único: cualquier solape bloquea (comportamiento histórico).
      if (solapan.length === 0) libres.push({ hora: aHHMM(t), empleados: [] });
      continue;
    }

    const tomados = new Set(solapan.map((o) => o.empleadoId).filter(Boolean) as string[]);
    const sinAsignar = solapan.filter((o) => !o.empleadoId).length;
    const disponibles = elegibles.filter((e) => !tomados.has(e.id));
    // Las citas sin asignar consumen cupo genérico: si hay 2 personas y una cita sin
    // asignar solapa, solo queda 1 cupo real aunque ninguna de las 2 esté "tomada".
    if (disponibles.length - sinAsignar <= 0) continue;
    libres.push({ hora: aHHMM(t), empleados: disponibles.map((e) => e.id) });
  }
  return libres;
}

/**
 * ¿Esa persona ya tiene una cita "agendada" que se solape con `hora` + la duración de
 * `servicioId`? (ALTO-07)
 *
 * Chequeo puntual y a propósito SEPARADO de `espaciosPorEmpleado`: el panel permite
 * registrar un walk-in fuera del horario del negocio o en una hora ya transcurrida de
 * hoy (el dueño necesita anotar a las 3 p.m. al cliente que llegó a las 9 a.m.), así que
 * ahí no se pueden aplicar el horario de atención ni el piso temporal. Lo que NUNCA se
 * permite, ni siquiera a mano, es dejar a una misma persona con dos citas encimadas.
 *
 * `excluirCitaId` sirve al reprogramar/reasignar: la propia cita no debe bloquearse.
 */
export function empleadoOcupado(
  tenant: Tenant,
  empleadoId: string,
  fecha: string,
  hora: string,
  servicioId: string,
  citasDelDia: Cita[],
  excluirCitaId?: string,
): boolean {
  const dur = tenant.servicios.find((s) => s.id === servicioId)?.duracionMin ?? tenant.intervaloAgendaMin;
  const ini = aMin(hora);
  const fin = ini + dur;
  return citasDelDia.some((c) => {
    if (c.estado !== "agendada" || c.empleadoId !== empleadoId || c.id === excluirCitaId) return false;
    if (c.fecha !== fecha) return false;
    const cIni = aMin(c.hora);
    const cDur = tenant.servicios.find((s) => s.id === c.servicioId)?.duracionMin ?? tenant.intervaloAgendaMin;
    return ini < cIni + cDur && fin > cIni;
  });
}

/**
 * Horas libres de una fecha/servicio, sin el detalle de quién las puede atender.
 * Vista simplificada de `espaciosPorEmpleado` para los llamadores a los que solo les
 * importa la hora (consulta de disponibilidad, toques de rescate).
 *
 * Con `empleadoId` devuelve solo las horas libres DE ESA PERSONA; sin él, la unión de
 * todo el equipo.
 */
export function espaciosDisponibles(
  tenant: Tenant,
  fecha: string,
  servicioId: string,
  citasDelDia: Cita[],
  ahora: Date = new Date(),
  empleadoId?: string,
): string[] {
  const espacios = espaciosPorEmpleado(tenant, fecha, servicioId, citasDelDia, ahora);
  if (!empleadoId) return espacios.map((e) => e.hora);
  return espacios.filter((e) => e.empleados.includes(empleadoId)).map((e) => e.hora);
}
