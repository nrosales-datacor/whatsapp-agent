import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { schema } from "./schema";

// Crea el cliente Drizzle a partir de DATABASE_URL. Cada llamada abre un pool
// de conexiones NUEVO — la usan los tests que inyectan su propia conexión
// (PGlite efímero) y `obtenerDb()` más abajo, que la envuelve en un singleton
// para el resto del código. No llamar directo desde código de producción:
// llamar siempre a `obtenerDb()` (ver comentario de F7).
//
// Para Supabase se activan dos cosas automáticamente:
//   • ssl: "require"  → Supabase exige conexión cifrada.
//   • prepare: false  → necesario si se usa el pooler en modo transacción
//     (puerto 6543); es inofensivo en conexión directa/sesión.
//
// `max` explícito (DB_POOL_MAX, default 10 = el default de postgres.js): antes
// del ROADMAP F7 esto quedaba implícito y cada uno de los ~5 módulos que
// hablan directo con Postgres abría su propio pool de ~10 conexiones → ~50
// conexiones desde UN proceso. Fijarlo acá deja el número visible y ajustable
// por env sin tocar código cuando se dimensione contra el pooler de Supabase.
export function crearDb(url = process.env.DATABASE_URL) {
  if (!url) throw new Error("Falta DATABASE_URL para conectar a PostgreSQL");
  const esSupabase = /supabase\.(co|com)/.test(url);
  const max = Number(process.env.DB_POOL_MAX ?? 10);
  const sql = esSupabase ? postgres(url, { ssl: "require", prepare: false, max }) : postgres(url, { max });
  return drizzle(sql, { schema });
}

// ─────────────────────────────────────────────────────────────────────────────
// Singleton por proceso (ROADMAP F7). `crearDb()` abre un pool nuevo en cada
// llamada; antes de esto, `server.ts`, `tenantStore.ts`, `uso.ts`,
// `campaigns/db.ts` y `rescate/db.ts` cada uno mantenía su PROPIO lazy
// singleton llamando a `crearDb()` una vez — es decir, 5 pools de ~10
// conexiones cada uno desde un solo proceso. Al separar web/worker (F6) ese
// número se multiplica por réplica y revienta el límite de conexiones del
// pooler de Supabase. `obtenerDb()` centraliza el singleton acá: todo el
// código de producción comparte UN pool por proceso.
// ─────────────────────────────────────────────────────────────────────────────
let poolGlobal: ReturnType<typeof crearDb> | null = null;

/** Pool único por proceso. Lanza el mismo error que `crearDb` si falta DATABASE_URL. */
export function obtenerDb(): ReturnType<typeof crearDb> {
  if (!poolGlobal) poolGlobal = crearDb();
  return poolGlobal;
}

// Solo para tests: descarta el singleton para que el próximo `obtenerDb()`
// abra un pool nuevo. Sin esto no habría forma de verificar el reseteo (ni de
// aislar un test de la conexión que dejó abierta el anterior) sin depender del
// orden de ejecución de la suite.
export function _resetPoolParaTests(): void {
  poolGlobal = null;
}

// Solo para tests: hace que `obtenerDb()` devuelva una base inyectada (PGlite
// efímero, ver test/helpers/pgliteDb.ts) en vez de abrir un pool contra
// DATABASE_URL. Permite ejercer el router y el tenantStore REALES de punta a
// punta contra Postgres sin levantar un servidor.
export function _inyectarDbParaTests(db: unknown): void {
  poolGlobal = db as ReturnType<typeof crearDb>;
}
