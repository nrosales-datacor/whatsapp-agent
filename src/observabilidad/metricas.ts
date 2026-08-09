import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { schema } from "../db/schema";
import { iniciarCicloSinSolape } from "../red/programador";
import { intentarLiderazgo } from "../red/liderazgo";
import { capturarError } from "./sentry";

// ─────────────────────────────────────────────────────────────────────────────
// Métricas internas de operación (ROADMAP B5, extendidas por F14 con dimensión
// de tenant): mensajes procesados y latencia del turno del agente (LLM +
// herramientas: cotizar/agendar/etc., no solo la llamada a OpenAI), ahora por
// TENANT en vez de 3 contadores globales — antes "¿este cliente de ₡35.000/mes
// va lento?" no se podía responder sin mirar los logs a mano. Sin dependencias
// nuevas ni servicio externo (Prometheus/Grafana quedan fuera de alcance del
// piloto, F14 lo deja explícitamente documentado como pendiente): se acumulan
// en memoria y se vuelcan a `console.log` cada cierto intervalo, visible con
// `pm2 logs`.
//
// F6: pasó de `setInterval` suelto a `iniciarCicloSinSolape` (mismo tratamiento
// que recordatorios/reputación, F12) más el lease de liderazgo (F6, ver
// `intentarLiderazgo`) — con `ROL=worker` y N réplicas, cada una acumula SUS
// PROPIOS contadores en memoria (son de proceso), pero solo el titular del
// lease imprime el reporte; si no, cada réplica reportaría una fracción
// arbitraria del tráfico total y el número dejaría de significar nada.
//
// F14: los contadores en memoria se pierden en cada restart (mismo trade-off
// que antes, documentado como pendiente en el ROADMAP: no hay serie temporal
// persistida, solo el snapshot que se ve en el log de cada ventana).
// ─────────────────────────────────────────────────────────────────────────────

type DB = PostgresJsDatabase<typeof schema>;

const INTERVALO_MIN = Number(process.env.METRICAS_INTERVALO_MIN ?? 5);
const MAX_MUESTRAS_LATENCIA = 200; // ventana deslizante por tenant: evita crecer sin límite

const NOMBRE_LIDERAZGO = "metricas";
const TITULAR_LIDERAZGO = randomUUID();

interface ContadorTenant {
  mensajes: number;
  latenciasMs: number[];
}

const porTenant = new Map<string, ContadorTenant>();

function entradaTenant(tenantId: string): ContadorTenant {
  let e = porTenant.get(tenantId);
  if (!e) {
    e = { mensajes: 0, latenciasMs: [] };
    porTenant.set(tenantId, e);
  }
  return e;
}

/** Contar un mensaje entrante nuevo (no un duplicado) para ESE tenant. */
export function registrarMensaje(tenantId: string): void {
  entradaTenant(tenantId).mensajes++;
}

/** Registrar cuánto tardó un turno completo del agente (LLM + herramientas) de ESE tenant. */
export function registrarLatenciaAgente(tenantId: string, ms: number): void {
  const e = entradaTenant(tenantId);
  e.latenciasMs.push(ms);
  if (e.latenciasMs.length > MAX_MUESTRAS_LATENCIA) e.latenciasMs.shift();
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

// ─────────────────────────────────────────────────────────────────────────────
// Alerta por SLO de latencia (ROADMAP F14, punto 5 — UNA alerta de ejemplo, no
// las "todas" que menciona el plan completo): si el p95 del turno del agente de
// un tenant supera el umbral EN LA VENTANA DE REPORTE (la muestra deslizante de
// hasta MAX_MUESTRAS_LATENCIA turnos), avisa a Sentry. Mismo patrón de
// ventana+cooldown que ya usan F3 (`webhooksCrudos.ts`) y F11
// (`queue/cola.ts`, alerta DLQ por tenant): acá la "ventana" ES el propio tick
// del reporte periódico (cada INTERVALO_MIN), así que el cooldown evita
// re-alertar en ticks consecutivos mientras el tenant sigue lento.
// ─────────────────────────────────────────────────────────────────────────────
const SLO_LATENCIA_P95_MS = Number(process.env.METRICAS_SLO_LATENCIA_P95_MS ?? 15_000);
const SLO_MUESTRA_MINIMA = 5; // con menos muestras en la ventana, un p95 es ruido, no señal
const SLO_ALERTA_COOLDOWN_MS = 15 * 60_000; // no re-alertar antes de 15 min por tenant (mismo valor que F3/F11)

const ultimaAlertaSloPorTenant = new Map<string, number>();
let alertasSloDisparadasParaTests = 0;

function chequearSloLatencia(tenantId: string, p95: number, n: number): void {
  if (n < SLO_MUESTRA_MINIMA) return;
  if (p95 <= SLO_LATENCIA_P95_MS) return;
  const ahora = Date.now();
  const ultima = ultimaAlertaSloPorTenant.get(tenantId) ?? 0;
  if (ahora - ultima <= SLO_ALERTA_COOLDOWN_MS) return;
  ultimaAlertaSloPorTenant.set(tenantId, ahora);
  alertasSloDisparadasParaTests++;
  capturarError(
    new Error(`tenant ${tenantId}: p95 de latencia del turno del agente = ${p95}ms (umbral ${SLO_LATENCIA_P95_MS}ms, n=${n})`),
    { modulo: "metricas", tenantId, p95, n, umbral: SLO_LATENCIA_P95_MS },
  );
}

/** Solo para tests: resetea contadores por tenant y el estado de la alerta de SLO. */
export function _resetMetricasParaTests(): void {
  porTenant.clear();
  ultimaAlertaSloPorTenant.clear();
  alertasSloDisparadasParaTests = 0;
}

/** Solo para tests: cuántas veces se cruzó el umbral+cooldown del SLO de latencia. */
export function _contarAlertasSloParaTests(): number {
  return alertasSloDisparadasParaTests;
}

/** Solo para tests: umbral vigente del SLO de latencia (para no hardcodear el default). */
export function _umbralSloLatenciaParaTests(): number {
  return SLO_LATENCIA_P95_MS;
}

/**
 * Solo para tests: corre el mismo chequeo de SLO que hace cada tick del reporte
 * (`chequearSloLatencia`) sobre las muestras que ya dejó `registrarLatenciaAgente`
 * para ESE tenant, sin depender del lease de liderazgo ni de `iniciarCicloSinSolape`
 * (que requieren DB/tiempo real). Calcula el p95 con la misma función que usa el
 * reporte real, así que el resultado es equivalente al de un tick genuino.
 */
export function _forzarChequeoSloParaTests(tenantId: string): void {
  const c = porTenant.get(tenantId);
  if (!c) return;
  const p95 = Math.round(percentil(c.latenciasMs, 95));
  chequearSloLatencia(tenantId, p95, c.latenciasMs.length);
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
      const cola = await profundidadCola(db).catch(() => null);

      const tenantsConActividad = [...porTenant.entries()].filter(
        ([, c]) => c.mensajes > 0 || c.latenciasMs.length > 0,
      );
      if (tenantsConActividad.length === 0) {
        console.log(`[metricas] sin actividad en los últimos ${INTERVALO_MIN} min · cola pendiente=${cola ?? "n/a"}`);
      }
      for (const [tenantId, c] of tenantsConActividad) {
        const msgPorMin = (c.mensajes / INTERVALO_MIN).toFixed(2);
        const avg = c.latenciasMs.length
          ? Math.round(c.latenciasMs.reduce((a, b) => a + b, 0) / c.latenciasMs.length)
          : 0;
        const p95 = Math.round(percentil(c.latenciasMs, 95));
        console.log(
          `[metricas] tenant=${tenantId} ${msgPorMin} msg/min · turno del bot: avg=${avg}ms p95=${p95}ms (n=${c.latenciasMs.length}) · cola pendiente=${cola ?? "n/a"}`,
        );
        chequearSloLatencia(tenantId, p95, c.latenciasMs.length);
        c.mensajes = 0; // reinicia el contador de la ventana; la latencia sigue siendo una muestra deslizante
      }
    },
    onError: (e, momento) => {
      console.error(`[metricas] ${momento}:`, e);
      capturarError(e, { loop: "metricas", momento });
    },
  });
  console.log(`Métricas internas activas (reporte cada ${INTERVALO_MIN} min).`);
}
