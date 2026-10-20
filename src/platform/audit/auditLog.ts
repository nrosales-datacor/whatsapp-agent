import { desc, eq, isNull } from "drizzle-orm";
import { auditLog } from "../db/schema";
import { withSystem, withTenant, type Executor } from "../db/scope";

// ─────────────────────────────────────────────────────────────────────────────
// Acceso a datos de `audit_log`: registro append-only de operaciones sensibles (pausar o
// dar de baja un negocio, reconectar una integración, borrar un cliente final, logins
// del superadmin, resets de clave). SOLO acceso a datos: recibe el `db`/`tx` del llamador
// para poder escribir DENTRO de la misma transacción que la operación auditada (o queda
// la operación Y su rastro, o ninguno de los dos).
//
// Entradas de un negocio: `tenantId` = su id (política por negocio). Entradas de
// plataforma (p. ej. el login del superadmin): `tenantId = null`, que solo ve el contexto
// de sistema.
//
// Regla de oro: `details` nunca lleva datos personales ni secretos (ver `auditLog` en
// src/platform/db/schema.ts).
// ─────────────────────────────────────────────────────────────────────────────

/** Acción auditada en snake_case, p. ej. "business_paused", "admin_login", "password_reset". */
export type AuditAction = string;

export interface AuditEntry {
  id: string;
  /** null = entrada de plataforma (no de un negocio). */
  tenantId: string | null;
  action: AuditAction;
  actor: string;
  details: Record<string, unknown>;
  createdAt: string; // ISO
}

/** Actor de una operación hecha por un usuario del panel. */
export function userActor(userId: string): string {
  return `user:${userId}`;
}

/** Actor de una operación del superadmin (sesión aparte, sin fila en la base). */
export function superadminActor(username: string): string {
  return `superadmin:${username}`;
}

/** Agrega una entrada. `tenantId = null` para las de plataforma. */
export async function recordAudit(
  db: Executor,
  tenantId: string | null,
  action: AuditAction,
  actor: string,
  details: Record<string, unknown> = {},
): Promise<void> {
  const row = { businessId: tenantId, action, actor, details };
  if (tenantId === null) await withSystem(db, (tx) => tx.insert(auditLog).values(row));
  else await withTenant(db, tenantId, (tx) => tx.insert(auditLog).values(row));
}

type AuditRow = typeof auditLog.$inferSelect;

function toEntry(r: AuditRow): AuditEntry {
  return {
    id: r.id,
    tenantId: r.businessId,
    action: r.action,
    actor: r.actor,
    details: r.details,
    createdAt: r.createdAt.toISOString(),
  };
}

/** Rastro de un negocio, MÁS RECIENTE PRIMERO. */
export async function listTenantAudit(db: Executor, tenantId: string, limit = 100): Promise<AuditEntry[]> {
  const rows = await withTenant(db, tenantId, (tx) =>
    tx.select().from(auditLog).where(eq(auditLog.businessId, tenantId)).orderBy(desc(auditLog.createdAt)).limit(limit),
  );
  return rows.map(toEntry);
}

/** Rastro de plataforma (entradas sin negocio), MÁS RECIENTE PRIMERO. */
export async function listPlatformAudit(db: Executor, limit = 100): Promise<AuditEntry[]> {
  const rows = await withSystem(db, (tx) =>
    tx.select().from(auditLog).where(isNull(auditLog.businessId)).orderBy(desc(auditLog.createdAt)).limit(limit),
  );
  return rows.map(toEntry);
}
