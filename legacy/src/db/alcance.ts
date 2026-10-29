import { sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { schema } from "./schema";

// ─────────────────────────────────────────────────────────────────────────────
// Alcance de cada operación contra la base (F1, Row Level Security).
//
// Las políticas de src/db/schema.ts dejan ver una fila al rol de la app (`app_wa`) solo
// si la transacción fijó uno de estos dos contextos:
//   • conTenant(db, tenantId, fn): `app.tenant_id` → filas de ESE negocio y nada más.
//   • conSistema(db, fn): `app.sistema = on` → todas las filas. Solo para procesos que son
//     cross-tenant por diseño (claim de las colas, caché de tenants, schedulers, acciones
//     del superadmin). Cada uso es explícito y se puede auditar con un grep.
//
// `set_config(..., true)` es LOCAL a la transacción: se borra al COMMIT/ROLLBACK, así que
// una conexión del pool nunca queda con el contexto de otro negocio. Funciona igual con
// el pooler de Supabase en modo sesión o transacción.
//
// Mientras la app siga conectada como `postgres` (BYPASSRLS), las políticas no aplican y
// esto solo fija variables. Recién al repuntar DATABASE_URL a `app_wa` el aislamiento
// pasa a garantizarlo la base (scripts/rls/01-rol-aplicacion.sql).
// ─────────────────────────────────────────────────────────────────────────────

export type DB = PostgresJsDatabase<typeof schema>;

/** Transacción de Drizzle: mismo API de consultas que `DB`. */
export type Tx = Parameters<Parameters<DB["transaction"]>[0]>[0];

/** Algo contra lo que se pueden correr consultas: la base o una transacción abierta. */
export type Ejecutor = DB | Tx;

/** Corre `fn` en una transacción acotada al negocio `tenantId`. */
export function conTenant<T>(db: Ejecutor, tenantId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  if (!tenantId) return Promise.reject(new Error("conTenant: falta el tenantId"));
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.tenant_id', ${tenantId}, true)`);
    return fn(tx);
  });
}

/** Corre `fn` en una transacción con acceso a todos los negocios (procesos de sistema). */
export function conSistema<T>(db: Ejecutor, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.sistema', 'on', true)`);
    return fn(tx);
  });
}
