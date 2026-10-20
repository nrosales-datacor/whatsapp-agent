// ─────────────────────────────────────────────────────────────────────────────
// Predicados sobre errores de la capa de datos de agenda.
//
// Viven en su propio módulo (y no en drizzleRepository) para que el agente y el router
// puedan reconocer el error SIN importar el repositorio Drizzle entero, que arrastra el
// driver de postgres a rutas que corren con el repo en memoria (tests, e2e del panel).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * El horario dejó de estar libre entre que se ofreció y que se intentó guardar: lo
 * lanza el repositorio cuando el re-chequeo atómico de `crearCita`/`reprogramarCita`
 * (parámetro `verificar`) da false. Cubre lo que el índice único NO cubre: el modo
 * recurso único (citas sin empleado), los solapes parciales por duración y la
 * reprogramación. Con el worker concurrente (E7) dos turnos de clientes distintos
 * corren en paralelo de verdad, así que esta carrera dejó de ser teórica.
 */
export class HorarioOcupadoError extends Error {
  constructor() {
    super("ese horario ya no está disponible");
    this.name = "HorarioOcupadoError";
  }
}

/**
 * true si el error es la violación del índice único `wa_citas_empleado_slot_uq`, que
 * impide dejar a UNA misma persona con dos citas "agendada" en el mismo horario
 * (ALTO-07).
 *
 * Ese índice es la red de último recurso contra la carrera: `espaciosDisponibles` lee y
 * decide fuera de la transacción, así que dos clientes tocando el mismo horario en el
 * mismo instante pueden pasar los dos el chequeo de aplicación. Quien inserte segundo
 * recibe este error, y el caller debe traducirlo a "ese horario ya no está disponible"
 * — nunca dejarlo escapar como 500.
 *
 * Sin DB (repo en memoria) el índice no existe; ahí solo puede llegar un
 * `HorarioOcupadoError` del re-chequeo de `verificar` (que el repo en memoria también
 * implementa, por paridad).
 */
export function esChoqueDeEmpleado(e: unknown): boolean {
  // `HorarioOcupadoError` es el mismo "perdiste la carrera", detectado por el re-chequeo
  // atómico en vez de por el índice: los callers ya lo traducen igual.
  if (e instanceof HorarioOcupadoError) return true;
  // Drizzle NO propaga el error de Postgres crudo: lo envuelve en un DrizzleQueryError
  // con el original colgando de `cause`. Mirar solo el error de arriba devuelve false
  // siempre y el 23505 termina saliendo como un 500 — verificado contra Postgres real en
  // test/reliability/empleados.test.ts. Por eso se recorre la cadena de causas.
  let actual: unknown = e;
  for (let i = 0; actual && i < 5; i++) {
    const err = actual as { code?: string; constraint_name?: string; constraint?: string; cause?: unknown };
    if (err.code === "23505" && (err.constraint_name ?? err.constraint) === "wa_citas_empleado_slot_uq") {
      return true;
    }
    actual = err.cause;
  }
  return false;
}
