import { sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { schema } from "./db/schema";
import { filasDe } from "./db/filas";
import { conSistema } from "./db/alcance";
import { fuenteCacheTenants, listarTenants } from "./config/tenantStore";
import { dependeDelTokenGlobal } from "./whatsapp/client";
import { listarTokensInvalidos } from "./whatsapp/estadoToken";
import { evaluarVigilancia, type ResumenVigilancia } from "./observabilidad/vigilancia";

// ─────────────────────────────────────────────────────────────────────────────
// Health check real (ROADMAP E10 / AUDIT.md BLOQUEANTE-11).
//
// Antes, `/salud` devolvía 200 con solo el proceso de Node vivo: no miraba la
// base, ni si el caché de tenants estaba en el fallback hardcodeado (el bot
// atendiendo con la config equivocada de un tenant que no es), ni la cola.
//
// Este módulo vive SEPARADO de server.ts a propósito: server.ts tiene efectos
// de lado (top-level await, server.listen, workers) que lo hacen imposible de
// importar en un test unitario sin levantar todo el proceso. `chequearSalud`
// es una función pura de I/O (recibe el `db` ya abierto, no crea nada) que se
// puede probar directo contra un Postgres efímero (PGlite) sin tocar HTTP.
// ─────────────────────────────────────────────────────────────────────────────

type DB = PostgresJsDatabase<typeof schema>;

// Timeout corto para el SELECT 1: un monitor de uptime no debe esperar más de un
// par de segundos, y si la base está lenta/colgada eso YA es la señal de "503".
// Configurable por env para no hardcodear un número mágico, mismo patrón que
// src/red/timeouts.ts (msDeEnv), sin importar ese archivo para no acoplar un
// timeout de red HTTP con uno de ping a Postgres.
const TIMEOUT_DB_MS = (() => {
  const n = Number(process.env.SALUD_DB_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : 1500;
})();

export interface SaludDb {
  /** false si no hay DATABASE_URL configurada (modo memoria/dev): no es un fallo. */
  configurada: boolean;
  /** true si el SELECT 1 respondió dentro del timeout. Solo relevante si `configurada`. */
  ok: boolean;
  latenciaMs: number | null;
  error?: string;
}

export interface SaludTenants {
  cargados: number;
  /** "db" = caché real; "fallback" = tenant hardcodeado (bot atendiendo mal). */
  fuente: "db" | "fallback";
}

export interface SaludTokenGlobal {
  /** Cuántos tenants están enviando con el token compartido en vez del propio. */
  dependientes: number;
  total: number;
}

export interface SaludCola {
  /** null si no hay DB (no existe wa_jobs sin ella) o si la consulta falló. */
  pendientes: number | null;
  enError: number | null;
}

export interface SaludDetalle {
  ok: boolean;
  uptimeSeg: number;
  db: SaludDb;
  tenants: SaludTenants;
  tokenGlobal: SaludTokenGlobal;
  cola: SaludCola;
  /**
   * Detectores de "bot mudo" (observabilidad/vigilancia.ts): cola atascada, DLQ
   * reciente, tenants sin entrantes en horario, tokens inválidos y cuota agotada.
   * Solo con `?detalle=1` (`incluirVigilancia`). INFORMATIVO: no cambia el 200/503
   * — un 503 por, p.ej., un tenant sin mensajes haría fallar el smoke del deploy
   * y el uptime monitor por algo que no es una caída de la plataforma; esas
   * señales salen por el canal de alertas (observabilidad/alertas.ts).
   * Sin datos personales: solo tenantIds, conteos y tiempos.
   */
  vigilancia?: ResumenVigilancia | SaludVigilanciaSinDb;
}

/** Sin DB no hay wa_jobs ni uso mensual: solo se puede mostrar lo que vive en memoria. */
export interface SaludVigilanciaSinDb {
  tokensInvalidos: ReturnType<typeof listarTokensInvalidos>;
}

export interface OpcionesSalud {
  /** true = agrega el resumen de los detectores (`/salud?detalle=1`). */
  incluirVigilancia?: boolean;
}

/** `SELECT 1` con timeout corto. No lanza: devuelve el resultado, ok o no. */
async function pingDb(db: DB): Promise<{ ok: boolean; latenciaMs: number | null; error?: string }> {
  const inicio = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      db.execute(sql`SELECT 1`),
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`sin respuesta en ${TIMEOUT_DB_MS}ms`)), TIMEOUT_DB_MS);
        timer.unref?.();
      }),
    ]);
    return { ok: true, latenciaMs: Date.now() - inicio };
  } catch (e) {
    return { ok: false, latenciaMs: null, error: e instanceof Error ? e.message : String(e) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Profundidad de la cola: solo el número (pendientes + en error), SIN lógica de
 * detección de crecimiento — eso sería sobre-ingeniería para este ítem (ver E10
 * en ROADMAP.md). Un humano mirando el detalle decide si el número es razonable.
 */
async function contarCola(db: DB): Promise<SaludCola> {
  try {
    const filas = filasDe<{ estado: string; n: number }>(
      await conSistema(db, (tx) =>
        tx.execute(sql`
          SELECT estado, count(*)::int AS n
            FROM wa_jobs
           WHERE estado IN ('pendiente', 'error')
           GROUP BY estado
        `),
      ),
    );
    const porEstado = new Map(filas.map((f) => [f.estado, f.n]));
    return { pendientes: porEstado.get("pendiente") ?? 0, enError: porEstado.get("error") ?? 0 };
  } catch {
    // No tirar todo el health check por esto: es información complementaria, no
    // un criterio de 503 (eso lo decide únicamente el ping de arriba y la fuente
    // del caché de tenants).
    return { pendientes: null, enError: null };
  }
}

/**
 * Corre todos los chequeos y arma el detalle completo. `db` es el mismo pool que
 * ya tiene abierto server.ts (o `null` en modo memoria) — esta función NUNCA abre
 * una conexión propia, respeta el singleton de F7 (`obtenerDb()`).
 */
export async function chequearSalud(db: DB | null, opciones: OpcionesSalud = {}): Promise<SaludDetalle> {
  const tenants = listarTenants();
  const fuente = fuenteCacheTenants();
  const dependientes = tenants.filter(dependeDelTokenGlobal).length;

  const dbEstado: SaludDb = db
    ? { configurada: true, ...(await pingDb(db)) }
    : { configurada: false, ok: true, latenciaMs: null };

  const cola: SaludCola = db ? await contarCola(db) : { pendientes: null, enError: null };

  // Crítico (→ 503) en dos casos, ambos son degradación silenciosa real:
  //  1) hay DATABASE_URL configurada y el SELECT 1 no respondió a tiempo.
  //  2) hay DATABASE_URL configurada pero el caché de tenants sigue en el
  //     fallback hardcodeado — el escenario exacto de BLOQUEANTE-11: el bot
  //     puede estar atendiendo con la config de OTRO negocio.
  // Sin DATABASE_URL (desarrollo/demo con la base local PGlite, sin negocios sembrados)
  // el fallback es el modo NORMAL, no una falla: por eso ambos chequeos van
  // condicionados a que haya una base CONFIGURADA, no a que haya base a secas.
  const conDb = !!process.env.DATABASE_URL;
  const critico = conDb && (!dbEstado.ok || fuente === "fallback");

  const detalle: SaludDetalle = {
    ok: !critico,
    uptimeSeg: Math.round(process.uptime()),
    db: dbEstado,
    tenants: { cargados: tenants.length, fuente },
    tokenGlobal: { dependientes, total: tenants.length },
    cola,
  };
  if (opciones.incluirVigilancia) {
    // Con la DB caída los detectores fallarían uno por uno (cada uno ya se protege
    // solo, ver `seguro` en vigilancia.ts): no vale la pena ni intentarlo.
    detalle.vigilancia =
      db && dbEstado.ok ? await evaluarVigilancia(db, { tenants }) : { tokensInvalidos: listarTokensInvalidos() };
  }
  return detalle;
}

/** 200 en el camino feliz, 503 si `chequearSalud` marcó algo crítico. */
export function codigoHttpSalud(detalle: SaludDetalle): 200 | 503 {
  return detalle.ok ? 200 : 503;
}
