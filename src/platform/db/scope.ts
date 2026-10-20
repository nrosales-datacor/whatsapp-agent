import { sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { Schema } from "./schemaRegistry";

// ─────────────────────────────────────────────────────────────────────────────
// Alcance de cada operación contra la base (Row Level Security).
//
// Vocabulario: en la plataforma, "tenant" = el negocio (en el esquema, la columna
// `business_id`). Las políticas de src/platform/db/rls.ts dejan ver una fila al rol de
// la app (`app_runtime`, sin BYPASSRLS) solo si la transacción fijó uno de estos dos
// contextos:
//   • withTenant(db, tenantId, fn): `app.tenant_id` → filas de ESE negocio y nada más.
//   • withSystem(db, fn): `app.system = on` → todas las filas. Solo para procesos que son
//     cross-tenant por diseño (claim de las colas, schedulers, caché de ruteo, acciones
//     del superadmin). Cada uso es explícito y se puede auditar con un grep.
//
// `set_config(..., true)` es LOCAL a la transacción: se borra al COMMIT/ROLLBACK, así que
// una conexión del pool nunca queda con el contexto de otro negocio. Funciona igual con
// el pooler de Supabase en modo sesión o transacción.
//
// Mientras la app se conecte como `postgres` (BYPASSRLS), las políticas no aplican y
// esto solo fija variables. Con DATABASE_URL apuntando a `app_runtime` el aislamiento
// lo garantiza la base (scripts/rls/01-app-role.sql).
// ─────────────────────────────────────────────────────────────────────────────

export type Db = PostgresJsDatabase<Schema>;

/** Transacción de Drizzle: mismo API de consultas que `Db`. */
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** Algo contra lo que se pueden correr consultas: la base o una transacción abierta. */
export type Executor = Db | Tx;

// Los ids de negocio son uuid (PLAN-GESTION.md §4) y las políticas comparan contra
// `::uuid`: un id con otra forma reventaría DENTRO de la consulta con un error opaco de
// Postgres. Se rechaza acá, antes de abrir la transacción, con un mensaje claro.
const RE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** true si `id` tiene forma de uuid (lo que exige `withTenant`). */
export function isTenantId(id: unknown): id is string {
  return typeof id === "string" && RE_UUID.test(id);
}

/** Corre `fn` en una transacción acotada al negocio `tenantId`. */
export function withTenant<T>(db: Executor, tenantId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  if (!isTenantId(tenantId)) return Promise.reject(new Error("withTenant: tenantId inválido (se espera un uuid)"));
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.tenant_id', ${tenantId}, true)`);
    return fn(tx);
  });
}

/** Corre `fn` en una transacción con acceso a todos los negocios (procesos de sistema). */
export function withSystem<T>(db: Executor, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.system', 'on', true)`);
    return fn(tx);
  });
}
