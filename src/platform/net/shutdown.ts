// ─────────────────────────────────────────────────────────────────────────────
// Apagado ordenado del proceso (deploy con `pm2 reload`, o un SIGTERM del sistema).
//
// Sin esto, un reinicio mataba el proceso en el acto: un job a mitad de una llamada
// externa (p. ej. al LLM) quedaba "procesando" en la cola y el reaper lo reintentaba
// minutos después — el cliente recibía la respuesta tarde, o dos veces si el mensaje ya
// había salido. Al recibir la señal:
//   1. el servidor HTTP deja de aceptar conexiones nuevas (las en curso terminan);
//   2. los workers dejan de reclamar trabajo nuevo (`isShuttingDown()`);
//   3. se espera a que terminen las tareas en curso (`trackTask`), con un tope
//      (SHUTDOWN_GRACE_MS, default 25 s; PM2 tiene kill_timeout de 30 s);
//   4. sale. Lo que no llegó a terminar lo rescata el reaper como siempre.
// ─────────────────────────────────────────────────────────────────────────────

let shuttingDown = false;
const tasks = new Set<Promise<unknown>>();

/** true desde que llegó la señal de apagado: los loops no deben tomar trabajo nuevo. */
export function isShuttingDown(): boolean {
  return shuttingDown;
}

/** Registra una tarea en curso (p. ej. procesar un job) para esperarla al apagar. */
export function trackTask<T>(task: Promise<T>): Promise<T> {
  tasks.add(task);
  task.then(
    () => tasks.delete(task),
    () => tasks.delete(task),
  );
  return task;
}

/** Cantidad de tareas en curso (para logs y tests). */
export function pendingTaskCount(): number {
  return tasks.size;
}

/**
 * Marca el apagado y espera a que terminen las tareas en curso, como mucho `graceMs`.
 * Devuelve true si terminaron todas a tiempo.
 */
export async function drainTasks(graceMs: number): Promise<boolean> {
  shuttingDown = true;
  if (tasks.size === 0) return true;
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<false>((r) => {
    timer = setTimeout(() => r(false), graceMs);
  });
  const all = Promise.allSettled([...tasks]).then(() => true as const);
  const result = await Promise.race([all, deadline]);
  clearTimeout(timer);
  return result;
}

/** Solo para tests: vuelve al estado inicial. */
export function _resetShutdownForTests(): void {
  shuttingDown = false;
  tasks.clear();
}
