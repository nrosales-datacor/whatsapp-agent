import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { schema } from "../db/schema";
import { iniciarCicloSinSolape } from "../red/programador";
import { intentarLiderazgo } from "../red/liderazgo";
import { capturarError } from "./sentry";

// ─────────────────────────────────────────────────────────────────────────────
// Métricas internas de operación (ROADMAP B5): mensajes procesados, latencia del
// turno del agente (LLM + herramientas: cotizar/agendar/etc., no solo la llamada
// a OpenAI) y profundidad de la cola. Sin dependencias nuevas ni servicio externo
// (Prometheus/Grafana quedan fuera de alcance del piloto): se acumulan en memoria
// y se vuelcan a `console.log` cada cierto intervalo, visible con `pm2 logs`.
//
// F6: pasó de `setInterval` suelto a `iniciarCicloSinSolape` (mismo tratamiento
// que recordatorios/reputación, F12) más el lease de liderazgo (F6, ver
// `intentarLiderazgo`) — con `ROL=worker` y N réplicas, cada una acumula SUS
// PROPIOS contadores en memoria (son de proceso), pero solo el titular del
// lease imprime el reporte; si no, cada réplica reportaría una fracción
// arbitraria del tráfico total y el número dejaría de significar nada.
// ─────────────────────────────────────────────────────────────────────────────

type DB = PostgresJsDatabase<typeof schema>;

const INTERVALO_MIN = Number(process.env.METRICAS_INTERVALO_MIN ?? 5);
const MAX_MUESTRAS_LATENCIA = 200; // ventana deslizante: evita crecer sin límite

const NOMBRE_LIDERAZGO = "metricas";
const TITULAR_LIDERAZGO = randomUUID();

let mensajesProcesados = 0;
const latenciasAgenteMs: number[] = [];

/** Contar un mensaje entrante nuevo (no un duplicado). */
export function registrarMensaje(): void {
  mensajesProcesados++;
}

/** Registrar cuánto tardó un turno completo del agente (LLM + herramientas). */
export function registrarLatenciaAgente(ms: number): void {
  latenciasAgenteMs.push(ms);
  if (latenciasAgenteMs.length > MAX_MUESTRAS_LATENCIA) latenciasAgenteMs.shift();
}

function percentil(valores: number[], p: number): number {
  if (valores.length === 0) return 0;
  const ordenado = [...valores].sort((a, b) => a - b);
  return ordenado[Math.min(ordenado.length - 1, Math.floor((p / 100) * ordenado.length))];
}

async function profundidadCola(db: DB | null): Promise<number | null> {
  if (!db) return null;
  const rows = (await db.execute(
    sql`SELECT count(*)::int AS n FROM wa_jobs WHERE estado = 'pendiente'`,
  )) as unknown as Array<{ n: number }>;
  return rows[0]?.n ?? 0;
}

/**
 * Arranca el volcado periódico a consola. Llamar UNA vez al iniciar el servidor.
 * Sin solapamiento (`iniciarCicloSinSolape`, F12) y con lease de liderazgo (F6):
 * con `ROL=worker` y N réplicas, solo el titular vigente imprime el reporte
 * (ver el comentario de cabecera del archivo); `null` (modo memoria o
 * `ROL=todo`) siempre gana.
 */
export function iniciarReporteMetricas(db: DB | null): void {
  const intervaloMs = INTERVALO_MIN * 60 * 1000;
  iniciarCicloSinSolape({
    etiqueta: "metricas",
    intervaloMs,
    sugerenciaEscalado: "Subir METRICAS_INTERVALO_MIN si el reporte se vuelve muy seguido para los logs.",
    tick: async () => {
      if (!(await intentarLiderazgo(db, NOMBRE_LIDERAZGO, TITULAR_LIDERAZGO, intervaloMs * 3))) {
        return; // otra réplica es la titular este tick: no reportar una fracción parcial del tráfico.
      }
      const msgPorMin = (mensajesProcesados / INTERVALO_MIN).toFixed(2);
      const avg = latenciasAgenteMs.length
        ? Math.round(latenciasAgenteMs.reduce((a, b) => a + b, 0) / latenciasAgenteMs.length)
        : 0;
      const p95 = Math.round(percentil(latenciasAgenteMs, 95));
      const cola = await profundidadCola(db).catch(() => null);
      console.log(
        `[metricas] ${msgPorMin} msg/min · turno del bot: avg=${avg}ms p95=${p95}ms (n=${latenciasAgenteMs.length}) · cola pendiente=${cola ?? "n/a"}`,
      );
      mensajesProcesados = 0; // reinicia el contador de la ventana; la latencia sigue siendo una muestra deslizante
    },
    onError: (e, momento) => {
      console.error(`[metricas] ${momento}:`, e);
      capturarError(e, { loop: "metricas", momento });
    },
  });
  console.log(`Métricas internas activas (reporte cada ${INTERVALO_MIN} min).`);
}
