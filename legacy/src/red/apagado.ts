// ─────────────────────────────────────────────────────────────────────────────
// Apagado ordenado del proceso (deploy con `pm2 reload`, o un SIGTERM del sistema).
//
// Antes, un reinicio mataba el proceso en el acto: un turno del agente a mitad de la
// llamada al LLM quedaba "procesando" en wa_jobs, y el reaper lo reintentaba minutos
// después — el cliente recibía la respuesta tarde, o dos veces si el mensaje ya había
// salido. Ahora, al recibir la señal:
//   1. el servidor HTTP deja de aceptar conexiones nuevas (las en curso terminan);
//   2. los workers dejan de reclamar trabajo nuevo (`apagando()`);
//   3. se espera a que terminen las tareas en curso (`enCurso`), con un tope
//      (APAGADO_ESPERA_MS, default 25 s; PM2 tiene kill_timeout de 30 s);
//   4. sale. Lo que no llegó a terminar lo rescata el reaper como siempre.
// ─────────────────────────────────────────────────────────────────────────────

let enApagado = false;
const tareas = new Set<Promise<unknown>>();

/** true desde que llegó la señal de apagado: los loops no deben tomar trabajo nuevo. */
export function apagando(): boolean {
  return enApagado;
}

/** Registra una tarea en curso (p. ej. procesar un job) para esperarla al apagar. */
export function enCurso<T>(tarea: Promise<T>): Promise<T> {
  tareas.add(tarea);
  tarea.then(
    () => tareas.delete(tarea),
    () => tareas.delete(tarea),
  );
  return tarea;
}

/** Cantidad de tareas en curso (para logs y tests). */
export function tareasEnCurso(): number {
  return tareas.size;
}

/**
 * Marca el apagado y espera a que terminen las tareas en curso, como mucho `esperaMs`.
 * Devuelve true si terminaron todas a tiempo.
 */
export async function esperarTareas(esperaMs: number): Promise<boolean> {
  enApagado = true;
  if (tareas.size === 0) return true;
  let temporizador: NodeJS.Timeout | undefined;
  const tope = new Promise<false>((r) => {
    temporizador = setTimeout(() => r(false), esperaMs);
  });
  const todas = Promise.allSettled([...tareas]).then(() => true as const);
  const resultado = await Promise.race([todas, tope]);
  clearTimeout(temporizador);
  return resultado;
}

/** Solo para tests: vuelve al estado inicial. */
export function _resetApagadoParaTests(): void {
  enApagado = false;
  tareas.clear();
}
