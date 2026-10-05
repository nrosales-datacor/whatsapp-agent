import { and, eq, inArray, or, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import {
  schema,
  waCampaniaEnvios,
  waCitas,
  waConversaciones,
  waCotizaciones,
  waEventosCalidad,
  waJobs,
  waMensajes,
  waSeguimientos,
  waWebhooksCrudos,
} from "../db/schema";
import { obtenerDb } from "../db/client";
import { conSistema, conTenant } from "../db/alcance";
import type { Tenant } from "../types";
import { eliminarEventoCita } from "../calendar/googleCalendar";
import { hoyEnTz } from "../booking/gestionCitas";
import { borrarObjetos, borrarPrefijo, esDataUrlLegado } from "../storage/supabaseStorage";
import { registrarAuditoria } from "./auditoria";
import { hayBaseDeDatos } from "./tenantStore";

type DB = PostgresJsDatabase<typeof schema>;

// ─────────────────────────────────────────────────────────────────────────────
// Derecho de supresión de un CLIENTE FINAL (Ley 8968 de Costa Rica, revisión
// pre-venta 2026-10). Hasta ahora solo existía la baja completa del negocio
// (`offboarding.ts`, F16): si un cliente del lavacar pedía "borren mis datos", había
// que hacerlo a mano tabla por tabla. Esto borra TODO lo que el sistema guarda de ese
// cliente dentro de UN negocio:
//
//   - wa_mensajes + wa_conversaciones (chat, notas privadas, upsells rechazados)
//   - wa_citas (+ wa_seguimientos de esas citas) y los eventos de Google Calendar de
//     sus citas FUTURAS (los pasados quedan en el calendario del negocio como registro
//     propio de su agenda; el detalle personal se borra de nuestra base igual)
//   - wa_cotizaciones, wa_eventos_calidad, wa_campania_envios
//   - wa_jobs con su mensaje (payload JSONB con el texto y el teléfono)
//   - wa_webhooks_crudos de ese teléfono al número de ESTE negocio
//   - las fotos en Supabase Storage (prefijo `{tenantId}/{conversacionId}`)
//
// No se tocan: `wa_uso_mensual` (contadores agregados, sin dato personal),
// `wa_push_subs` (dispositivos del EQUIPO del negocio, no del cliente) ni nada de otro
// negocio — todas las consultas filtran por `tenant.id`, que el caller saca SIEMPRE de
// la sesión (o del id que eligió el superadmin), nunca del body.
//
// Orden: primero lo EXTERNO (Calendar, Storage) y recién después la base, en una sola
// transacción. Si Google o Storage fallan se aborta SIN tocar la base: el pedido se
// puede reintentar entero (los borrados externos son idempotentes). Al revés, un fallo
// externo después de borrar la base dejaría fotos/eventos huérfanos sin forma de
// encontrarlos.
//
// Queda un registro en `wa_auditoria` ("borrar_cliente") con conteos e id interno de la
// conversación — NUNCA el teléfono, el nombre ni contenido (sería volver a guardar lo
// que se acaba de borrar).
// ─────────────────────────────────────────────────────────────────────────────

export interface ResultadoSupresion {
  /** Id interno de la conversación borrada (null si el cliente solo tenía citas manuales). */
  conversacionId: string | null;
  conteos: {
    mensajes: number;
    conversaciones: number;
    citas: number;
    seguimientos: number;
    cotizaciones: number;
    eventosCalidad: number;
    enviosCampania: number;
    jobs: number;
    webhooksCrudos: number;
  };
  archivosStorage: number;
  eventosCalendario: number;
}

/** Normaliza un teléfono a solo dígitos (WhatsApp guarda `from` así: "50688887777"). */
export function normalizarTelefono(v: unknown): string {
  return String(v ?? "").replace(/\D/g, "");
}

/**
 * Borra todos los datos de un cliente final dentro de `tenant`. Se identifica por
 * `conversacionId` (panel del dueño: la ficha del cliente) o por `clienteWa` (superadmin).
 *
 * Lanza:
 *   - `Error("SIN_DB")` sin base.
 *   - `Error("CLIENTE_NO_ENCONTRADO")` si no hay ningún dato de ese cliente EN ESTE
 *     negocio (incluye una conversación que existe pero es de otro tenant: mismo error,
 *     para no confirmar que existe).
 *   - `Error("CALENDARIO_FALLO")` / `Error("STORAGE_FALLO")` si falla la limpieza externa
 *     (no se borró nada de la base; se puede reintentar).
 *
 * `db` es opcional y SOLO para tests (PGlite).
 */
export async function borrarDatosCliente(opts: {
  tenant: Tenant;
  conversacionId?: string;
  clienteWa?: string;
  actor: string;
  db?: DB;
}): Promise<ResultadoSupresion> {
  const { tenant, actor } = opts;
  if (!opts.db && !hayBaseDeDatos()) throw new Error("SIN_DB");
  const d = opts.db ?? obtenerDb();

  // ── Resolver al cliente, SIEMPRE dentro del tenant ──
  let conv: typeof waConversaciones.$inferSelect | undefined;
  const conversacionId = opts.conversacionId;
  if (conversacionId) {
    [conv] = await conTenant(d, tenant.id, (tx) =>
      tx
        .select()
        .from(waConversaciones)
        .where(and(eq(waConversaciones.id, conversacionId), eq(waConversaciones.tenantId, tenant.id))),
    );
    if (!conv) throw new Error("CLIENTE_NO_ENCONTRADO");
  } else {
    const tel = normalizarTelefono(opts.clienteWa);
    if (!tel) throw new Error("CLIENTE_NO_ENCONTRADO");
    [conv] = await conTenant(d, tenant.id, (tx) => tx
      .select()
      .from(waConversaciones)
      .where(and(eq(waConversaciones.tenantId, tenant.id), eq(waConversaciones.clienteWa, tel))));
  }
  const clienteWa = conv?.clienteWa ?? normalizarTelefono(opts.clienteWa);

  const citas = await conTenant(d, tenant.id, (tx) => tx
    .select()
    .from(waCitas)
    .where(and(eq(waCitas.tenantId, tenant.id), eq(waCitas.clienteWa, clienteWa))));
  const cotizaciones = await conTenant(d, tenant.id, (tx) => tx
    .select({ id: waCotizaciones.id })
    .from(waCotizaciones)
    .where(and(eq(waCotizaciones.tenantId, tenant.id), eq(waCotizaciones.clienteWa, clienteWa))));
  if (!conv && citas.length === 0 && cotizaciones.length === 0) throw new Error("CLIENTE_NO_ENCONTRADO");

  // ── (1) Google Calendar: eventos de citas futuras ──
  const hoy = hoyEnTz(tenant.timezone);
  const eventosFuturos = citas.filter((c) => c.gcalEventId && c.fecha >= hoy).map((c) => c.gcalEventId as string);
  try {
    for (const eventId of eventosFuturos) await eliminarEventoCita(tenant, eventId);
  } catch (e) {
    console.error(`[supresion] no se pudieron borrar los eventos de Calendar (tenant ${tenant.id}):`, e);
    throw new Error("CALENDARIO_FALLO");
  }

  // ── (2) Storage: prefijo de la conversación + rutas puntuales guardadas en los mensajes ──
  let archivosStorage = 0;
  if (conv) {
    const conMedia = await conTenant(d, tenant.id, (tx) => tx
      .select({ mediaUrl: waMensajes.mediaUrl })
      .from(waMensajes)
      .where(eq(waMensajes.conversacionId, conv.id)));
    const prefijo = `${tenant.id}/${conv.id}`;
    // Rutas que NO cuelgan del prefijo (no debería haber, pero una ruta guardada es la
    // fuente de verdad de dónde quedó la foto): se borran una por una.
    const sueltas = conMedia
      .map((m) => m.mediaUrl)
      .filter((u): u is string => !!u && !esDataUrlLegado(u) && !u.startsWith(`${prefijo}/`) && u.startsWith(`${tenant.id}/`));
    try {
      archivosStorage = (await borrarPrefijo(prefijo)).borrados + (await borrarObjetos(sueltas));
    } catch (e) {
      console.error(`[supresion] no se pudieron borrar las fotos de Storage (tenant ${tenant.id}):`, e);
      throw new Error("STORAGE_FALLO");
    }
  }

  // ── (3) Base: todo en UNA transacción, más el registro auditable ──
  const idsCitas = citas.map((c) => c.id);
  const conteos = await conTenant(d, tenant.id, async (tx) => {
    const mensajes = conv
      ? (await tx.delete(waMensajes).where(eq(waMensajes.conversacionId, conv.id)).returning({ id: waMensajes.id })).length
      : 0;
    const seguimientos = idsCitas.length
      ? (
          await tx
            .delete(waSeguimientos)
            .where(and(eq(waSeguimientos.tenantId, tenant.id), inArray(waSeguimientos.citaId, idsCitas)))
            .returning({ id: waSeguimientos.id })
        ).length
      : 0;
    const citasBorradas = (
      await tx
        .delete(waCitas)
        .where(and(eq(waCitas.tenantId, tenant.id), eq(waCitas.clienteWa, clienteWa)))
        .returning({ id: waCitas.id })
    ).length;
    const cotizacionesBorradas = (
      await tx
        .delete(waCotizaciones)
        .where(and(eq(waCotizaciones.tenantId, tenant.id), eq(waCotizaciones.clienteWa, clienteWa)))
        .returning({ id: waCotizaciones.id })
    ).length;
    const eventosCalidad = (
      await tx
        .delete(waEventosCalidad)
        .where(and(eq(waEventosCalidad.tenantId, tenant.id), eq(waEventosCalidad.clienteWa, clienteWa)))
        .returning({ id: waEventosCalidad.id })
    ).length;
    const enviosCampania = (
      await tx
        .delete(waCampaniaEnvios)
        .where(and(eq(waCampaniaEnvios.tenantId, tenant.id), eq(waCampaniaEnvios.clienteWa, clienteWa)))
        .returning({ id: waCampaniaEnvios.id })
    ).length;
    // wa_jobs no tiene cliente_wa: el teléfono y el texto viajan en el payload JSONB
    // (PendienteSerializado). Se filtra por tenant_id + el cliente o la conversación.
    const filtroCliente = conv
      ? or(
          sql`${waJobs.payload} -> 'entrante' ->> 'clienteWa' = ${clienteWa}`,
          eq(waJobs.conversacionId, conv.id),
        )
      : sql`${waJobs.payload} -> 'entrante' ->> 'clienteWa' = ${clienteWa}`;
    const jobs = (
      await tx
        .delete(waJobs)
        .where(and(eq(waJobs.tenantId, tenant.id), filtroCliente))
        .returning({ id: waJobs.id })
    ).length;
    // wa_webhooks_crudos no tiene tenant_id ni cliente: se acota al número de ESTE negocio
    // y a payloads que contengan un mensaje de este teléfono (containment de JSONB, que
    // matchea dentro de los arreglos entry/changes/messages sin importar la posición).
    const patron = JSON.stringify({ entry: [{ changes: [{ value: { messages: [{ from: clienteWa }] } }] }] });
    // Es tabla de infraestructura (solo sistema, F1): se toca en contexto de sistema, con
    // el filtro explícito por el número de este negocio.
    const webhooksCrudos = (
      await conSistema(tx, (sis) =>
        sis
          .delete(waWebhooksCrudos)
          .where(
            and(
              eq(waWebhooksCrudos.phoneNumberId, tenant.phoneNumberId),
              sql`${waWebhooksCrudos.payload} @> ${patron}::jsonb`,
            ),
          )
          .returning({ id: waWebhooksCrudos.id }),
      )
    ).length;
    const conversaciones = conv
      ? (
          await tx
            .delete(waConversaciones)
            .where(and(eq(waConversaciones.id, conv.id), eq(waConversaciones.tenantId, tenant.id)))
            .returning({ id: waConversaciones.id })
        ).length
      : 0;

    const c = {
      mensajes,
      conversaciones,
      citas: citasBorradas,
      seguimientos,
      cotizaciones: cotizacionesBorradas,
      eventosCalidad,
      enviosCampania,
      jobs,
      webhooksCrudos,
    };
    await registrarAuditoria(tx, tenant.id, "borrar_cliente", actor, {
      conversacionId: conv?.id ?? null,
      conteos: c,
      archivosStorage,
      eventosCalendario: eventosFuturos.length,
    });
    return c;
  });

  console.log(`[supresion] tenant ${tenant.id}: datos de un cliente borrados (conv ${conv?.id ?? "—"})`);
  return { conversacionId: conv?.id ?? null, conteos, archivosStorage, eventosCalendario: eventosFuturos.length };
}

