import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { schema } from "./schema";

// Crea el cliente Drizzle a partir de DATABASE_URL. Cada llamada abre un pool de
// conexiones NUEVO: el código de producción usa siempre `obtenerDb()` (un pool por
// proceso, F7).
//
// Para Supabase se activan dos cosas automáticamente:
//   • ssl: "require"  → Supabase exige conexión cifrada.
//   • prepare: false  → necesario si se usa el pooler en modo transacción (puerto 6543).
//
// `max` (DB_POOL_MAX, default 10): dimensionarlo contra el límite del pooler dividido por
// la cantidad de procesos.
export function crearDb(url = process.env.DATABASE_URL) {
  if (!url) throw new Error("Falta DATABASE_URL para conectar a PostgreSQL");
  const esSupabase = /supabase\.(co|com)/.test(url);
  const max = Number(process.env.DB_POOL_MAX ?? 10);
  const sql = esSupabase ? postgres(url, { ssl: "require", prepare: false, max }) : postgres(url, { max });
  return drizzle(sql, { schema });
}

let poolGlobal: ReturnType<typeof crearDb> | null = null;

/** Pool único por proceso. Lanza el mismo error que `crearDb` si falta DATABASE_URL. */
export function obtenerDb(): ReturnType<typeof crearDb> {
  if (!poolGlobal) poolGlobal = crearDb();
  return poolGlobal;
}

/** true si el proceso tiene base: DATABASE_URL configurada o una base local/inyectada. */
export function hayBaseDeDatos(): boolean {
  return poolGlobal !== null || !!process.env.DATABASE_URL;
}

/**
 * Sin DATABASE_URL (desarrollo, E2E, evals): Postgres REAL en el mismo proceso (PGlite)
 * con las migraciones de ./drizzle. Así no existe un "modo sin base" con otra
 * implementación de los datos: dev y tests corren el mismo SQL que producción.
 *
 * `PGLITE_DIR` persiste los datos en esa carpeta entre reinicios; sin ella, en memoria.
 * PGlite es dependencia de desarrollo: en producción nunca se llega acá (server.ts exige
 * DATABASE_URL con NODE_ENV=production).
 */
export async function iniciarDbLocal(dir = process.env.PGLITE_DIR): Promise<ReturnType<typeof crearDb>> {
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle: drizzlePglite } = await import("drizzle-orm/pglite");
  const { migrate } = await import("drizzle-orm/pglite/migrator");
  const cliente = dir ? new PGlite(dir) : new PGlite();
  const db = drizzlePglite(cliente, { schema });
  await migrate(db, { migrationsFolder: "./drizzle" });
  // Mismo API de consultas que postgres.js (ver test/helpers/pgliteDb.ts y src/db/filas.ts).
  poolGlobal = db as unknown as ReturnType<typeof crearDb>;
  return poolGlobal;
}

// Solo para tests: descarta el singleton para que el próximo `obtenerDb()` abra un pool
// nuevo.
export function _resetPoolParaTests(): void {
  poolGlobal = null;
}

// Solo para tests: `obtenerDb()` devuelve una base inyectada (PGlite efímero, ver
// test/helpers/pgliteDb.ts) en vez de abrir un pool contra DATABASE_URL.
export function _inyectarDbParaTests(db: unknown): void {
  poolGlobal = db as ReturnType<typeof crearDb>;
}
