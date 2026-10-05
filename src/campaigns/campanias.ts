import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { waCampanias, waCampaniaEnvios, waCitas, waConversaciones, waMensajes } from "../db/schema";
import type {
  Campania,
  CampaniaConDetalle,
  CampaniaEnvio,
  EstadoCampania,
  EstadoEnvioCampania,
  MetricasCampania,
  SegmentoFiltro,
  SegmentoTipo,
} from "../types";
import { obtenerDb } from "./db";
import { conTenant, type Tx } from "../db/alcance";
import { segmentoEnTransaccion } from "./segmentos";

// ─────────────────────────────────────────────────────────────────────────────
// CRUD de campañas (ROADMAP C3.2), DB-directo — mismo precedente que "Usuarios"
// (C2.3, src/config/tenantStore.ts): vive fuera de la interfaz Repositorio
// porque es una feature que necesita Postgres real (no tiene sentido en modo
// demo/memoria) y de baja frecuencia (la abre el dueño desde una pestaña).
// ─────────────────────────────────────────────────────────────────────────────

function filaACampania(f: typeof waCampanias.$inferSelect): Campania {
  return {
    id: f.id,
    tenantId: f.tenantId,
    nombre: f.nombre,
    mensaje: f.mensaje,
    segmentoTipo: f.segmentoTipo as SegmentoTipo,
    segmentoParametros: f.segmentoParametros,
    estado: f.estado as EstadoCampania,
    programadaPara: f.programadaPara ? f.programadaPara.toISOString() : null,
    creadaEn: f.creadaEn.toISOString(),
    iniciadaEn: f.iniciadaEn ? f.iniciadaEn.toISOString() : null,
    completadaEn: f.completadaEn ? f.completadaEn.toISOString() : null,
    totalDestinatarios: f.totalDestinatarios,
  };
}

function filaAEnvio(f: typeof waCampaniaEnvios.$inferSelect): CampaniaEnvio {
  return {
    id: f.id,
    campaniaId: f.campaniaId,
    clienteWa: f.clienteWa,
    clienteNombre: f.clienteNombre,
    estado: f.estado as EstadoEnvioCampania,
    intentos: f.intentos,
    error: f.error,
    enviadoEn: f.enviadoEn ? f.enviadoEn.toISOString() : null,
  };
}

export async function crearCampania(
  tenantId: string,
  datos: { nombre: string; mensaje: string; segmentoTipo: SegmentoTipo; segmentoParametros: SegmentoFiltro },
): Promise<Campania> {
  return conTenant(obtenerDb(), tenantId, async (d) => {
    const [fila] = await d
      .insert(waCampanias)
      .values({
        tenantId,
        nombre: datos.nombre,
        mensaje: datos.mensaje,
        segmentoTipo: datos.segmentoTipo,
        segmentoParametros: datos.segmentoParametros,
      })
      .returning();
    return filaACampania(fila);
  });
}

export async function listarCampanias(tenantId: string): Promise<Campania[]> {
  return conTenant(obtenerDb(), tenantId, async (d) => {
    const filas = await d
      .select()
      .from(waCampanias)
      .where(eq(waCampanias.tenantId, tenantId))
      .orderBy(desc(waCampanias.creadaEn));
    return filas.map(filaACampania);
  });
}

/**
 * Métricas de una campaña sobre datos posteriores al envío: "respuestas" = clientes
 * distintos que escribieron algo después de recibir el mensaje; "citasGeneradas" =
 * citas nuevas de esos clientes creadas después de su envío. No depende de webhooks
 * de estado de Meta (hoy no se parsean) — es un proxy suficiente para el MVP.
 */
async function calcularMetricas(d: Tx, tenantId: string, envios: CampaniaEnvio[]): Promise<MetricasCampania> {
  const destinatarios = envios.length;
  const fallidos = envios.filter((e) => e.estado === "error").length;
  const omitidosOptOut = envios.filter((e) => e.estado === "omitido_opt_out").length;
  const enviados = envios.filter((e) => e.estado === "enviado" && e.enviadoEn);

  if (enviados.length === 0) {
    return { destinatarios, enviados: 0, fallidos, omitidosOptOut, respuestas: 0, citasGeneradas: 0 };
  }

  const clientesWa = new Set(enviados.map((e) => e.clienteWa));
  const enviadoEnPorCliente = new Map(enviados.map((e) => [e.clienteWa, e.enviadoEn as string]));

  const conversaciones = await d
    .select({ id: waConversaciones.id, clienteWa: waConversaciones.clienteWa })
    .from(waConversaciones)
    .where(and(eq(waConversaciones.tenantId, tenantId), inArray(waConversaciones.clienteWa, [...clientesWa])));
  const clientePorConv = new Map(conversaciones.map((c) => [c.id, c.clienteWa]));
  const conversacionIds = conversaciones.map((c) => c.id);

  const respondieron = new Set<string>();
  if (conversacionIds.length > 0) {
    const mensajesEntrantes = await d
      .select({ conversacionId: waMensajes.conversacionId, creadoEn: waMensajes.creadoEn })
      .from(waMensajes)
      .where(and(inArray(waMensajes.conversacionId, conversacionIds), eq(waMensajes.rol, "user")));
    for (const m of mensajesEntrantes) {
      const wa = clientePorConv.get(m.conversacionId);
      if (!wa) continue;
      const enviadoEn = enviadoEnPorCliente.get(wa);
      if (enviadoEn && m.creadoEn.toISOString() > enviadoEn) respondieron.add(wa);
    }
  }

  const citas = await d
    .select({ clienteWa: waCitas.clienteWa, creadaEn: waCitas.creadaEn })
    .from(waCitas)
    .where(and(eq(waCitas.tenantId, tenantId), inArray(waCitas.clienteWa, [...clientesWa])));
  let citasGeneradas = 0;
  for (const c of citas) {
    const enviadoEn = enviadoEnPorCliente.get(c.clienteWa);
    if (enviadoEn && c.creadaEn.toISOString() > enviadoEn) citasGeneradas++;
  }

  return {
    destinatarios,
    enviados: enviados.length,
    fallidos,
    omitidosOptOut,
    respuestas: respondieron.size,
    citasGeneradas,
  };
}

export async function obtenerCampania(tenantId: string, id: string): Promise<CampaniaConDetalle | null> {
  return conTenant(obtenerDb(), tenantId, async (d) => {
    const [fila] = await d
      .select()
      .from(waCampanias)
      .where(and(eq(waCampanias.id, id), eq(waCampanias.tenantId, tenantId)))
      .limit(1);
    if (!fila) return null;

    const enviosFilas = await d
      .select()
      .from(waCampaniaEnvios)
      .where(eq(waCampaniaEnvios.campaniaId, id))
      .orderBy(waCampaniaEnvios.creadoEn);
    const envios = enviosFilas.map(filaAEnvio);
    const metricas = await calcularMetricas(d, tenantId, envios);

    return { ...filaACampania(fila), metricas, envios };
  });
}

/**
 * Materializa el segmento (snapshot en wa_campania_envios) y pasa la campaña a
 * "programada" (si `programadaPara` es futuro) o "enviando" (inmediato). Lanza
 * Error con código en el mensaje para que el router lo mapee a un 4xx:
 * "NO_ENCONTRADA" | "YA_ENVIADA" | "SIN_DESTINATARIOS".
 */
export async function confirmarEnvioCampania(
  tenantId: string,
  id: string,
  programadaPara: string | null,
): Promise<Campania> {
  return conTenant(obtenerDb(), tenantId, async (d) => {
    const [fila] = await d
      .select()
      .from(waCampanias)
      .where(and(eq(waCampanias.id, id), eq(waCampanias.tenantId, tenantId)))
      .limit(1);
    if (!fila) throw new Error("NO_ENCONTRADA");
    if (fila.estado !== "borrador") throw new Error("YA_ENVIADA");

    const { destinatarios } = await segmentoEnTransaccion(d, tenantId, fila.segmentoParametros);
    if (destinatarios.length === 0) throw new Error("SIN_DESTINATARIOS");

    const esFuturo = !!programadaPara && new Date(programadaPara).getTime() > Date.now();
    const ahora = new Date();

    // Misma transacción: la materialización del segmento y el cambio de estado van juntos.
    await d.insert(waCampaniaEnvios).values(
      destinatarios.map((c) => ({
        campaniaId: id,
        tenantId,
        clienteWa: c.clienteWa,
        clienteNombre: c.nombre,
      })),
    );
    await d
      .update(waCampanias)
      .set({
        estado: esFuturo ? "programada" : "enviando",
        programadaPara: esFuturo ? new Date(programadaPara!) : null,
        totalDestinatarios: destinatarios.length,
        iniciadaEn: esFuturo ? null : ahora,
      })
      .where(eq(waCampanias.id, id));

    const [actualizada] = await d.select().from(waCampanias).where(eq(waCampanias.id, id)).limit(1);
    return filaACampania(actualizada);
  });
}

/** Cancela una campaña que no haya terminado. Los envíos aún "pendiente" quedan en "error". */
export async function cancelarCampania(tenantId: string, id: string): Promise<Campania | null> {
  return conTenant(obtenerDb(), tenantId, async (d) => {
    const [fila] = await d
      .update(waCampanias)
      .set({ estado: "cancelada" })
      .where(
        and(
          eq(waCampanias.id, id),
          eq(waCampanias.tenantId, tenantId),
          sql`${waCampanias.estado} IN ('borrador', 'programada', 'enviando')`,
        ),
      )
      .returning();
    if (!fila) return null;

    await d
      .update(waCampaniaEnvios)
      .set({ estado: "error", error: "cancelado por el dueño" })
      .where(and(eq(waCampaniaEnvios.campaniaId, id), eq(waCampaniaEnvios.estado, "pendiente")));

    return filaACampania(fila);
  });
}
