import { and, desc, eq, gte, inArray, isNull, lte, sql } from "drizzle-orm";
import type { PgUpdateSetSource } from "drizzle-orm/pg-core";
import {
  waCitas,
  waConversaciones,
  waCotizaciones,
  waEventosCalidad,
  waMensajes,
  waPushSubs,
  waJobs,
  waSeguimientos,
  waSnapshotReputacion,
} from "../db/schema";
import type {
  AddonCita,
  Cita,
  Conversacion,
  Cotizacion,
  EstadoConversacion,
  FichaCliente,
  MensajeConversacion,
  Metricas,
  ModoConversacion,
  EstadoConversacionLigero,
  OpcionesListado,
  PendienteSerializado,
  PushSub,
  Repositorio,
  ResumenConversacion,
  VerificarHorario,
  Seguimiento,
  Sentimiento,
  SnapshotReputacion,
  TipoRecordatorio,
} from "../types";
import { calcularMetricas, formatDelta } from "../panel/metricas";
import { calcularVentana } from "../whatsapp/ventana";
import { filasDe } from "../db/filas";
import { conSistema, conTenant, type DB, type Tx } from "../db/alcance";
import { resolverMediaParaPanel } from "../storage/supabaseStorage";
import { HorarioOcupadoError } from "./errores";

// ─────────────────────────────────────────────────────────────────────────────
// Repositorio sobre Postgres (Drizzle). Cada método corre en una transacción acotada
// al negocio (`conTenant`, F1): con el rol de la app, las políticas RLS garantizan que
// ninguna consulta toca filas de otro negocio aunque le falte un filtro. Los filtros
// por `tenant_id` se mantienen igual (defensa en profundidad y uso de índices).
//
// Regla: nada de llamadas de red (Storage, Calendar, Meta) dentro de una transacción —
// retienen una conexión del pool mientras esperan.
// ─────────────────────────────────────────────────────────────────────────────

/** Mapea una fila de wa_citas al DTO Cita (normaliza null→undefined y fechas→ISO). */
function filaACita(r: typeof waCitas.$inferSelect): Cita {
  return {
    id: r.id,
    tenantId: r.tenantId,
    clienteWa: r.clienteWa,
    clienteNombre: r.clienteNombre,
    servicioId: r.servicioId,
    empleadoId: r.empleadoId ?? undefined,
    fecha: r.fecha,
    hora: r.hora,
    placa: r.placa ?? undefined,
    estado: r.estado as Cita["estado"],
    origen: r.origen as Cita["origen"],
    creadaEn: r.creadaEn.toISOString(),
    precio: r.precio ?? undefined,
    gcalEventId: r.gcalEventId ?? undefined,
    recordatorioDiaAntesEn: r.recordatorioDiaAntesEn ? r.recordatorioDiaAntesEn.toISOString() : null,
    recordatorioMismoDiaEn: r.recordatorioMismoDiaEn ? r.recordatorioMismoDiaEn.toISOString() : null,
    confirmadaEn: r.confirmadaEn ? r.confirmadaEn.toISOString() : null,
    postServicioEn: r.postServicioEn ? r.postServicioEn.toISOString() : null,
    addons: r.addons,
  };
}

/** Mapea una fila de wa_cotizaciones al DTO Cotizacion (normaliza null→undefined y fechas→ISO). */
function filaACotizacion(r: typeof waCotizaciones.$inferSelect): Cotizacion {
  return {
    id: r.id,
    tenantId: r.tenantId,
    clienteWa: r.clienteWa,
    servicioId: r.servicioId,
    monto: r.monto,
    estado: r.estado as Cotizacion["estado"],
    citaId: r.citaId ?? undefined,
    montoRecuperado: r.montoRecuperado ?? undefined,
    creadaEn: r.creadaEn.toISOString(),
    toque1En: r.toque1En ? r.toque1En.toISOString() : null,
    toque2En: r.toque2En ? r.toque2En.toISOString() : null,
  };
}

/** Mapea una fila de wa_seguimientos al DTO Seguimiento (normaliza null y fechas→ISO). */
function filaASeguimiento(r: typeof waSeguimientos.$inferSelect): Seguimiento {
  return {
    id: r.id,
    citaId: r.citaId,
    tenantId: r.tenantId,
    enviadoEn: r.enviadoEn.toISOString(),
    sentimiento: (r.sentimiento as Sentimiento | null) ?? null,
    resenaSolicitada: r.resenaSolicitada,
    respuestaTexto: r.respuestaTexto ?? undefined,
  };
}

/** Mapea una fila de wa_mensajes al DTO (sin resolver la media: eso es del panel). */
function filaAMensaje(m: typeof waMensajes.$inferSelect): MensajeConversacion {
  return {
    rol: m.rol as "user" | "assistant",
    contenido: m.contenido,
    creadoEn: m.creadoEn.toISOString(),
    porHumano: m.porHumano,
    waMessageId: m.waMessageId ?? undefined,
    mediaUrl: m.mediaUrl ?? undefined,
    mediaTipo: (m.mediaTipo as "imagen" | undefined) ?? undefined,
  };
}

const DIAS_NO_INSISTIR_ADDON = 60;

/** "YYYY-MM-DD" de hace `dias` días respecto de `hoy` (aritmética UTC al mediodía: sin sorpresas de DST). */
function fechaHaceDias(dias: number, hoy: string): string {
  const d = new Date(`${hoy}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - dias);
  return d.toISOString().slice(0, 10);
}

/**
 * Doble reserva: serializa TODA escritura de citas de un mismo tenant+fecha con un
 * advisory lock de TRANSACCIÓN (pooler-safe: se suelta solo al commit/rollback). Así el
 * re-chequeo de `verificar` y el INSERT/UPDATE son atómicos respecto de cualquier otra
 * cita de ese día — cosa que el índice único no puede dar: excluye `empleado_id IS NULL`
 * y solo ve la hora EXACTA, no solapes por duración. El lock es por día, no global.
 */
async function bloquearAgendaDelDia(tx: Tx, tenantId: string, fecha: string): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`wa_citas:${tenantId}:${fecha}`}, 0))`);
}

/** Columna y valor para cada tipo de recordatorio de una cita. */
function columnaRecordatorio(tipo: TipoRecordatorio) {
  if (tipo === "dia_antes") return { col: waCitas.recordatorioDiaAntesEn, clave: "recordatorioDiaAntesEn" as const };
  if (tipo === "mismo_dia") return { col: waCitas.recordatorioMismoDiaEn, clave: "recordatorioMismoDiaEn" as const };
  return { col: waCitas.postServicioEn, clave: "postServicioEn" as const };
}

export class RepositorioDrizzle implements Repositorio {
  constructor(private db: DB) {}

  async obtenerOConversacion(tenantId: string, clienteWa: string): Promise<Conversacion> {
    return conTenant(this.db, tenantId, async (tx) => {
      // Race-safe: inserta si no existe, luego lee.
      await tx.insert(waConversaciones).values({ tenantId, clienteWa }).onConflictDoNothing();
      const [conv] = await tx
        .select()
        .from(waConversaciones)
        .where(and(eq(waConversaciones.tenantId, tenantId), eq(waConversaciones.clienteWa, clienteWa)))
        .limit(1);

      // Los 20 MÁS RECIENTES, devueltos en orden cronológico. Sin firmar media: esta
      // lectura corre en el hot path del webhook y el agente no lee `mediaUrl` de acá.
      const msgs = (
        await tx
          .select()
          .from(waMensajes)
          .where(and(eq(waMensajes.tenantId, tenantId), eq(waMensajes.conversacionId, conv.id)))
          .orderBy(desc(waMensajes.creadoEn))
          .limit(20)
      ).reverse();
      const mensajes = msgs.map(filaAMensaje);

      return {
        id: conv.id,
        tenantId: conv.tenantId,
        clienteWa: conv.clienteWa,
        optInEn: conv.optInEn ? conv.optInEn.toISOString() : null,
        optOutEn: conv.optOutEn ? conv.optOutEn.toISOString() : null,
        modo: conv.modo as ModoConversacion,
        humanoDesde: conv.modo === "humano" && conv.humanoEn ? conv.humanoEn.toISOString() : null,
        estado: conv.estado as EstadoConversacion,
        mensajes,
        ...calcularVentana(mensajes),
      };
    });
  }

  async guardarMensaje(tenantId: string, conversacionId: string, msg: MensajeConversacion): Promise<boolean> {
    return conTenant(this.db, tenantId, async (tx) => {
      // La conversación tiene que ser de este negocio: un conversacionId ajeno nunca
      // cuelga un mensaje acá (defensa en profundidad además de la política RLS).
      const [conv] = await tx
        .select({ id: waConversaciones.id })
        .from(waConversaciones)
        .where(and(eq(waConversaciones.id, conversacionId), eq(waConversaciones.tenantId, tenantId)))
        .limit(1);
      if (!conv) return false;

      // onConflictDoNothing sobre el índice único de wa_message_id: si Meta reintrega el
      // mismo mensaje, no se inserta de nuevo y devolvemos false (idempotencia). Los
      // salientes no traen waMessageId (NULL) → nunca chocan → siempre se insertan.
      const filas = await tx
        .insert(waMensajes)
        .values({
          tenantId,
          conversacionId,
          rol: msg.rol,
          contenido: msg.contenido,
          porHumano: msg.porHumano ?? false,
          waMessageId: msg.waMessageId ?? null,
          mediaUrl: msg.mediaUrl ?? null,
          mediaTipo: msg.mediaTipo ?? null,
        })
        .onConflictDoNothing()
        .returning({ id: waMensajes.id });
      return filas.length > 0;
    });
  }

  async actualizarMediaMensaje(
    tenantId: string,
    conversacionId: string,
    waMessageId: string,
    mediaUrl: string,
    mediaTipo: "imagen",
  ): Promise<void> {
    await conTenant(this.db, tenantId, (tx) =>
      tx
        .update(waMensajes)
        .set({ mediaUrl, mediaTipo })
        .where(
          and(
            eq(waMensajes.tenantId, tenantId),
            eq(waMensajes.conversacionId, conversacionId),
            eq(waMensajes.waMessageId, waMessageId),
          ),
        ),
    );
  }

  async marcarOptIn(tenantId: string, conversacionId: string): Promise<void> {
    await this.actualizarConversacion(tenantId, conversacionId, { optInEn: new Date() });
  }

  async marcarOptOut(tenantId: string, conversacionId: string): Promise<void> {
    await this.actualizarConversacion(tenantId, conversacionId, { optOutEn: new Date() });
  }

  async citasPorFecha(tenantId: string, fecha: string): Promise<Cita[]> {
    const rows = await conTenant(this.db, tenantId, (tx) =>
      tx
        .select()
        .from(waCitas)
        .where(and(eq(waCitas.tenantId, tenantId), eq(waCitas.fecha, fecha))),
    );
    return rows.map(filaACita);
  }

  async citasEnRango(tenantId: string, desde: string, hasta: string): Promise<Cita[]> {
    const rows = await conTenant(this.db, tenantId, (tx) =>
      tx
        .select()
        .from(waCitas)
        .where(and(eq(waCitas.tenantId, tenantId), gte(waCitas.fecha, desde), lte(waCitas.fecha, hasta)))
        .orderBy(waCitas.fecha, waCitas.hora),
    );
    return rows.map(filaACita);
  }

  async crearCita(cita: Omit<Cita, "id" | "creadaEn" | "estado">, verificar?: VerificarHorario): Promise<Cita> {
    return conTenant(this.db, cita.tenantId, async (tx) => {
      await bloquearAgendaDelDia(tx, cita.tenantId, cita.fecha);
      if (verificar) {
        const delDia = await tx
          .select()
          .from(waCitas)
          .where(and(eq(waCitas.tenantId, cita.tenantId), eq(waCitas.fecha, cita.fecha)));
        if (!verificar(delDia.map(filaACita))) throw new HorarioOcupadoError();
      }
      const [r] = await tx
        .insert(waCitas)
        .values({
          tenantId: cita.tenantId,
          clienteWa: cita.clienteWa,
          clienteNombre: cita.clienteNombre,
          servicioId: cita.servicioId,
          empleadoId: cita.empleadoId,
          fecha: cita.fecha,
          hora: cita.hora,
          placa: cita.placa,
          precio: cita.precio,
          origen: cita.origen ?? "bot",
        })
        .returning();
      return filaACita(r);
    });
  }

  async guardarGcalEventId(tenantId: string, citaId: string, eventId: string): Promise<void> {
    await this.actualizarCita(tenantId, citaId, { gcalEventId: eventId });
  }

  async citasActivasCliente(tenantId: string, clienteWa: string, desdeFecha: string): Promise<Cita[]> {
    const rows = await conTenant(this.db, tenantId, (tx) =>
      tx
        .select()
        .from(waCitas)
        .where(
          and(
            eq(waCitas.tenantId, tenantId),
            eq(waCitas.clienteWa, clienteWa),
            eq(waCitas.estado, "agendada"),
            gte(waCitas.fecha, desdeFecha),
          ),
        )
        .orderBy(waCitas.fecha, waCitas.hora),
    );
    return rows.map(filaACita);
  }

  async reprogramarCita(
    tenantId: string,
    citaId: string,
    fecha: string,
    hora: string,
    verificar?: VerificarHorario,
  ): Promise<Cita | null> {
    return conTenant(this.db, tenantId, async (tx) => {
      // Se bloquea la fecha DESTINO: es la única donde se consume capacidad.
      await bloquearAgendaDelDia(tx, tenantId, fecha);
      if (verificar) {
        const delDia = await tx
          .select()
          .from(waCitas)
          .where(and(eq(waCitas.tenantId, tenantId), eq(waCitas.fecha, fecha)));
        if (!verificar(delDia.filter((c) => c.id !== citaId).map(filaACita))) throw new HorarioOcupadoError();
      }
      // Reinicia los recordatorios: deben salir según el nuevo horario, no el viejo.
      const [r] = await tx
        .update(waCitas)
        .set({ fecha, hora, recordatorioDiaAntesEn: null, recordatorioMismoDiaEn: null })
        .where(and(eq(waCitas.id, citaId), eq(waCitas.tenantId, tenantId)))
        .returning();
      return r ? filaACita(r) : null;
    });
  }

  async obtenerCitaPorId(tenantId: string, citaId: string): Promise<Cita | null> {
    const [r] = await conTenant(this.db, tenantId, (tx) =>
      tx
        .select()
        .from(waCitas)
        .where(and(eq(waCitas.id, citaId), eq(waCitas.tenantId, tenantId)))
        .limit(1),
    );
    return r ? filaACita(r) : null;
  }

  async reasignarCita(tenantId: string, citaId: string, empleadoId: string | null): Promise<Cita | null> {
    return this.actualizarCita(tenantId, citaId, { empleadoId });
  }

  async cancelarCita(tenantId: string, citaId: string): Promise<Cita | null> {
    return this.actualizarCita(tenantId, citaId, { estado: "cancelada" });
  }

  async confirmarCita(tenantId: string, citaId: string): Promise<Cita | null> {
    // COALESCE conserva la primera confirmación si el cliente toca el botón dos veces.
    // Solo confirma citas "agendada" (no una cancelada/completada).
    return this.actualizarCita(tenantId, citaId, { confirmadaEn: sql`COALESCE(${waCitas.confirmadaEn}, now())` }, true);
  }

  async completarCita(tenantId: string, citaId: string): Promise<Cita | null> {
    return this.actualizarCita(tenantId, citaId, { estado: "completada" }, true);
  }

  async marcarNoShow(tenantId: string, citaId: string): Promise<Cita | null> {
    return this.actualizarCita(tenantId, citaId, { estado: "no_show" }, true);
  }

  async registrarCotizacion(tenantId: string, clienteWa: string, servicioId: string, monto: number): Promise<Cotizacion | null> {
    return conTenant(this.db, tenantId, async (tx) => {
      const [activa] = await tx
        .select({ id: waCotizaciones.id })
        .from(waCotizaciones)
        .where(
          and(
            eq(waCotizaciones.tenantId, tenantId),
            eq(waCotizaciones.clienteWa, clienteWa),
            inArray(waCotizaciones.estado, ["pendiente", "toque1", "toque2"]),
          ),
        )
        .limit(1);
      if (activa) return null; // no dos rescates activos al mismo teléfono

      const [r] = await tx.insert(waCotizaciones).values({ tenantId, clienteWa, servicioId, monto }).returning();
      return filaACotizacion(r);
    });
  }

  async actualizarCotizacionPorCita(
    tenantId: string,
    clienteWa: string,
    servicioId: string,
    citaId: string,
    montoCita?: number,
  ): Promise<void> {
    await conTenant(this.db, tenantId, async (tx) => {
      const [activa] = await tx
        .select()
        .from(waCotizaciones)
        .where(
          and(
            eq(waCotizaciones.tenantId, tenantId),
            eq(waCotizaciones.clienteWa, clienteWa),
            eq(waCotizaciones.servicioId, servicioId),
            inArray(waCotizaciones.estado, ["pendiente", "toque1", "toque2"]),
          ),
        )
        .limit(1);
      if (!activa) return;

      const yaTuvoToque = activa.estado === "toque1" || activa.estado === "toque2";
      await tx
        .update(waCotizaciones)
        .set({
          estado: yaTuvoToque ? "recuperada" : "agendada",
          citaId,
          montoRecuperado: yaTuvoToque ? (montoCita ?? activa.monto) : null,
        })
        .where(and(eq(waCotizaciones.id, activa.id), eq(waCotizaciones.tenantId, tenantId)));
    });
  }

  async agregarAddonACita(tenantId: string, citaId: string, addon: AddonCita): Promise<Cita | null> {
    return conTenant(this.db, tenantId, async (tx) => {
      // FOR UPDATE: dos aceptaciones simultáneas no pisan el arreglo de add-ons.
      const [fila] = await tx
        .select()
        .from(waCitas)
        .where(and(eq(waCitas.id, citaId), eq(waCitas.tenantId, tenantId)))
        .limit(1)
        .for("update");
      if (!fila) return null;
      if (fila.addons.some((a) => a.servicioId === addon.servicioId)) return filaACita(fila); // idempotente

      const [actualizada] = await tx
        .update(waCitas)
        .set({ addons: [...fila.addons, addon] })
        .where(and(eq(waCitas.id, citaId), eq(waCitas.tenantId, tenantId)))
        .returning();
      return filaACita(actualizada);
    });
  }

  async registrarRechazoAddon(tenantId: string, clienteWa: string, addonId: string): Promise<void> {
    await conTenant(this.db, tenantId, async (tx) => {
      const [conv] = await tx
        .select({ id: waConversaciones.id, upsellsRechazados: waConversaciones.upsellsRechazados })
        .from(waConversaciones)
        .where(and(eq(waConversaciones.tenantId, tenantId), eq(waConversaciones.clienteWa, clienteWa)))
        .limit(1)
        .for("update");
      if (!conv) return;
      const rechazo = { addonId, fecha: new Date().toISOString().slice(0, 10) };
      await tx
        .update(waConversaciones)
        .set({ upsellsRechazados: [...conv.upsellsRechazados, rechazo] })
        .where(and(eq(waConversaciones.id, conv.id), eq(waConversaciones.tenantId, tenantId)));
    });
  }

  async fueRechazadoAddonRecientemente(tenantId: string, clienteWa: string, addonId: string, hoy: string): Promise<boolean> {
    const [conv] = await conTenant(this.db, tenantId, (tx) =>
      tx
        .select({ upsellsRechazados: waConversaciones.upsellsRechazados })
        .from(waConversaciones)
        .where(and(eq(waConversaciones.tenantId, tenantId), eq(waConversaciones.clienteWa, clienteWa)))
        .limit(1),
    );
    if (!conv) return false;
    const corte = fechaHaceDias(DIAS_NO_INSISTIR_ADDON, hoy);
    return conv.upsellsRechazados.some((r) => r.addonId === addonId && r.fecha >= corte);
  }

  async marcarRecordatorio(tenantId: string, citaId: string, tipo: TipoRecordatorio): Promise<void> {
    await this.actualizarCita(tenantId, citaId, { [columnaRecordatorio(tipo).clave]: new Date() });
  }

  async reclamarRecordatorio(tenantId: string, citaId: string, tipo: TipoRecordatorio): Promise<boolean> {
    // UPDATE ... WHERE col IS NULL RETURNING id — atómico: solo una instancia pasa de NULL
    // a timestamp; las demás obtienen 0 filas → claim perdido.
    const { col, clave } = columnaRecordatorio(tipo);
    const filas = await conTenant(this.db, tenantId, (tx) =>
      tx
        .update(waCitas)
        .set({ [clave]: new Date() })
        .where(and(eq(waCitas.id, citaId), eq(waCitas.tenantId, tenantId), isNull(col)))
        .returning({ id: waCitas.id }),
    );
    return filas.length > 0;
  }

  async revertirRecordatorio(tenantId: string, citaId: string, tipo: TipoRecordatorio): Promise<void> {
    await this.actualizarCita(tenantId, citaId, { [columnaRecordatorio(tipo).clave]: null });
  }

  // ── Motor de reseñas de Google (Carril D, 1.3) ──
  async crearSeguimiento(tenantId: string, citaId: string): Promise<void> {
    await conTenant(this.db, tenantId, (tx) => tx.insert(waSeguimientos).values({ tenantId, citaId }).onConflictDoNothing());
  }

  async registrarRespuestaSeguimiento(
    tenantId: string,
    citaId: string,
    sentimiento: Sentimiento,
    resenaSolicitada: boolean,
    respuestaTexto: string,
  ): Promise<void> {
    await conTenant(this.db, tenantId, (tx) =>
      tx
        .update(waSeguimientos)
        .set({ sentimiento, resenaSolicitada, respuestaTexto })
        .where(and(eq(waSeguimientos.citaId, citaId), eq(waSeguimientos.tenantId, tenantId))),
    );
  }

  async seguimientosDeTenant(tenantId: string): Promise<Seguimiento[]> {
    const rows = await conTenant(this.db, tenantId, (tx) =>
      tx.select().from(waSeguimientos).where(eq(waSeguimientos.tenantId, tenantId)),
    );
    return rows.map(filaASeguimiento);
  }

  async guardarSnapshotReputacion(tenantId: string, fecha: string, rating: number, totalResenas: number): Promise<void> {
    await conTenant(this.db, tenantId, (tx) =>
      tx
        .insert(waSnapshotReputacion)
        .values({ tenantId, fecha, rating, totalResenas })
        .onConflictDoUpdate({
          target: [waSnapshotReputacion.tenantId, waSnapshotReputacion.fecha],
          set: { rating, totalResenas },
        }),
    );
  }

  async historicoReputacion(tenantId: string, limite: number): Promise<SnapshotReputacion[]> {
    return conTenant(this.db, tenantId, (tx) => leerHistoricoReputacion(tx, tenantId, limite));
  }

  async guardarEntranteYEncolar(
    conversacionId: string,
    msg: MensajeConversacion,
    payload: PendienteSerializado,
    ejecutarDespuesDe?: Date,
  ): Promise<boolean> {
    // Una sola transacción: "mensaje persistido ⇒ job encolado" es invariante. Si el
    // proceso muere a mitad, Postgres revierte ambas filas → Meta reintenta.
    const tenantId = payload.tenantId;
    return conTenant(this.db, tenantId, async (tx) => {
      const filas = await tx
        .insert(waMensajes)
        .values({
          tenantId,
          conversacionId,
          rol: msg.rol,
          contenido: msg.contenido,
          porHumano: msg.porHumano ?? false,
          waMessageId: msg.waMessageId ?? null,
        })
        .onConflictDoNothing()
        .returning({ id: waMensajes.id });
      if (filas.length === 0) return false; // mensaje duplicado → no encolar
      await tx
        .insert(waJobs)
        .values({
          tenantId,
          conversacionId,
          payload,
          waMessageId: msg.waMessageId ?? null,
          // F10: rate limit de ingesta excedido → el worker no lo reclama hasta ese
          // momento. undefined deja el default de la columna (now()).
          ...(ejecutarDespuesDe ? { ejecutarDespuesDe } : {}),
        })
        .onConflictDoNothing(); // idempotencia extra por waMessageId
      // Un mensaje nuevo del cliente reabre la conversación aunque estuviera "atendida".
      await tx
        .update(waConversaciones)
        .set({ estado: "abierta" })
        .where(and(eq(waConversaciones.id, conversacionId), eq(waConversaciones.tenantId, tenantId)));
      return true;
    });
  }

  async registrarCalidad(evento: {
    tenantId: string;
    clienteWa: string;
    tipo: "mensaje_ok" | "fuera_de_alcance" | "error";
    detalle?: string;
  }): Promise<void> {
    await conTenant(this.db, evento.tenantId, (tx) => tx.insert(waEventosCalidad).values(evento));
  }

  // ── Panel / bandeja humana ──
  async setModoConversacion(tenantId: string, conversacionId: string, modo: ModoConversacion): Promise<void> {
    // Al pasar a humano se marca humano_en = now() (el ÚLTIMO traspaso: es el reloj de
    // `modoHumanoVencido`); si ya estaba en humano no se pisa. Al volver a bot NO se borra:
    // `humano_en IS NULL` sigue significando "nunca se escaló" para las métricas (C3.3).
    await this.actualizarConversacion(
      tenantId,
      conversacionId,
      modo === "humano"
        ? {
            modo,
            humanoEn: sql`CASE WHEN ${waConversaciones.modo} <> 'humano' THEN now() ELSE COALESCE(${waConversaciones.humanoEn}, now()) END`,
          }
        : { modo },
    );
  }

  async marcarEstadoConversacion(tenantId: string, conversacionId: string, estado: EstadoConversacion): Promise<void> {
    await this.actualizarConversacion(tenantId, conversacionId, { estado });
  }

  async listarConversaciones(tenantId: string, opciones: OpcionesListado = {}): Promise<ResumenConversacion[]> {
    // Una página de la bandeja: el orden y el corte salen del índice (tenant_id,
    // ultima_actividad_en), y los LATERAL (último mensaje, sin leer, citas) corren solo para
    // las filas de la página — no para todas las conversaciones del negocio. sin_leer se
    // calcula (no es un contador mutable) y SOLO en modo humano.
    const limite = Math.min(Math.max(Math.trunc(opciones.limite ?? 100), 1), 501);
    const hoy = opciones.hoy ?? new Date().toISOString().slice(0, 10);
    const condiciones = [sql`c.tenant_id = ${tenantId}`];
    if (opciones.antesDe) condiciones.push(sql`c.ultima_actividad_en < ${opciones.antesDe}`);
    const buscar = opciones.buscar?.trim();
    if (buscar) {
      // Los comodines de LIKE que escriba el operador se buscan literales.
      const patron = `%${buscar.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      condiciones.push(sql`(c.cliente_wa ILIKE ${patron} OR EXISTS (
        SELECT 1 FROM wa_citas b WHERE b.tenant_id = c.tenant_id AND b.cliente_wa = c.cliente_wa AND b.cliente_nombre ILIKE ${patron}
      ))`);
    }
    const filas = await conTenant(this.db, tenantId, async (tx) =>
      filasDe<{
        id: string;
        cliente_wa: string;
        modo: string;
        estado: string;
        sin_leer: number | string;
        ultimo_mensaje: string | null;
        ultimo_rol: string | null;
        ultima_actividad: Date | string;
        servicio_id: string | null;
        tiene_cita: boolean;
        cita_confirmada: boolean;
        tuvo_cita: boolean;
        cliente_nombre: string | null;
      }>(
        await tx.execute(sql`
        SELECT
          c.id,
          c.cliente_wa,
          c.modo,
          c.estado,
          c.creada_en,
          m.contenido AS ultimo_mensaje,
          m.rol AS ultimo_rol,
          c.ultima_actividad_en AS ultima_actividad,
          CASE WHEN c.modo = 'humano' THEN (
            SELECT count(*) FROM wa_mensajes um
            WHERE um.conversacion_id = c.id AND um.rol = 'user'
              AND (c.leido_hasta IS NULL OR um.creado_en > c.leido_hasta)
          ) ELSE 0 END AS sin_leer,
          cita_prox.servicio_id AS servicio_id,
          (cita_prox.servicio_id IS NOT NULL) AS tiene_cita,
          (cita_prox.confirmada_en IS NOT NULL) AS cita_confirmada,
          EXISTS(
            SELECT 1 FROM wa_citas ch
            WHERE ch.tenant_id = c.tenant_id AND ch.cliente_wa = c.cliente_wa
          ) AS tuvo_cita,
          ultima_cita.cliente_nombre AS cliente_nombre
        FROM wa_conversaciones c
        LEFT JOIN LATERAL (
          SELECT contenido, creado_en, rol
          FROM wa_mensajes
          WHERE conversacion_id = c.id
          ORDER BY creado_en DESC
          LIMIT 1
        ) m ON true
        LEFT JOIN LATERAL (
          SELECT servicio_id, confirmada_en
          FROM wa_citas
          WHERE tenant_id = c.tenant_id AND cliente_wa = c.cliente_wa
            AND estado = 'agendada' AND fecha >= ${hoy}
          ORDER BY fecha ASC, hora ASC
          LIMIT 1
        ) cita_prox ON true
        LEFT JOIN LATERAL (
          SELECT cliente_nombre
          FROM wa_citas
          WHERE tenant_id = c.tenant_id AND cliente_wa = c.cliente_wa
          ORDER BY creada_en DESC
          LIMIT 1
        ) ultima_cita ON true
        WHERE ${sql.join(condiciones, sql` AND `)}
        ORDER BY c.ultima_actividad_en DESC, c.id DESC
        LIMIT ${limite}
      `),
      ),
    );

    const hace24h = Date.now() - 24 * 60 * 60 * 1000;

    return filas.map((r) => {
      const ultimaActividad = new Date(r.ultima_actividad);
      // Heurística tentativa de lead score: base 40 + tuvo alguna vez cita (+25) + cliente
      // esperando respuesta (+15) + actividad <24h (+10) + cita activa futura (+10).
      let leadScore = 40;
      if (r.tuvo_cita) leadScore += 25;
      if (r.ultimo_rol === "user") leadScore += 15;
      if (ultimaActividad.getTime() >= hace24h) leadScore += 10;
      if (r.tiene_cita) leadScore += 10;
      leadScore = Math.min(100, Math.max(0, leadScore));

      return {
        id: r.id,
        clienteWa: r.cliente_wa,
        modo: r.modo as ModoConversacion,
        estado: r.estado as EstadoConversacion,
        ultimoMensaje: r.ultimo_mensaje ?? null,
        ultimaActividadEn: ultimaActividad.toISOString(),
        sinLeer: Number(r.sin_leer),
        leadScore,
        servicio: r.servicio_id ?? null,
        tieneCita: r.tiene_cita,
        citaConfirmada: r.cita_confirmada,
        nombre: r.cliente_nombre ?? null,
      };
    });
  }

  async mensajesRecientes(tenantId: string, conversacionId: string, limite: number): Promise<MensajeConversacion[]> {
    if (limite <= 0) return [];
    // Los N MÁS RECIENTES (desc + limit), invertidos a orden cronológico. Sin firmar media.
    const filas = await conTenant(this.db, tenantId, (tx) =>
      tx
        .select()
        .from(waMensajes)
        .where(and(eq(waMensajes.tenantId, tenantId), eq(waMensajes.conversacionId, conversacionId)))
        .orderBy(desc(waMensajes.creadoEn))
        .limit(limite),
    );
    return filas.reverse().map(filaAMensaje);
  }

  async obtenerConversacionPorId(tenantId: string, conversacionId: string, opciones: { hoy?: string } = {}): Promise<Conversacion | null> {
    const hoy = opciones.hoy ?? new Date().toISOString().slice(0, 10);
    const leido = await conTenant(this.db, tenantId, async (tx) => {
      const [convRows, msgsDesc] = await Promise.all([
        tx
          .select()
          .from(waConversaciones)
          .where(and(eq(waConversaciones.id, conversacionId), eq(waConversaciones.tenantId, tenantId)))
          .limit(1),
        // Los 100 MÁS RECIENTES (lo que el operador necesita ver), luego a orden cronológico.
        tx
          .select()
          .from(waMensajes)
          .where(and(eq(waMensajes.tenantId, tenantId), eq(waMensajes.conversacionId, conversacionId)))
          .orderBy(desc(waMensajes.creadoEn))
          .limit(100),
      ]);
      const conv = convRows[0];
      if (!conv) return null;

      // Cita activa más próxima del cliente (badge "Cita agendada" y subtítulo del servicio).
      const [citaActiva] = await tx
        .select({ servicioId: waCitas.servicioId, confirmadaEn: waCitas.confirmadaEn })
        .from(waCitas)
        .where(
          and(
            eq(waCitas.tenantId, tenantId),
            eq(waCitas.clienteWa, conv.clienteWa),
            eq(waCitas.estado, "agendada"),
            gte(waCitas.fecha, hoy),
          ),
        )
        .orderBy(waCitas.fecha, waCitas.hora)
        .limit(1);
      return { conv, msgsAsc: msgsDesc.reverse(), citaActiva };
    });
    if (!leido) return null;
    const { conv, msgsAsc, citaActiva } = leido;

    // Fuera de la transacción: firmar la media es una llamada de red (con caché).
    const mensajes: MensajeConversacion[] = await Promise.all(
      msgsAsc.map(async (m) => ({ ...filaAMensaje(m), mediaUrl: await resolverMediaParaPanel(m.mediaUrl) })),
    );

    return {
      id: conv.id,
      tenantId: conv.tenantId,
      clienteWa: conv.clienteWa,
      optInEn: conv.optInEn ? conv.optInEn.toISOString() : null,
      optOutEn: conv.optOutEn ? conv.optOutEn.toISOString() : null,
      modo: conv.modo as ModoConversacion,
      estado: conv.estado as EstadoConversacion,
      mensajes,
      ...calcularVentana(mensajes),
      servicio: citaActiva?.servicioId ?? null,
      tieneCita: !!citaActiva,
      citaConfirmada: !!citaActiva?.confirmadaEn,
    };
  }

  async obtenerEstadoConversacion(tenantId: string, conversacionId: string): Promise<EstadoConversacionLigero | null> {
    return conTenant(this.db, tenantId, async (tx) => {
      const [conv] = await tx
        .select({ id: waConversaciones.id, clienteWa: waConversaciones.clienteWa, modo: waConversaciones.modo })
        .from(waConversaciones)
        .where(and(eq(waConversaciones.id, conversacionId), eq(waConversaciones.tenantId, tenantId)))
        .limit(1);
      if (!conv) return null;
      // Último mensaje del CLIENTE (la ventana de 24 h de Meta cuenta desde ahí).
      const [ultimo] = await tx
        .select({ creadoEn: waMensajes.creadoEn })
        .from(waMensajes)
        .where(and(eq(waMensajes.tenantId, tenantId), eq(waMensajes.conversacionId, conversacionId), eq(waMensajes.rol, "user")))
        .orderBy(desc(waMensajes.creadoEn))
        .limit(1);
      const ventana = calcularVentana(ultimo ? [{ rol: "user", creadoEn: ultimo.creadoEn.toISOString() }] : []);
      return { id: conv.id, clienteWa: conv.clienteWa, modo: conv.modo as ModoConversacion, ...ventana };
    });
  }

  async obtenerModo(tenantId: string, conversacionId: string): Promise<ModoConversacion | null> {
    const [row] = await conTenant(this.db, tenantId, (tx) =>
      tx
        .select({ modo: waConversaciones.modo })
        .from(waConversaciones)
        .where(and(eq(waConversaciones.id, conversacionId), eq(waConversaciones.tenantId, tenantId)))
        .limit(1),
    );
    return row ? (row.modo as ModoConversacion) : null;
  }

  async marcarLeidas(tenantId: string, conversacionId: string): Promise<void> {
    await this.actualizarConversacion(tenantId, conversacionId, { leidoHasta: new Date() });
  }

  async fichaCliente(tenantId: string, clienteWa: string): Promise<FichaCliente | null> {
    const { conv, citas } = await conTenant(this.db, tenantId, async (tx) => {
      const [conv] = await tx
        .select()
        .from(waConversaciones)
        .where(and(eq(waConversaciones.tenantId, tenantId), eq(waConversaciones.clienteWa, clienteWa)))
        .limit(1);
      const citas = await tx
        .select()
        .from(waCitas)
        .where(and(eq(waCitas.tenantId, tenantId), eq(waCitas.clienteWa, clienteWa)))
        .orderBy(desc(waCitas.fecha));
      return { conv, citas };
    });

    if (!conv && citas.length === 0) return null;
    const placas = [...new Set(citas.map((c) => c.placa).filter((p): p is string => !!p))];
    return {
      clienteWa,
      nombre: citas.find((c) => c.clienteNombre)?.clienteNombre ?? null,
      placas,
      totalCitas: citas.length,
      ultimaVisita: citas[0]?.fecha ?? null,
      primerContacto: conv ? conv.creadaEn.toISOString() : null,
      notas: conv?.notas ?? "",
      historial: citas.map((c) => ({ servicioId: c.servicioId, fecha: c.fecha, hora: c.hora, estado: c.estado })),
    };
  }

  async guardarNotas(tenantId: string, conversacionId: string, notas: string): Promise<void> {
    await this.actualizarConversacion(tenantId, conversacionId, { notas });
  }

  async metricas(tenantId: string): Promise<Metricas> {
    const ahora = new Date();
    const hace7d = new Date(ahora.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const hace14d = new Date(ahora.getTime() - 14 * 24 * 60 * 60 * 1000).toISOString();

    const leido = await conTenant(this.db, tenantId, async (tx) => {
      const [aggResult, citas, periodoResult, cotizacionesFilas, rechazosResult, seguimientosFilas, historico] =
        await Promise.all([
          // Conversaciones all-time + cuántas en humano + cuántas NUNCA escalaron (C3.3).
          tx.execute(sql`
            SELECT count(*) AS total, count(*) FILTER (WHERE modo = 'humano') AS humano,
                   count(*) FILTER (WHERE humano_en IS NULL) AS sin_escalar
            FROM wa_conversaciones WHERE tenant_id = ${tenantId}
          `),
          tx
            .select({
              estado: waCitas.estado,
              precio: waCitas.precio,
              servicioId: waCitas.servicioId,
              fecha: waCitas.fecha,
              hora: waCitas.hora,
              clienteWa: waCitas.clienteWa,
              origen: waCitas.origen,
              creadaEn: waCitas.creadaEn,
              addons: waCitas.addons,
            })
            .from(waCitas)
            .where(eq(waCitas.tenantId, tenantId)),
          // Nuevas conversaciones por período (creada_en: más estable que la última actividad).
          tx.execute(sql`
            SELECT
              count(*) FILTER (WHERE creada_en >= ${hace7d}) AS convs_actual,
              count(*) FILTER (WHERE creada_en >= ${hace14d} AND creada_en < ${hace7d}) AS convs_previo
            FROM wa_conversaciones WHERE tenant_id = ${tenantId}
          `),
          tx
            .select({ estado: waCotizaciones.estado, montoRecuperado: waCotizaciones.montoRecuperado })
            .from(waCotizaciones)
            .where(eq(waCotizaciones.tenantId, tenantId)),
          tx.execute(sql`
            SELECT COALESCE(SUM(jsonb_array_length(upsells_rechazados)), 0) AS rechazos
            FROM wa_conversaciones WHERE tenant_id = ${tenantId}
          `),
          tx.select({ sentimiento: waSeguimientos.sentimiento }).from(waSeguimientos).where(eq(waSeguimientos.tenantId, tenantId)),
          leerHistoricoReputacion(tx, tenantId, 30),
        ]);
      return { aggResult, citas, periodoResult, cotizacionesFilas, rechazosResult, seguimientosFilas, historico };
    });
    const { citas, cotizacionesFilas, seguimientosFilas, historico } = leido;

    const agg = filasDe<{ total: number | string; humano: number | string; sin_escalar: number | string }>(leido.aggResult)[0];
    const periodo = filasDe<{ convs_actual: number | string; convs_previo: number | string }>(leido.periodoResult)[0];
    const rechazosAddon = Number(filasDe<{ rechazos: number | string }>(leido.rechazosResult)[0]?.rechazos ?? 0);
    const base = calcularMetricas(
      Number(agg.total),
      Number(agg.humano),
      Number(agg.sin_escalar),
      citas,
      cotizacionesFilas,
      rechazosAddon,
      seguimientosFilas,
    );

    // Citas del período actual (últimos 7 días) y previo (7-14 días atrás) por creación.
    const citasActivas = (c: (typeof citas)[0]) => c.estado !== "cancelada";
    const enActual = citas.filter((c) => c.creadaEn >= new Date(hace7d));
    const enPrevio = citas.filter((c) => c.creadaEn >= new Date(hace14d) && c.creadaEn < new Date(hace7d));

    const citasA = enActual.filter(citasActivas).length;
    const citasP = enPrevio.filter(citasActivas).length;
    const ingresosA = enActual.filter(citasActivas).reduce((s, c) => s + (c.precio ?? 0), 0);
    const ingresosP = enPrevio.filter(citasActivas).reduce((s, c) => s + (c.precio ?? 0), 0);
    const convsA = Number(periodo.convs_actual);
    const convsP = Number(periodo.convs_previo);
    const convPctA = convsA ? Math.round((citasA / convsA) * 100) : 0;
    const convPctP = convsP ? Math.round((citasP / convsP) * 100) : 0;

    const deltas: Metricas["deltas"] = {
      conversaciones: formatDelta(convsA, convsP),
      citas: formatDelta(citasA, citasP),
      conversion: formatDelta(convPctA, convPctP),
      ingresos: formatDelta(ingresosA, ingresosP),
    };
    const hayDeltas = Object.values(deltas).some(Boolean);

    // Reputación en Google (Places API): último snapshot + histórico.
    const reputacion = historico.length
      ? { rating: historico[0].rating, totalResenas: historico[0].totalResenas, historico: [...historico].reverse() }
      : undefined;

    return { ...base, ...(hayDeltas ? { deltas } : {}), ...(reputacion ? { reputacion } : {}) };
  }

  // ── Notificaciones push ──
  async guardarPushSub(tenantId: string, sub: PushSub, opciones?: { maxPorUsuario?: number }): Promise<void> {
    const usuarioId = sub.usuarioId ?? null;
    const sessionEpoch = sub.sessionEpoch ?? null;
    // Upsert por endpoint: el dispositivo pasa a ser de quien se suscribe AHORA, aunque
    // antes fuera de OTRO negocio (mismo navegador, otro login) — por eso corre en contexto
    // de sistema: con conTenant, la política no dejaría tomar una fila ajena. El tenantId
    // y el usuarioId salen de la sesión ya validada por el router, no del cliente.
    await conSistema(this.db, (tx) =>
      tx
        .insert(waPushSubs)
        .values({ tenantId, usuarioId, sessionEpoch, endpoint: sub.endpoint, p256dh: sub.p256dh, auth: sub.auth })
        .onConflictDoUpdate({
          target: waPushSubs.endpoint,
          set: { tenantId, usuarioId, sessionEpoch, p256dh: sub.p256dh, auth: sub.auth, creadaEn: new Date() },
        }),
    );
    const max = opciones?.maxPorUsuario;
    if (usuarioId && max && max > 0) {
      // Tope por usuario: se quedan las `max` más recientes; el resto se borra.
      await conTenant(this.db, tenantId, async (tx) => {
        const filas = await tx
          .select({ id: waPushSubs.id })
          .from(waPushSubs)
          .where(and(eq(waPushSubs.tenantId, tenantId), eq(waPushSubs.usuarioId, usuarioId)))
          .orderBy(desc(waPushSubs.creadaEn));
        const sobrantes = filas.slice(max).map((f) => f.id);
        if (sobrantes.length) await tx.delete(waPushSubs).where(inArray(waPushSubs.id, sobrantes));
      });
    }
  }

  async listarPushSubs(tenantId: string): Promise<PushSub[]> {
    const rows = await conTenant(this.db, tenantId, (tx) => tx.select().from(waPushSubs).where(eq(waPushSubs.tenantId, tenantId)));
    return rows.map((r) => ({
      endpoint: r.endpoint,
      p256dh: r.p256dh,
      auth: r.auth,
      usuarioId: r.usuarioId,
      sessionEpoch: r.sessionEpoch,
    }));
  }

  async borrarPushSub(tenantId: string, endpoint: string, usuarioId?: string): Promise<void> {
    await conTenant(this.db, tenantId, (tx) =>
      tx
        .delete(waPushSubs)
        .where(
          and(
            eq(waPushSubs.endpoint, endpoint),
            eq(waPushSubs.tenantId, tenantId),
            usuarioId !== undefined ? eq(waPushSubs.usuarioId, usuarioId) : undefined,
          ),
        ),
    );
  }

  async borrarPushSubsDeUsuario(tenantId: string, usuarioId: string): Promise<void> {
    await conTenant(this.db, tenantId, (tx) =>
      tx.delete(waPushSubs).where(and(eq(waPushSubs.tenantId, tenantId), eq(waPushSubs.usuarioId, usuarioId))),
    );
  }

  // ── Helpers internos ──

  /** UPDATE de una conversación del negocio. */
  private async actualizarConversacion(
    tenantId: string,
    conversacionId: string,
    cambios: PgUpdateSetSource<typeof waConversaciones>,
  ): Promise<void> {
    await conTenant(this.db, tenantId, (tx) =>
      tx
        .update(waConversaciones)
        .set(cambios)
        .where(and(eq(waConversaciones.id, conversacionId), eq(waConversaciones.tenantId, tenantId))),
    );
  }

  /** UPDATE de una cita del negocio (opcionalmente solo si sigue "agendada"); devuelve la cita o null. */
  private async actualizarCita(
    tenantId: string,
    citaId: string,
    cambios: PgUpdateSetSource<typeof waCitas>,
    soloAgendada = false,
  ): Promise<Cita | null> {
    const [r] = await conTenant(this.db, tenantId, (tx) =>
      tx
        .update(waCitas)
        .set(cambios)
        .where(
          and(eq(waCitas.id, citaId), eq(waCitas.tenantId, tenantId), soloAgendada ? eq(waCitas.estado, "agendada") : undefined),
        )
        .returning(),
    );
    return r ? filaACita(r) : null;
  }
}

function leerHistoricoReputacion(tx: Tx, tenantId: string, limite: number): Promise<SnapshotReputacion[]> {
  return tx
    .select({ fecha: waSnapshotReputacion.fecha, rating: waSnapshotReputacion.rating, totalResenas: waSnapshotReputacion.totalResenas })
    .from(waSnapshotReputacion)
    .where(eq(waSnapshotReputacion.tenantId, tenantId))
    .orderBy(desc(waSnapshotReputacion.fecha))
    .limit(limite);
}
