// ─────────────────────────────────────────────────────────────────────────────
// Ciclo periódico SIN SOLAPAMIENTO.
//
// POR QUÉ: `setInterval(fn, ms)` dispara `fn` cada `ms` sin importar si la ejecución
// anterior ya terminó. Si un tick tarda más que el intervalo (algo esperable cuando se
// recorren decenas de negocios con varias queries y envíos cada uno), el siguiente
// arranca igual y quedan varios ticks corriendo a la vez, apilando carga sobre la base.
// La solución es un `setTimeout` recursivo: el próximo tick se agenda recién cuando el
// actual termina (haya fallado o no), así nunca hay dos en vuelo al mismo tiempo.
//
// Además mide la duración de cada tick y avisa por `console.warn` si superó el intervalo
// configurado — es la señal temprana de que hay que subir la concurrencia (ver
// `mapWithLimit`) o espaciar el intervalo antes de que el solapamiento vuelva a ser un
// problema.
//
// Con varias réplicas, envolverlo con `startLeaderLoop` (./leaderLease.ts) para que solo
// una haga el trabajo de cada tick.
// ─────────────────────────────────────────────────────────────────────────────

export interface LoopOptions {
  /** Nombre corto para los logs, p. ej. "reminders" o "metrics". */
  label: string;
  /** Intervalo objetivo entre el FIN de un tick y el INICIO del siguiente. */
  intervalMs: number;
  /** Trabajo de un tick. Sus errores se atrapan acá; no hace falta que `tick` los maneje. */
  tick: () => Promise<void>;
  /** Se llama si `tick()` rechaza, distinguiendo la primera corrida del resto. */
  onError: (e: unknown, phase: "first-run" | "tick") => void;
  /** Texto libre que se agrega al warning de tick lento (qué variable de env subir). */
  scalingHint: string;
}

/**
 * Handle para frenar el ciclo. Los loops de producción corren toda la vida del proceso;
 * existe para el apagado ordenado y para cerrar los tests limpio, sin timers colgados.
 */
export interface Loop {
  /** Cancela el próximo tick agendado. Si hay uno corriendo en este momento, lo deja terminar. */
  stop: () => void;
}

/**
 * Arranca un ciclo que corre `tick` de inmediato y luego cada `intervalMs`, SIN solaparse
 * nunca (ver cabecera del archivo).
 */
export function startNonOverlappingLoop(options: LoopOptions): Loop {
  const { label, intervalMs, tick, onError, scalingHint } = options;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const runAndMeasure = async (): Promise<void> => {
    const start = Date.now();
    await tick();
    const durationMs = Date.now() - start;
    if (durationMs > intervalMs) {
      console.warn(
        `[${label}] el tick tardó ${durationMs} ms, más que el intervalo configurado (${intervalMs} ms). ${scalingHint}`,
      );
    } else {
      console.log(`[${label}] tick completado en ${durationMs} ms.`);
    }
  };

  // El siguiente tick se agenda DESPUÉS de que este termine (éxito o error): por eso el
  // `setTimeout` vive dentro del `.finally`, no en un `setInterval` aparte que correría en
  // paralelo.
  const scheduleNext = (): void => {
    if (stopped) return;
    timer = setTimeout(() => {
      runAndMeasure()
        .catch((e) => onError(e, "tick"))
        .finally(scheduleNext);
    }, intervalMs);
  };

  runAndMeasure()
    .catch((e) => onError(e, "first-run"))
    .finally(scheduleNext);

  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
