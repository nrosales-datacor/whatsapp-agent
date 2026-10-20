import { and, desc, eq, inArray } from "drizzle-orm";
import { waAuditoria } from "../db/schema";
import { conSistema, conTenant, type Ejecutor } from "../db/alcance";

// ─────────────────────────────────────────────────────────────────────────────
// Acceso a datos de `wa_auditoria` (revisión pre-venta 2026-10): log append-only
// de operaciones de plataforma (pausar/reactivar, reconectar WhatsApp, borrar un
// cliente final, baja de negocio). Mismo estilo que `tenantsHistorial.ts`: SOLO
// acceso a datos, recibe el `db`/`tx` del caller para poder escribir DENTRO de la
// misma transacción que la operación auditada (o queda la operación Y su rastro,
// o ninguno de los dos).
//
// Regla de oro: `detalle` nunca lleva datos personales ni secretos (ver el
// comentario de `waAuditoria` en schema.ts).
// ─────────────────────────────────────────────────────────────────────────────


export type AccionAuditoria =
  | "pausar"
  | "reactivar"
  | "reconectar_whatsapp"
  | "borrar_cliente"
  | "baja_tenant"
  | "baja_storage_pendiente"
  // Revisión de seguridad pre-venta 2026-10: rastro de lo que hace el superadmin.
  | "login_admin" // login correcto del superadmin (tenant_id = TENANT_PLATAFORMA)
  | "login_admin_rechazado" // clave correcta pero código TOTP inválido o reusado
  | "export_tenant" // export completo de un negocio (hoy: el que acompaña a la baja)
  | "reset_clave"; // reset de la clave de un usuario de panel desde el admin

/**
 * `tenant_id` de las entradas que no son de un negocio sino de la plataforma (login del
 * superadmin). Empieza con "_", que un slug de negocio no puede tener (RE_SLUG del alta),
 * así que nunca choca con un negocio real. Se consulta con `listarAuditoriaTenant`.
 */
export const TENANT_PLATAFORMA = "_plataforma";

export interface EntradaAuditoria {
  id: string;
  tenantId: string;
  accion: AccionAuditoria;
  actor: string;
  detalle: Record<string, unknown>;
  creadoEn: string; // ISO
}

/** Actor de una operación del superadmin (sesión aparte, sin id en wa_usuarios). */
export function actorSuperadmin(): string {
  return `superadmin:${process.env.PANEL_SUPERADMIN_USUARIO ?? "admin"}`;
}

/** Actor de una operación hecha desde el panel del negocio (dueño/operador). */
export function actorUsuario(usuarioId: string): string {
  return `usuario:${usuarioId}`;
}

export async function registrarAuditoria(
  db: Ejecutor,
  tenantId: string,
  accion: AccionAuditoria,
  actor: string,
  detalle: Record<string, unknown> = {},
): Promise<void> {
  await conTenant(db, tenantId, (tx) => tx.insert(waAuditoria).values({ tenantId, accion, actor, detalle }));
}

/** Rastro de un negocio, MÁS RECIENTE PRIMERO. */
export async function listarAuditoriaTenant(db: Ejecutor, tenantId: string, limite = 100): Promise<EntradaAuditoria[]> {
  const filas = await conTenant(db, tenantId, (tx) => tx
    .select()
    .from(waAuditoria)
    .where(eq(waAuditoria.tenantId, tenantId))
    .orderBy(desc(waAuditoria.creadoEn))
    .limit(limite));
  return filas.map((f) => ({
    id: f.id,
    tenantId: f.tenantId,
    accion: f.accion as AccionAuditoria,
    actor: f.actor,
    detalle: f.detalle,
    creadoEn: f.creadoEn.toISOString(),
  }));
}

/**
 * Última pausa vigente de cada negocio pedido (para mostrar "pausado desde X, motivo Y"
 * en la lista del admin sin una columna extra en wa_tenants). Una sola consulta para
 * todos: trae las entradas "pausar" de esos tenants, más reciente primero, y se queda
 * con la primera de cada uno.
 */
export async function ultimaPausaPorTenant(
  db: Ejecutor,
  tenantIds: string[],
): Promise<Map<string, { desde: string; motivo: string | null }>> {
  const out = new Map<string, { desde: string; motivo: string | null }>();
  if (!tenantIds.length) return out;
  const filas = await conSistema(db, (tx) => tx
    .select()
    .from(waAuditoria)
    .where(and(inArray(waAuditoria.tenantId, tenantIds), eq(waAuditoria.accion, "pausar")))
    .orderBy(desc(waAuditoria.creadoEn)));
  for (const f of filas) {
    if (out.has(f.tenantId)) continue;
    const motivo = typeof f.detalle?.motivo === "string" ? f.detalle.motivo : null;
    out.set(f.tenantId, { desde: f.creadoEn.toISOString(), motivo });
  }
  return out;
}
