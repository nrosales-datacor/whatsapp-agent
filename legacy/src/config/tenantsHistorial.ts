import { desc, eq, inArray } from "drizzle-orm";
import { waTenantsHistorial } from "../db/schema";
import { conTenant, type Ejecutor } from "../db/alcance";

// ─────────────────────────────────────────────────────────────────────────────
// Acceso a datos de `wa_tenants_historial` (ROADMAP F15). Igual que
// `db/webhooksCrudos.ts`: SOLO acceso a datos, sin conocer `Repositorio` ni el
// router. La escritura (insertar versión + podar por retención) SIEMPRE corre
// dentro de la transacción que hace `actualizarConfigTenant`
// (src/config/tenantStore.ts) junto con el `UPDATE` de wa_tenants — por eso
// `registrarVersionConfig` recibe el `db`/`tx` como parámetro en vez de abrir
// su propia conexión, a diferencia de `guardarCrudo` (que sí es una red de
// seguridad aparte, fire-and-forget).
// ─────────────────────────────────────────────────────────────────────────────


/**
 * Cuántas versiones se retienen por tenant. Podamos EN CADA ESCRITURA (dentro de la
 * misma transacción que el insert) en vez de un job de purga aparte como el de F11:
 * el volumen de escrituras de config es bajísimo (self-service, el dueño no toca "Mi
 * negocio" todos los días), así que un job separado sería sobre-ingeniería acá.
 */
export const RETENCION_VERSIONES_CONFIG = 30;

export interface VersionConfigTenant {
  id: string;
  tenantId: string;
  /** El patch completo tal como quedó tras el cambio (ver ConfigTenantPatch en tenantStore.ts). */
  snapshot: unknown;
  usuarioId: string;
  creadoEn: string; // ISO
}

/**
 * Inserta una versión nueva del historial y poda las que excedan
 * `RETENCION_VERSIONES_CONFIG` para ESE tenant. El caller debe pasar el `tx` de la
 * transacción que también hace el `UPDATE` a wa_tenants (ver actualizarConfigTenant) —
 * así "config nueva" + "versión en el historial" quedan atómicos: o ambas o ninguna.
 */
export async function registrarVersionConfig(
  db: Ejecutor,
  tenantId: string,
  snapshot: unknown,
  usuarioId: string,
): Promise<void> {
  await conTenant(db, tenantId, (tx) => tx.insert(waTenantsHistorial).values({ tenantId, snapshot, usuarioId }));

  // Poda: conserva las RETENCION_VERSIONES_CONFIG más recientes de este tenant y borra
  // el resto. Dos pasos (select de los ids viejos + delete) en vez de un solo DELETE
  // con subquery de ORDER BY/LIMIT: mismo resultado, sin SQL crudo.
  const viejos = await conTenant(db, tenantId, (tx) => tx
    .select({ id: waTenantsHistorial.id })
    .from(waTenantsHistorial)
    .where(eq(waTenantsHistorial.tenantId, tenantId))
    .orderBy(desc(waTenantsHistorial.creadoEn))
    .offset(RETENCION_VERSIONES_CONFIG));
  if (viejos.length > 0) {
    await conTenant(db, tenantId, (tx) => tx.delete(waTenantsHistorial).where(inArray(waTenantsHistorial.id, viejos.map((v) => v.id))));
  }
}

/** Historial de un tenant, MÁS RECIENTE PRIMERO (para mostrar "última versión" arriba
 * cuando el panel tenga la pestaña de Historial). */
export async function listarHistorialTenant(
  db: Ejecutor,
  tenantId: string,
  limite = RETENCION_VERSIONES_CONFIG,
): Promise<VersionConfigTenant[]> {
  const rows = await conTenant(db, tenantId, (tx) => tx
    .select({
      id: waTenantsHistorial.id,
      tenantId: waTenantsHistorial.tenantId,
      snapshot: waTenantsHistorial.snapshot,
      usuarioId: waTenantsHistorial.usuarioId,
      creadoEn: waTenantsHistorial.creadoEn,
    })
    .from(waTenantsHistorial)
    .where(eq(waTenantsHistorial.tenantId, tenantId))
    .orderBy(desc(waTenantsHistorial.creadoEn))
    .limit(limite));
  return rows.map((r) => ({ ...r, creadoEn: r.creadoEn.toISOString() }));
}

/**
 * Una versión puntual por id, para restaurar. `tenantId` es OBLIGATORIO y filtra en el
 * WHERE (no se valida aparte): el caller siempre debe pasar el tenant de la sesión, así
 * un dueño nunca puede restaurar (ni siquiera leer) una versión de otro negocio aunque
 * adivine el id.
 */
export async function obtenerVersionHistorial(
  db: Ejecutor,
  tenantId: string,
  historialId: string,
): Promise<VersionConfigTenant | undefined> {
  const rows = await conTenant(db, tenantId, (tx) => tx
    .select({
      id: waTenantsHistorial.id,
      tenantId: waTenantsHistorial.tenantId,
      snapshot: waTenantsHistorial.snapshot,
      usuarioId: waTenantsHistorial.usuarioId,
      creadoEn: waTenantsHistorial.creadoEn,
    })
    .from(waTenantsHistorial)
    .where(eq(waTenantsHistorial.id, historialId))
    .limit(1));
  const fila = rows[0];
  if (!fila || fila.tenantId !== tenantId) return undefined;
  return { ...fila, creadoEn: fila.creadoEn.toISOString() };
}
