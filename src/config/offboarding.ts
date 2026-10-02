import { eq, inArray } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import {
  schema,
  waTenants,
  waUsuarios,
  waConversaciones,
  waMensajes,
  waCitas,
  waEventosCalidad,
  waPushSubs,
  waTenantsHistorial,
  waJobs,
  waCampanias,
  waCampaniaEnvios,
  waUsoMensual,
  waCotizaciones,
  waSeguimientos,
  waSnapshotReputacion,
  waWebhooksCrudos,
} from "../db/schema";
import { obtenerDb } from "../db/client";
import { borrarPrefijo } from "../storage/supabaseStorage";
import { actorSuperadmin, registrarAuditoria } from "./auditoria";
import { hayBaseDeDatos } from "./tenantStore";

type DB = PostgresJsDatabase<typeof schema>;

// ─────────────────────────────────────────────────────────────────────────────
// Offboarding de tenant (ROADMAP F16). Ningún tenant_id es FK (salvo
// wa_usuarios.tenant_id → wa_tenants.id, con ON DELETE CASCADE), así que dar de
// baja un negocio a mano dejaba huérfanas sus conversaciones/citas/mensajes/etc.
// Este módulo borra TODO lo del tenant en una sola transacción, después de armar
// un export completo (para que el superadmin se lo lleve antes de que el negocio
// desaparezca — "borrá mis datos" + respaldo en el mismo paso).
//
// Tablas que NO están en el catálogo:
//   - wa_mensajes: no tiene tenant_id propio, cuelga de wa_conversaciones
//     (conversacion_id). Se exporta/borra por join/subquery sobre las
//     conversaciones del tenant, ANTES de borrar wa_conversaciones.
//   - wa_webhooks_crudos: tiene phone_number_id, no tenant_id. Antes quedaba
//     FUERA por miedo a que el número se hubiera reciclado a otro negocio. Desde
//     la revisión pre-venta 2026-10 SÍ se borra (y exporta) por el
//     phone_number_id ACTUAL del tenant: `wa_tenants_pnid_uq` garantiza que hoy
//     ese número es solo de este negocio, y lo que llegó a él antes de un cambio
//     de dueño ya se borró con la baja del dueño anterior. Son payloads crudos con
//     teléfonos y textos de clientes: dejarlos contradice "borrá mis datos".
//   - wa_auditoria: NO se borra. Es el rastro de plataforma de que la baja (y las
//     pausas/supresiones previas) ocurrieron; no guarda datos personales.
//
// Fuera de la base: las fotos de Supabase Storage (prefijo `{tenantId}/`) se
// borran DESPUÉS de confirmar la transacción (si la base fallara, el negocio
// seguiría vivo y sin fotos). Si Storage falla ahí, la baja igual queda hecha y
// se registra `baja_storage_pendiente` en wa_auditoria con el prefijo, para
// limpiarlo a mano.
// ─────────────────────────────────────────────────────────────────────────────

/** Catálogo de tablas con `tenant_id` propio, MENOS wa_conversaciones (se maneja
 * aparte: hay que leerla/borrarla antes que el resto para poder correlacionar
 * wa_mensajes por conversacion_id) y wa_tenants/wa_usuarios/wa_mensajes (reglas
 * particulares, ver comentario de arriba). */
const TABLAS_TENANT_ID = {
  waCitas,
  waEventosCalidad,
  waPushSubs,
  waTenantsHistorial,
  waJobs,
  waCampanias,
  waCampaniaEnvios,
  waUsoMensual,
  waCotizaciones,
  waSeguimientos,
  waSnapshotReputacion,
} as const;

/** Forma exacta del respaldo que se le entrega al superadmin antes de borrar (paso a). */
export interface ExportTenant {
  waTenants: typeof waTenants.$inferSelect;
  waUsuarios: (typeof waUsuarios.$inferSelect)[];
  waConversaciones: (typeof waConversaciones.$inferSelect)[];
  waMensajes: (typeof waMensajes.$inferSelect)[];
  waCitas: (typeof waCitas.$inferSelect)[];
  waEventosCalidad: (typeof waEventosCalidad.$inferSelect)[];
  waPushSubs: (typeof waPushSubs.$inferSelect)[];
  waTenantsHistorial: (typeof waTenantsHistorial.$inferSelect)[];
  waJobs: (typeof waJobs.$inferSelect)[];
  waCampanias: (typeof waCampanias.$inferSelect)[];
  waCampaniaEnvios: (typeof waCampaniaEnvios.$inferSelect)[];
  waUsoMensual: (typeof waUsoMensual.$inferSelect)[];
  waCotizaciones: (typeof waCotizaciones.$inferSelect)[];
  waSeguimientos: (typeof waSeguimientos.$inferSelect)[];
  waSnapshotReputacion: (typeof waSnapshotReputacion.$inferSelect)[];
  waWebhooksCrudos: (typeof waWebhooksCrudos.$inferSelect)[];
}

/**
 * Da de baja un tenant: arma su export completo (a) y borra TODAS sus filas (b),
 * en UNA sola transacción — o se hace todo, o no se hace nada.
 *
 * Confirmación explícita (mecanismo elegido): `confirmarNombre` debe ser el
 * `nombre` EXACTO del tenant tal como está guardado en `wa_tenants.nombre` (no
 * el id/slug — el nombre es lo que el superadmin ve en el panel, y un slug se
 * copia/pega sin pensar; un nombre hay que leerlo y escribirlo a propósito). Si
 * no coincide, se lanza `Error("CONFIRMACION_INVALIDA")` ANTES de leer o tocar
 * ninguna tabla hija (solo se leyó `wa_tenants` para comparar el nombre): ni
 * siquiera se genera el export con una confirmación incorrecta.
 *
 * `db` es opcional y SOLO para tests (inyectar la conexión efímera de PGlite):
 * en producción siempre se omite y se usa el pool singleton (`obtenerDb()`).
 * Lanza `Error("SIN_DB")` si no hay base, `Error("TENANT_NO_ENCONTRADO")` si el
 * id no existe.
 */
export async function darDeBajaTenant(tenantId: string, confirmarNombre: string, db?: DB): Promise<ExportTenant> {
  if (!db && !hayBaseDeDatos()) throw new Error("SIN_DB");
  const d = db ?? obtenerDb();

  const exportado = await d.transaction(async (tx) => {
    const [tenant] = await tx.select().from(waTenants).where(eq(waTenants.id, tenantId));
    if (!tenant) throw new Error("TENANT_NO_ENCONTRADO");
    if (tenant.nombre !== confirmarNombre) throw new Error("CONFIRMACION_INVALIDA");

    // ── (a) Export: se lee TODO antes de borrar nada ──
    const usuarios = await tx.select().from(waUsuarios).where(eq(waUsuarios.tenantId, tenantId));
    const conversaciones = await tx.select().from(waConversaciones).where(eq(waConversaciones.tenantId, tenantId));
    const idsConversaciones = conversaciones.map((c) => c.id);
    const mensajes = idsConversaciones.length
      ? await tx.select().from(waMensajes).where(inArray(waMensajes.conversacionId, idsConversaciones))
      : [];

    const crudos = await tx.select().from(waWebhooksCrudos).where(eq(waWebhooksCrudos.phoneNumberId, tenant.phoneNumberId));

    const exportado = {
      waTenants: tenant,
      waUsuarios: usuarios,
      waConversaciones: conversaciones,
      waMensajes: mensajes,
      waWebhooksCrudos: crudos,
    } as ExportTenant;

    for (const [clave, tabla] of Object.entries(TABLAS_TENANT_ID)) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- filas de forma distinta por tabla, ver ExportTenant
      (exportado as any)[clave] = await tx.select().from(tabla as any).where(eq((tabla as any).tenantId, tenantId));
    }

    // ── (b) Borrado en orden de dependencia ──
    // wa_mensajes primero (cuelga de wa_conversaciones vía conversacion_id, no tiene
    // tenant_id propio), después wa_conversaciones, después el resto del catálogo
    // (sin FKs entre sí, el orden no importa), y al final wa_usuarios → wa_tenants.
    if (idsConversaciones.length) {
      await tx.delete(waMensajes).where(inArray(waMensajes.conversacionId, idsConversaciones));
    }
    await tx.delete(waConversaciones).where(eq(waConversaciones.tenantId, tenantId));

    for (const tabla of Object.values(TABLAS_TENANT_ID)) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mismo catálogo heterogéneo de arriba
      await tx.delete(tabla as any).where(eq((tabla as any).tenantId, tenantId));
    }

    await tx.delete(waWebhooksCrudos).where(eq(waWebhooksCrudos.phoneNumberId, tenant.phoneNumberId));

    await tx.delete(waUsuarios).where(eq(waUsuarios.tenantId, tenantId));
    await tx.delete(waTenants).where(eq(waTenants.id, tenantId));

    // Rastro de la baja (sin datos personales: solo conteos), dentro de la MISMA transacción.
    await registrarAuditoria(tx, tenantId, "baja_tenant", actorSuperadmin(), {
      conversaciones: conversaciones.length,
      mensajes: mensajes.length,
      usuarios: usuarios.length,
    });

    return exportado;
  });

  // ── (c) Fotos en Supabase Storage, con la baja ya confirmada en la base ──
  try {
    await borrarPrefijo(tenantId);
  } catch (e) {
    console.error(`[offboarding] la baja de ${tenantId} quedó hecha pero NO se pudieron borrar sus fotos de Storage:`, e);
    try {
      await registrarAuditoria(d, tenantId, "baja_storage_pendiente", actorSuperadmin(), {
        prefijo: `${tenantId}/`,
        error: e instanceof Error ? e.message.slice(0, 200) : String(e).slice(0, 200),
      });
    } catch (e2) {
      console.error("[offboarding] tampoco se pudo registrar el pendiente de Storage:", e2);
    }
  }

  return exportado;
}
