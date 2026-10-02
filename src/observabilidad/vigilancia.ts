import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { schema, waUsoMensual } from "../db/schema";
import { filasDe } from "../db/filas";
import type { Tenant } from "../types";
import { listarTenants } from "../config/tenantStore";
import { iniciarCicloSinSolape } from "../red/programador";
import { intentarLiderazgo } from "../red/liderazgo";
import { listarTokensInvalidos, type TokenInvalido } from "../whatsapp/estadoToken";
import { calcularEstadoCuota } from "./cuotas";
import { anioMesActual } from "./uso";
import { alertarPlataforma, type Alerta } from "./alertas";
import { capturarError } from "./sentry";
import { log } from "./log";

// ─────────────────────────────────────────────────────────────────────────────
// Vigilancia de "bot mudo": detectores periódicos de degradación SILENCIOSA que
// `/salud` no marca como crítica (ese solo mira DB + caché de tenants) y que ni
// Sentry ve porque no son excepciones:
//
//   a) cola atascada: el job `pendiente` (ya listo para correr) más viejo de
//      `wa_jobs` lleva más de N min esperando → el worker está caído o colgado.
//   b) DLQ reciente: jobs que agotaron reintentos (estado `error`) en la última
//      ventana, por tenant → mensajes de clientes que nadie respondió.
//   c) tenant sin entrantes: un negocio activo que lleva N horas HÁBILES (dentro
//      de SU horario de atención, en SU zona horaria) sin recibir un solo mensaje
//      → Meta dejó de mandarle webhooks (número desconectado, app removida).
//   d) token de WhatsApp inválido (HTTP 401 / Graph 190): lo detecta
//      `whatsapp/estadoToken.ts` en el momento del envío; acá solo se resume.
//   e) cuota agotada: el negocio llegó al 100% del tope de su plan y el bot dejó
//      de responder (F10) → oportunidad de upgrade / cliente molesto.
//
// `evaluarVigilancia` es la ÚNICA fuente: la usa el scheduler (que además emite
// las alertas, `alertas.ts`) y `/salud?detalle=1` (que solo las muestra). Sin
// efectos de lado, recibe el `db` ya abierto — testeable directo con PGlite,
// mismo criterio que `salud.ts`.
//
// El scheduler corre con `iniciarCicloSinSolape` (F12) + lease de liderazgo
// (F6): con N réplicas `worker`, solo una evalúa y alerta.
// ─────────────────────────────────────────────────────────────────────────────

type DB = PostgresJsDatabase<typeof schema>;

function numeroDeEnv(nombre: string, porDefecto: number): number {
  const n = Number(process.env[nombre]);
  return process.env[nombre] !== undefined && Number.isFinite(n) && n >= 0 ? n : porDefecto;
}

export interface UmbralesVigilancia {
  /** Minutos que puede esperar el job pendiente (listo) más viejo antes de alertar. */
  colaAtascadaMin: number;
  /** Ventana (min) para contar jobs que cayeron al DLQ. */
  dlqVentanaMin: number;
  /** Jobs en DLQ dentro de la ventana, por tenant, a partir de los cuales se alerta. */
  dlqUmbral: number;
  /** Horas hábiles sin entrantes para alertar. 0 = detector apagado. */
  sinEntrantesHoras: number;
}

export function umbralesDesdeEnv(): UmbralesVigilancia {
  return {
    colaAtascadaMin: numeroDeEnv("ALERTA_COLA_ATASCADA_MIN", 10),
    dlqVentanaMin: numeroDeEnv("ALERTA_DLQ_VENTANA_MIN", 60),
    dlqUmbral: Math.max(1, numeroDeEnv("ALERTA_DLQ_UMBRAL", 1)),
    sinEntrantesHoras: numeroDeEnv("ALERTA_SIN_ENTRANTES_HORAS", 4),
  };
}

export interface ResumenVigilancia {
  /** true si ningún detector encontró nada. Informativo: NO cambia el 200/503 de /salud. */
  ok: boolean;
  colaAtascada: { pendienteMasViejoMin: number | null; umbralMin: number; atascada: boolean } | null;
  dlqReciente: { ventanaMin: number; umbral: number; tenants: { tenantId: string; n: number }[] } | null;
  sinEntrantes: { umbralHoras: number; tenants: { tenantId: string; horasHabiles: number }[] } | null;
  /** De ESTE proceso (ver whatsapp/estadoToken.ts). */
  tokensInvalidos: TokenInvalido[];
  cuotaAgotada: { tenantId: string; usados: number; tope: number }[] | null;
}

// ── a) Cola atascada ────────────────────────────────────────────────────────

/**
 * Minutos que lleva esperando el job `pendiente` más viejo que YA está listo para
 * correr (`ejecutar_despues_de <= now()`): un job diferido por backoff o por el
 * rate limit de ingesta no está "atascado", solo está esperando su turno. null si
 * no hay ninguno listo.
 */
export async function antiguedadPendienteMasViejoMin(db: DB): Promise<number | null> {
  const filas = filasDe<{ seg: number | string | null }>(
    await db.execute(sql`
      SELECT EXTRACT(EPOCH FROM (now() - min(ejecutar_despues_de)))::float8 AS seg
        FROM wa_jobs
       WHERE estado = 'pendiente' AND ejecutar_despues_de <= now()
    `),
  );
  const seg = filas[0]?.seg;
  return seg === null || seg === undefined ? null : Math.round((Number(seg) / 60) * 10) / 10;
}

// ── b) DLQ reciente ─────────────────────────────────────────────────────────

/** Jobs que pasaron a `error` (agotaron reintentos) en los últimos `ventanaMin`, por tenant. */
export async function jobsEnErrorRecientes(db: DB, ventanaMin: number): Promise<{ tenantId: string; n: number }[]> {
  const filas = filasDe<{ tenant_id: string; n: number }>(
    await db.execute(sql`
      SELECT tenant_id, count(*)::int AS n
        FROM wa_jobs
       WHERE estado = 'error'
         AND finalizado_en > now() - ${ventanaMin} * interval '1 minute'
       GROUP BY tenant_id
       ORDER BY n DESC
    `),
  );
  return filas.map((f) => ({ tenantId: f.tenant_id, n: Number(f.n) }));
}

// ── c) Tenant sin entrantes en horario de atención ──────────────────────────

/**
 * Último mensaje ENTRANTE por tenant. Fuente principal: `wa_jobs` (cada entrante
 * genera un job `responder_entrante`; tabla chica gracias a la retención de F11,
 * así que el agregado es barato). Para los tenants que no aparecen ahí (sin
 * tráfico dentro de la retención), cae a `wa_mensajes` SOLO para esos tenants —
 * es la consulta cara, por eso no se corre para todos. Un tenant que no tiene
 * ningún entrante en ninguna de las dos fuentes no tiene línea base (negocio
 * recién dado de alta): no aparece en el mapa y no se alerta.
 */
export async function ultimoEntrantePorTenant(db: DB, tenantIds: string[]): Promise<Map<string, Date>> {
  const mapa = new Map<string, Date>();
  if (tenantIds.length === 0) return mapa;
  const desdeJobs = filasDe<{ tenant_id: string; ultimo: string | Date }>(
    await db.execute(sql`
      SELECT tenant_id, max(creado_en) AS ultimo
        FROM wa_jobs
       WHERE tipo = 'responder_entrante'
       GROUP BY tenant_id
    `),
  );
  for (const f of desdeJobs) if (f.ultimo) mapa.set(f.tenant_id, new Date(f.ultimo));

  const faltantes = tenantIds.filter((id) => !mapa.has(id));
  if (faltantes.length > 0) {
    const desdeMensajes = filasDe<{ tenant_id: string; ultimo: string | Date }>(
      await db.execute(sql`
        SELECT c.tenant_id, max(m.creado_en) AS ultimo
          FROM wa_mensajes m
          JOIN wa_conversaciones c ON c.id = m.conversacion_id
         WHERE m.rol = 'user'
           AND c.tenant_id IN (${sql.join(faltantes.map((id) => sql`${id}`), sql`, `)})
         GROUP BY c.tenant_id
      `),
    );
    for (const f of desdeMensajes) if (f.ultimo) mapa.set(f.tenant_id, new Date(f.ultimo));
  }
  return mapa;
}

type ConfigHorario = Pick<Tenant, "horario" | "timezone" | "bloqueos">;

const formateadores = new Map<string, Intl.DateTimeFormat>();
function formateador(timezone: string): Intl.DateTimeFormat {
  let f = formateadores.get(timezone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
    formateadores.set(timezone, f);
  }
  return f;
}

/** Fecha local "YYYY-MM-DD" y desfase (ms) de la zona respecto de UTC en ese instante. */
function enZona(timezone: string, instante: Date): { fecha: string; desfaseMs: number } {
  const partes = formateador(timezone).formatToParts(instante);
  const p = (tipo: string) => Number(partes.find((x) => x.type === tipo)?.value ?? 0);
  // Algunas versiones de ICU devuelven "24" para la medianoche con hour12:false.
  const comoUtc = Date.UTC(p("year"), p("month") - 1, p("day"), p("hour") % 24, p("minute"), p("second"));
  const fecha = new Date(comoUtc).toISOString().slice(0, 10);
  return { fecha, desfaseMs: comoUtc - Math.floor(instante.getTime() / 1000) * 1000 };
}

/** Instante UTC de la hora local `minutos` (desde medianoche) del día `fecha` en la zona. */
function instanteLocal(timezone: string, fecha: string, minutos: number): number {
  const [a, m, d] = fecha.split("-").map(Number);
  const comoUtc = Date.UTC(a, m - 1, d, 0, minutos);
  // Dos pasadas: la primera estima con el desfase del instante aproximado; la
  // segunda corrige si ese día cruza un cambio de horario de verano.
  let t = comoUtc - enZona(timezone, new Date(comoUtc)).desfaseMs;
  t = comoUtc - enZona(timezone, new Date(t)).desfaseMs;
  return t;
}

function aMinutos(hhmm: string | null): number | null {
  if (!hhmm) return null;
  const [h, m] = hhmm.split(":").map(Number);
  return Number.isFinite(h) && Number.isFinite(m) ? h * 60 + m : null;
}

function sumarDia(fecha: string): string {
  const [a, m, d] = fecha.split("-").map(Number);
  return new Date(Date.UTC(a, m - 1, d + 1)).toISOString().slice(0, 10);
}

/** Tope de días que se recorren: más que esto ya pasó de largo cualquier umbral razonable. */
const MAX_DIAS_RECORRIDOS = 14;

/**
 * Minutos HÁBILES (dentro del horario semanal del negocio, en su zona horaria,
 * descontando bloqueos/feriados) entre `desde` y `hasta`. Así "4 h sin mensajes"
 * significa 4 h con el local ABIERTO: una noche o un domingo cerrado no cuentan,
 * y un lunes a las 8 a. m. no alerta por el silencio del fin de semana.
 */
export function minutosHabilesEntre(desde: Date, hasta: Date, cfg: ConfigHorario): number {
  if (hasta.getTime() <= desde.getTime()) return 0;
  const tz = cfg.timezone;
  let fecha = enZona(tz, desde).fecha;
  const ultimaFecha = enZona(tz, hasta).fecha;
  let total = 0;
  for (let i = 0; i <= MAX_DIAS_RECORRIDOS && fecha <= ultimaFecha; i++, fecha = sumarDia(fecha)) {
    if ((cfg.bloqueos ?? []).some((b) => b.desde <= fecha && fecha <= b.hasta)) continue;
    const [a, m, d] = fecha.split("-").map(Number);
    const dia = cfg.horario?.[new Date(Date.UTC(a, m - 1, d)).getUTCDay()];
    const abre = aMinutos(dia?.abre ?? null);
    const cierra = aMinutos(dia?.cierra ?? null);
    if (abre === null || cierra === null || cierra <= abre) continue;
    const ini = Math.max(instanteLocal(tz, fecha, abre), desde.getTime());
    const fin = Math.min(instanteLocal(tz, fecha, cierra), hasta.getTime());
    if (fin > ini) total += (fin - ini) / 60_000;
  }
  return Math.round(total);
}

/** ¿Está el negocio dentro de su horario de atención en este instante? */
export function estaEnHorario(ahora: Date, cfg: ConfigHorario): boolean {
  // Un minuto hábil justo antes de `ahora` ⇔ el local está abierto ahora mismo.
  return minutosHabilesEntre(new Date(ahora.getTime() - 60_000), ahora, cfg) > 0;
}

/**
 * Tenants que llevan `umbralHoras` horas HÁBILES sin entrantes y que están
 * ABIERTOS ahora (fuera de horario el silencio es normal y no se alerta).
 * Excluye los que tienen la facturación cancelada (no se espera tráfico).
 */
export async function tenantsSinEntrantes(
  db: DB,
  tenants: Tenant[],
  umbralHoras: number,
  ahora: Date = new Date(),
): Promise<{ tenantId: string; horasHabiles: number }[]> {
  if (umbralHoras <= 0) return [];
  const candidatos = tenants.filter((t) => t.estadoFacturacion !== "cancelado" && estaEnHorario(ahora, t));
  if (candidatos.length === 0) return [];
  const ultimos = await ultimoEntrantePorTenant(db, candidatos.map((t) => t.id));
  const resultado: { tenantId: string; horasHabiles: number }[] = [];
  for (const t of candidatos) {
    const ultimo = ultimos.get(t.id);
    if (!ultimo) continue; // sin línea base: negocio sin ningún entrante todavía
    const horas = minutosHabilesEntre(ultimo, ahora, t) / 60;
    if (horas >= umbralHoras) resultado.push({ tenantId: t.id, horasHabiles: Math.round(horas * 10) / 10 });
  }
  return resultado;
}

// ── e) Cuota agotada ────────────────────────────────────────────────────────

/** Tenants al 100% (o más) de su tope mensual. Una sola consulta para todos. */
export async function tenantsConCuotaAgotada(db: DB, tenants: Tenant[]): Promise<{ tenantId: string; usados: number; tope: number }[]> {
  const filas = await db
    .select({ tenantId: waUsoMensual.tenantId, conversaciones: waUsoMensual.conversacionesIniciadas })
    .from(waUsoMensual)
    .where(eq(waUsoMensual.anioMes, anioMesActual()));
  const usoPorTenant = new Map(filas.map((f) => [f.tenantId, f.conversaciones]));
  const resultado: { tenantId: string; usados: number; tope: number }[] = [];
  for (const t of tenants) {
    const estado = calcularEstadoCuota(t, usoPorTenant.get(t.id) ?? 0);
    if (estado.excedido && estado.tope !== null) resultado.push({ tenantId: t.id, usados: estado.usados, tope: estado.tope });
  }
  return resultado;
}

// ── Evaluación conjunta ─────────────────────────────────────────────────────

/** Corre un detector sin dejar que su fallo tumbe a los demás (null = no se pudo evaluar). */
async function seguro<T>(nombre: string, fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch (e) {
    log.warn("vigilancia_detector_fallo", { detector: nombre, error: e instanceof Error ? e.message : String(e) });
    return null;
  }
}

/**
 * Corre todos los detectores y devuelve el resumen. NO emite alertas (eso lo hace
 * `emitirAlertas`): así `/salud?detalle=1` puede mostrarlo sin efectos de lado.
 */
export async function evaluarVigilancia(
  db: DB,
  opciones: { tenants?: Tenant[]; umbrales?: UmbralesVigilancia; ahora?: Date } = {},
): Promise<ResumenVigilancia> {
  const tenants = opciones.tenants ?? listarTenants();
  const u = opciones.umbrales ?? umbralesDesdeEnv();
  const ahora = opciones.ahora ?? new Date();

  const [masViejo, dlq, sinEntrantes, cuota] = await Promise.all([
    // Envuelto en un objeto: null de `seguro` = la consulta falló; `{ min: null }` = no hay pendientes.
    seguro("cola_atascada", async () => ({ min: await antiguedadPendienteMasViejoMin(db) })),
    seguro("dlq_reciente", () => jobsEnErrorRecientes(db, u.dlqVentanaMin)),
    seguro("tenant_sin_entrantes", () => tenantsSinEntrantes(db, tenants, u.sinEntrantesHoras, ahora)),
    seguro("cuota_agotada", () => tenantsConCuotaAgotada(db, tenants)),
  ]);

  const colaAtascada =
    masViejo === null
      ? null
      : {
          pendienteMasViejoMin: masViejo.min,
          umbralMin: u.colaAtascadaMin,
          atascada: masViejo.min !== null && masViejo.min > u.colaAtascadaMin,
        };
  const dlqReciente = dlq === null ? null : { ventanaMin: u.dlqVentanaMin, umbral: u.dlqUmbral, tenants: dlq.filter((d) => d.n >= u.dlqUmbral) };
  const resumen: ResumenVigilancia = {
    ok: true,
    colaAtascada,
    dlqReciente,
    sinEntrantes: sinEntrantes === null ? null : { umbralHoras: u.sinEntrantesHoras, tenants: sinEntrantes },
    tokensInvalidos: listarTokensInvalidos(),
    cuotaAgotada: cuota,
  };
  resumen.ok =
    !resumen.colaAtascada?.atascada &&
    (resumen.dlqReciente?.tenants.length ?? 0) === 0 &&
    (resumen.sinEntrantes?.tenants.length ?? 0) === 0 &&
    resumen.tokensInvalidos.length === 0 &&
    (resumen.cuotaAgotada?.length ?? 0) === 0;
  return resumen;
}

/** Emite (con deduplicación, ver alertas.ts) una alerta por cada hallazgo del resumen. */
export function emitirAlertas(r: ResumenVigilancia, ahora: number = Date.now()): number {
  let emitidas = 0;
  const emitir = (a: Alerta) => {
    if (alertarPlataforma(a, ahora)) emitidas++;
  };

  if (r.colaAtascada?.atascada) {
    emitir({
      tipo: "cola_atascada",
      severidad: "critica",
      mensaje: `El job pendiente más viejo de wa_jobs lleva ${r.colaAtascada.pendienteMasViejoMin} min esperando (umbral ${r.colaAtascada.umbralMin} min). ¿Worker caído?`,
      datos: { pendienteMasViejoMin: r.colaAtascada.pendienteMasViejoMin, umbralMin: r.colaAtascada.umbralMin },
    });
  }
  for (const d of r.dlqReciente?.tenants ?? []) {
    emitir({
      tipo: "dlq_reciente",
      tenantId: d.tenantId,
      severidad: "critica",
      mensaje: `${d.n} mensaje(s) quedaron sin responder (job en error) en los últimos ${r.dlqReciente!.ventanaMin} min. Revisar /panel/admin → DLQ.`,
      datos: { n: d.n, ventanaMin: r.dlqReciente!.ventanaMin },
    });
  }
  for (const s of r.sinEntrantes?.tenants ?? []) {
    emitir({
      tipo: "tenant_sin_entrantes",
      tenantId: s.tenantId,
      severidad: "aviso",
      mensaje: `${s.horasHabiles} h hábiles sin recibir mensajes estando abierto (umbral ${r.sinEntrantes!.umbralHoras} h). ¿Webhook de Meta desconectado?`,
      datos: { horasHabiles: s.horasHabiles, umbralHoras: r.sinEntrantes!.umbralHoras },
      cooldownMs: 6 * 60 * 60_000,
    });
  }
  for (const c of r.cuotaAgotada ?? []) {
    emitir({
      tipo: "cuota_agotada",
      tenantId: c.tenantId,
      severidad: "aviso",
      mensaje: `Llegó al 100% del tope mensual (${c.usados}/${c.tope} conversaciones): el bot pasó todo a humano. Ofrecer mejora de plan.`,
      datos: { usados: c.usados, tope: c.tope },
      cooldownMs: 24 * 60 * 60_000, // no cambia en todo el mes: una vez al día alcanza
    });
  }
  // Los tokens inválidos ya alertaron en el momento del envío (whatsapp/estadoToken.ts).
  return emitidas;
}

// ── Scheduler ───────────────────────────────────────────────────────────────

const NOMBRE_LIDERAZGO = "vigilancia";
const TITULAR_LIDERAZGO = randomUUID();

/**
 * Arranca la vigilancia periódica (`ALERTAS_INTERVALO_MIN`, default 5). Llamar
 * UNA vez, solo en procesos que corren trabajo de fondo y con DB (sin DB no hay
 * `wa_jobs` que vigilar).
 */
export function iniciarVigilancia(db: DB): void {
  const intervaloMs = Math.max(1, numeroDeEnv("ALERTAS_INTERVALO_MIN", 5)) * 60_000;
  iniciarCicloSinSolape({
    etiqueta: "vigilancia",
    intervaloMs,
    sugerenciaEscalado: "Subir ALERTAS_INTERVALO_MIN si los detectores tardan más que el intervalo.",
    tick: async () => {
      if (!(await intentarLiderazgo(db, NOMBRE_LIDERAZGO, TITULAR_LIDERAZGO, intervaloMs * 3))) return;
      const resumen = await evaluarVigilancia(db);
      const emitidas = emitirAlertas(resumen);
      if (!resumen.ok) log.info("vigilancia_resumen", { ok: resumen.ok, alertasEmitidas: emitidas });
    },
    onError: (e, momento) => {
      console.error(`[vigilancia] ${momento}:`, e);
      capturarError(e, { loop: "vigilancia", momento });
    },
  });
  console.log(`Vigilancia de bot mudo activa (cada ${intervaloMs / 60_000} min).`);
}
