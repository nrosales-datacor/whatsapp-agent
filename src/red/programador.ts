// ─────────────────────────────────────────────────────────────────────────────
// Ciclo periódico SIN SOLAPAMIENTO (F12, PLAN-ESCALA-MULTITENANT).
//
// POR QUÉ: `setInterval(fn, ms)` dispara `fn` cada `ms` sin importar si la
// ejecución anterior ya terminó. Si un tick tarda más que el intervalo (algo
// esperable cuando se recorren 50 tenants con varias queries y envíos cada
// uno), el siguiente arranca igual y quedan varios ticks corriendo a la vez,
// apilando carga sobre la base de datos. La solución es un `setTimeout`
// recursivo: el próximo tick se agenda recién cuando el actual termina (haya
// fallado o no), así nunca hay dos en vuelo al mismo tiempo.
//
// Además mide la duración de cada tick y avisa por `console.warn` si superó el
// intervalo configurado — es la señal temprana de que hay que subir la
// concurrencia (ver `mapConLimite`) o espaciar el intervalo antes de que el
// solapamiento vuelva a ser un problema.
//
// Comparten este helper `reminders/scheduler.ts` y `reputacion/places.ts`: los
// dos tenían el mismo patrón de "un `setInterval` recorriendo tenants"
// duplicado casi al calco.
// ─────────────────────────────────────────────────────────────────────────────

export interface CicloSinSolapeOpciones {
  /** Nombre corto para los logs, p.ej. "recordatorios" o "reputacion". */
  etiqueta: string;
  /** Intervalo objetivo entre el FIN de un tick y el INICIO del siguiente. */
  intervaloMs: number;
  /** Trabajo de un tick. Sus errores se atrapan acá; no hace falta que `tick` los maneje. */
  tick: () => Promise<void>;
  /** Se llama si `tick()` rechaza, distinguiendo el primer chequeo del resto. */
  onError: (e: unknown, momento: "primer-chequeo" | "tick") => void;
  /** Texto libre que se agrega al warning de tick lento (qué variable de env subir). */
  sugerenciaEscalado: string;
}

/** Handle para frenar el ciclo. Los loops de producción lo ignoran (corren toda la vida del proceso); existe sobre todo para poder cerrar los tests limpio, sin dejar timers colgados. */
export interface CicloSinSolape {
  /** Cancela el próximo tick agendado. Si hay uno corriendo en este momento, lo deja terminar. */
  detener: () => void;
}

/**
 * Arranca un ciclo que corre `tick` de inmediato y luego cada `intervaloMs`,
 * SIN solaparse nunca (ver cabecera del archivo). Pensado para loops de fondo
 * de vida completa del proceso (recordatorios, reputación).
 */
export function iniciarCicloSinSolape(opciones: CicloSinSolapeOpciones): CicloSinSolape {
  const { etiqueta, intervaloMs, tick, onError, sugerenciaEscalado } = opciones;
  let detenido = false;
  let manejador: ReturnType<typeof setTimeout> | undefined;

  const correrYMedir = async (): Promise<void> => {
    const inicio = Date.now();
    await tick();
    const duracionMs = Date.now() - inicio;
    if (duracionMs > intervaloMs) {
      console.warn(
        `[${etiqueta}] el tick tardó ${duracionMs} ms, más que el intervalo configurado (${intervaloMs} ms). ${sugerenciaEscalado}`,
      );
    } else {
      console.log(`[${etiqueta}] tick completado en ${duracionMs} ms.`);
    }
  };

  // El siguiente tick se agenda DESPUÉS de que este termine (éxito o error):
  // por eso el `setTimeout` vive dentro del `.finally`, no en un `setInterval`
  // aparte que correría en paralelo.
  const agendarSiguiente = (): void => {
    if (detenido) return;
    manejador = setTimeout(() => {
      correrYMedir()
        .catch((e) => onError(e, "tick"))
        .finally(agendarSiguiente);
    }, intervaloMs);
  };

  correrYMedir()
    .catch((e) => onError(e, "primer-chequeo"))
    .finally(agendarSiguiente);

  return {
    detener: () => {
      detenido = true;
      if (manejador) clearTimeout(manejador);
    },
  };
}
