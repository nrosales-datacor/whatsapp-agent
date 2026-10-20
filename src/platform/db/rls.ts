import { sql } from "drizzle-orm";
import { pgPolicy, pgRole } from "drizzle-orm/pg-core";

// ─────────────────────────────────────────────────────────────────────────────
// Row Level Security: el rol de la app y las dos políticas que lleva TODA tabla.
//
// Toda tabla tiene RLS activo y una política para el rol de la app (`app_runtime`, sin
// BYPASSRLS). Cada operación de la app corre en una transacción que fija UNO de estos dos
// contextos (ver ./scope.ts):
//   • `app.tenant_id` (withTenant): solo ve/escribe filas de ese negocio.
//   • `app.system = on` (withSystem): procesos cross-tenant explícitos (claim de las
//     colas, schedulers, caché de ruteo, superadmin).
// Sin ninguno de los dos, el rol de la app no ve ni una fila. `anon`/`authenticated`
// (Data API de Supabase) no tienen política: no ven nada. El rol `postgres` tiene
// BYPASSRLS: las políticas solo aplican cuando DATABASE_URL apunta a `app_runtime`
// (scripts/rls/01-app-role.sql). test/security/rls.test.ts exige que toda tabla de
// src/**/schema.ts use una de las dos.
// ─────────────────────────────────────────────────────────────────────────────

/** Nombre del rol de la app (sin BYPASSRLS). Lo crea NOLOGIN la migración base; el login se le da a mano. */
export const APP_ROLE = "app_runtime";

/** Rol de la app para las políticas. `.existing()`: drizzle-kit no lo crea ni lo borra. */
export const appRuntimeRole = pgRole(APP_ROLE).existing();

const IS_SYSTEM = "current_setting('app.system', true) = 'on'";

/**
 * Política estándar de una tabla de negocio: filas del negocio de la transacción, o
 * contexto de sistema. `column` es la columna uuid con el id del negocio.
 *
 * `nullif(…, '')`: una vez que una conexión fijó el GUC (aunque sea LOCAL), al terminar
 * la transacción `current_setting` devuelve '' en vez de NULL, y `''::uuid` reventaría la
 * consulta. Con nullif, sin contexto la comparación da NULL → no ve la fila. Comparar
 * contra `::uuid` (y no castear la columna a texto) deja usar el índice de la columna.
 */
export function tenantPolicy(column = "business_id") {
  const condition = sql.raw(`${column} = nullif(current_setting('app.tenant_id', true), '')::uuid OR ${IS_SYSTEM}`);
  return pgPolicy("tenant_isolation", { for: "all", to: appRuntimeRole, using: condition, withCheck: condition });
}

/** Tablas sin dueño (infraestructura): solo procesos de sistema. */
export function systemOnlyPolicy() {
  const condition = sql.raw(IS_SYSTEM);
  return pgPolicy("system_only", { for: "all", to: appRuntimeRole, using: condition, withCheck: condition });
}
