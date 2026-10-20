import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { schema } from "./schemaRegistry";

// Crea el cliente Drizzle a partir de DATABASE_URL. Cada llamada abre un pool de
// conexiones NUEVO: el código de producción usa siempre `getDb()` (un pool por proceso).
//
// Para Supabase se activan dos cosas automáticamente:
//   • ssl: "require"  → Supabase exige conexión cifrada.
//   • prepare: false  → necesario si se usa el pooler en modo transacción (puerto 6543).
//
// `max` (DB_POOL_MAX, default 10): dimensionarlo contra el límite del pooler dividido por
// la cantidad de procesos.
export function createDb(url = process.env.DATABASE_URL) {
  if (!url) throw new Error("Falta DATABASE_URL para conectar a PostgreSQL");
  const isSupabase = /supabase\.(co|com)/.test(url);
  const max = Number(process.env.DB_POOL_MAX ?? 10);
  const sql = isSupabase ? postgres(url, { ssl: "require", prepare: false, max }) : postgres(url, { max });
  return drizzle(sql, { schema });
}

export type AppDb = ReturnType<typeof createDb>;

let globalPool: AppDb | null = null;

/** Pool único por proceso. Lanza el mismo error que `createDb` si falta DATABASE_URL. */
export function getDb(): AppDb {
  if (!globalPool) globalPool = createDb();
  return globalPool;
}

/** Carpeta de las migraciones de Drizzle (la misma que `drizzle.config.ts`). */
export const MIGRATIONS_FOLDER = "./drizzle";

/**
 * Extensiones de Postgres que el esquema necesita y que PGlite trae aparte (en
 * `contrib`): sin cargarlas al construir el cliente, `CREATE EXTENSION` de la
 * migración base falla. `btree_gist` hace falta para el `EXCLUDE` de las citas.
 * Import dinámico: PGlite es dependencia de desarrollo.
 */
export async function pgliteExtensions() {
  const { btree_gist } = await import("@electric-sql/pglite/contrib/btree_gist");
  return { btree_gist };
}

/**
 * Sin DATABASE_URL (desarrollo, E2E): Postgres REAL en el mismo proceso (PGlite) con las
 * migraciones de ./drizzle. Así no existe un "modo sin base" con otra implementación de
 * los datos: dev y tests corren el mismo SQL que producción.
 *
 * `PGLITE_DIR` persiste los datos en esa carpeta entre reinicios; sin ella, en memoria.
 * En producción nunca se llega acá (server.ts exige DATABASE_URL con NODE_ENV=production).
 */
export async function startLocalDb(dir = process.env.PGLITE_DIR): Promise<AppDb> {
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle: drizzlePglite } = await import("drizzle-orm/pglite");
  const { migrate } = await import("drizzle-orm/pglite/migrator");
  const extensions = await pgliteExtensions();
  const client = dir ? new PGlite(dir, { extensions }) : new PGlite({ extensions });
  const db = drizzlePglite(client, { schema });
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  // Mismo API de consultas que postgres.js (ver test/helpers/pgliteDb.ts y ./rows.ts).
  globalPool = db as unknown as AppDb;
  return globalPool;
}

/** Solo para tests: descarta el singleton para que el próximo `getDb()` abra un pool nuevo. */
export function _resetPoolForTests(): void {
  globalPool = null;
}

/**
 * Solo para tests: `getDb()` devuelve una base inyectada (PGlite efímero, ver
 * test/helpers/pgliteDb.ts) en vez de abrir un pool contra DATABASE_URL.
 */
export function _injectDbForTests(db: unknown): void {
  globalPool = db as AppDb;
}
