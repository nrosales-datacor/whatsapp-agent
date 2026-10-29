import { timingSafeEqual } from "node:crypto";
import type { ServerResponse } from "node:http";
import { sql } from "drizzle-orm";
import type { Executor } from "../db/scope";
import { PRODUCT_NAME } from "../brand";

// ─────────────────────────────────────────────────────────────────────────────
// Health check real: `/health` no responde 200 con solo el proceso de Node vivo, sino
// después de un ping a la base (con timeout corto). Es lo que miran el smoke del deploy
// (ci-cd.yml, `curl -sf`) y el monitor de uptime: 200 = sano, 503 = degradado.
//
// `?detail=1&token=<HEALTH_DETAIL_TOKEN>` es el modo humano: JSON con cada chequeo, para
// depurar. Va con token porque el detalle incluye mensajes de error internos; sin la env
// configurada (o con un token que no coincide) se responde lo mismo que el GET plano.
// El monitor automático solo hace el GET plano.
//
// Vive separado del servidor a propósito: server.ts tiene efectos de lado (top-level
// await, listen, loops) que lo hacen imposible de importar en un test; `checkHealth`
// recibe el `db` ya abierto y se prueba directo contra un Postgres efímero (PGlite).
// ─────────────────────────────────────────────────────────────────────────────

// Timeout corto para el SELECT 1: un monitor no debe esperar más de un par de segundos, y
// si la base está lenta o colgada eso YA es la señal de "503".
const DB_TIMEOUT_MS = (() => {
  const n = Number(process.env.HEALTH_DB_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : 1500;
})();

export interface DbHealth {
  /** "postgres" = DATABASE_URL; "pglite" = Postgres local en el proceso (desarrollo). */
  kind: "postgres" | "pglite";
  /** true si el SELECT 1 respondió dentro del timeout. */
  ok: boolean;
  latencyMs: number | null;
  error?: string;
}

export interface HealthReport {
  ok: boolean;
  uptimeSec: number;
  /** Rol del proceso (web / worker / all), si el llamador lo pasa. */
  role?: string;
  db: DbHealth;
}

/** `SELECT 1` con timeout corto. No lanza: devuelve el resultado, ok o no. */
async function pingDb(db: Executor): Promise<Omit<DbHealth, "kind">> {
  const start = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      db.execute(sql`SELECT 1`),
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`sin respuesta en ${DB_TIMEOUT_MS}ms`)), DB_TIMEOUT_MS);
        timer.unref?.();
      }),
    ]);
    return { ok: true, latencyMs: Date.now() - start };
  } catch (e) {
    return { ok: false, latencyMs: null, error: e instanceof Error ? e.message : String(e) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Corre los chequeos y arma el reporte. `db` es el mismo pool que ya tiene abierto el
 * servidor: esta función NUNCA abre una conexión propia. Crítico (→ 503): la base no
 * respondió a tiempo.
 */
export async function checkHealth(db: Executor, options: { role?: string } = {}): Promise<HealthReport> {
  const dbHealth: DbHealth = { kind: process.env.DATABASE_URL ? "postgres" : "pglite", ...(await pingDb(db)) };
  return {
    ok: dbHealth.ok,
    uptimeSec: Math.round(process.uptime()),
    ...(options.role ? { role: options.role } : {}),
    db: dbHealth,
  };
}

/** 200 en el camino feliz, 503 si `checkHealth` marcó algo crítico. */
export function healthStatusCode(report: HealthReport): 200 | 503 {
  return report.ok ? 200 : 503;
}

/** ¿El token de `?token=` coincide con HEALTH_DETAIL_TOKEN? (tiempo constante; sin la env, nunca). */
export function isHealthDetailTokenValid(given: string | null): boolean {
  const expected = process.env.HEALTH_DETAIL_TOKEN;
  if (!expected || !given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Responde `/health`: texto plano para el monitor, o JSON con `?detail=1&token=…`. */
export async function serveHealth(res: ServerResponse, url: URL, db: Executor, options: { role?: string } = {}): Promise<void> {
  const report = await checkHealth(db, options);
  const code = healthStatusCode(report);
  const withDetail = url.searchParams.get("detail") === "1" && isHealthDetailTokenValid(url.searchParams.get("token"));
  if (withDetail) {
    res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(JSON.stringify(report));
    return;
  }
  res.writeHead(code, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
  res.end(code === 200 ? `${PRODUCT_NAME}: ok` : `${PRODUCT_NAME}: degradado`);
}
