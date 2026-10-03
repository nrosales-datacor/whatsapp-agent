import { and, desc, eq, gte, inArray, isNull, lte, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import {
  schema,
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
import { resolverMediaParaPanel } from "../storage/supabaseStorage";
import { HorarioOcupadoError } from "./errores";

// ─────────────────────────────────────────────────────────────────────────────
// Repositorio Drizzle. Implementa la MISMA interfaz que el de memoria.
// Recibe el cliente drizzle ya creado por tu monorepo (no crea uno nuevo).
//
// En el monorepo, importá las tablas desde "@gp/db/schema" en lugar de "../db/schema".
// ─────────────────────────────────────────────────────────────────────────────

type DB = PostgresJsDatabase<typeof schema>;

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

const DIAS_NO_INSISTIR_ADDON = 60;

/** "YYYY-MM-DD" de hace `dias` días respecto de `hoy` (aritmética UTC al mediodía: sin sorpresas de DST). */
function fechaHaceDias(dias: number, hoy: string): string {
  const d = new Date(`${hoy}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - dias);
  return d.toISOString().slice(0, 10);
}

/**
 * Doble reserva (revisión pre-venta 2026-10): serializa TODA escritura de citas de un
 * mismo tenant+fecha con un advisory lock de TRANSACCIÓN (pooler-safe: se suelta solo
 * al commit/rollback, nunca queda colgado en una conexión del pool). Así el re-chequeo
 * de `verificar` y el INSERT/UPDATE son atómicos respecto de cualquier otra cita de
 * ese día — cosa que el índice único no puede dar: excluye `empleado_id IS NULL`
 * (modo recurso único, el más común) y solo ve la hora EXACTA, no solapes por
 * duración. El lock es por día, no global: dos negocios (o dos días) no se esperan.
 */
async function bloquearAgendaDelDia(tx: { execute: DB["execute"] }, tenantId: string, fecha: string): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`wa_citas:${tenantId}:${fecha}`}, 0))`);
}

export class RepositorioDrizzle implements Repositorio {
  constructor(private db: DB) {}

  async obtenerOConversacion(tenantId: string, clienteWa: string): Promise<Conversacion> {
    // Race-safe: inserta si no existe, luego lee.
    await this.db
      .insert(waConversaciones)
      .values({ tenantId, clienteWa })
      .onConflictDoNothing();

    const [conv] = await this.db
      .select()
      .from(waConversaciones)
      .where(and(eq(waConversaciones.tenantId, tenantId), eq(waConversaciones.clienteWa, clienteWa)))
      .limit(1);

    // Últimos 20 (los más recientes), devueltos en orden cronológico. Con `asc` +
    // limit traíamos los 20 MÁS VIEJOS, así que en conversaciones largas el agente
    // perdía el contexto reciente.
    const msgs = (
      await this.db
        .select()
        .from(waMensajes)
        .where(eq(waMensajes.conversacionId, conv.id))
        .orderBy(desc(waMensajes.creadoEn))
        .limit(20)
    ).reverse();

    // F9, decisión deliberada: acá NO se resuelve `mediaUrl` con `resolverMediaParaPanel`
    // (a diferencia de `obtenerConversacionPorId`, que sí lo hace). Esta lectura corre
    // en el HOT PATH del webhook (una vez por cada mensaje entrante, para armar el
    // historial que ve el agente) y ningún consumidor real lee `mediaUrl` de acá —
    // `correrAgente` recibe la foto del turno actual por `imagenDataUrl` en memoria
    // (`handleWebhook.ts`), nunca releyendo el historial. Firmar una URL de Storage
    // por cada foto del historial en cada mensaje sería una llamada de red extra sin
    // ningún consumidor, en el camino más caliente del sistema. Se deja el valor
    // crudo (ruta corta de Storage o data URL legado) tal cual está en la columna.
    const mensajes: MensajeConversacion[] = msgs.map((m) => ({
      rol: m.rol as "user" | "assistant",
      contenido: m.contenido,
      creadoEn: m.creadoEn.toISOString(),
      porHumano: m.porHumano,
      // waMessageId (hallazgo de F4): faltaba en esta proyección — RepositorioEnMemoria
      // SÍ lo expone (guarda el objeto completo), así que un consumidor que necesite
      // ubicar un mensaje por su id de WhatsApp tras una lectura vería un
      // comportamiento distinto según la implementación. Nada en producción lo lee
      // hoy (el dedup usa el índice único al escribir, no una relectura), pero es la
      // clase de divergencia que este ítem pide no esconder.
      waMessageId: m.waMessageId ?? undefined,
      mediaUrl: m.mediaUrl ?? undefined,
      mediaTipo: (m.mediaTipo as "imagen" | undefined) ?? undefined,
    }));

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
  }

  async guardarMensaje(tenantId: string, conversacionId: string, msg: MensajeConversacion): Promise<boolean> {
    // wa_mensajes NO tiene columna tenant_id (esa es F1, no F4): se valida el
    // tenant vía la conversación ANTES de insertar, para que un conversacionId
    // de otro negocio nunca pueda colgar un mensaje acá (defensa en profundidad;
    // hoy el id siempre llega de una lectura ya scopeada, pero el día que no,
    // esto lo corta en seco en vez de dejarlo pasar).
    const [conv] = await this.db
      .select({ id: waConversaciones.id })
      .from(waConversaciones)
      .where(and(eq(waConversaciones.id, conversacionId), eq(waConversaciones.tenantId, tenantId)))
      .limit(1);
    if (!conv) return false;

    // onConflictDoNothing sobre el índice único de wa_message_id: si Meta reintrega
    // el mismo mensaje, no se inserta de nuevo y devolvemos false (idempotencia).
    // Los salientes no traen waMessageId (NULL) → nunca chocan → siempre se insertan.
    const filas = await this.db
      .insert(waMensajes)
      .values({
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
  }

  async actualizarMediaMensaje(
    tenantId: string,
    conversacionId: string,
    waMessageId: string,
    mediaUrl: string,
    mediaTipo: "imagen",
  ): Promise<void> {
    // Mismo motivo que guardarMensaje: wa_mensajes no tiene tenant_id, se valida
    // vía la conversación antes de tocar la fila.
    const [conv] = await this.db
      .select({ id: waConversaciones.id })
      .from(waConversaciones)
      .where(and(eq(waConversaciones.id, conversacionId), eq(waConversaciones.tenantId, tenantId)))
      .limit(1);
    if (!conv) return;

    await this.db
      .update(waMensajes)
      .set({ mediaUrl, mediaTipo })
      .where(and(eq(waMensajes.conversacionId, conversacionId), eq(waMensajes.waMessageId, waMessageId)));
  }

  async marcarOptIn(tenantId: string, conversacionId: string): Promise<void> {
    await this.db
      .update(waConversaciones)
      .set({ optInEn: new Date() })
      .where(and(eq(waConversaciones.id, conversacionId), eq(waConversaciones.tenantId, tenantId)));
  }

  async marcarOptOut(tenantId: string, conversacionId: string): Promise<void> {
    await this.db
      .update(waConversaciones)
      .set({ optOutEn: new Date() })
      .where(and(eq(waConversaciones.id, conversacionId), eq(waConversaciones.tenantId, tenantId)));
  }

  async citasPorFecha(tenantId: string, fecha: string): Promise<Cita[]> {
    const rows = await this.db
      .select()
      .from(waCitas)
      .where(and(eq(waCitas.tenantId, tenantId), eq(waCitas.fecha, fecha)));

    return rows.map(filaACita);
  }

  async citasEnRango(tenantId: string, desde: string, hasta: string): Promise<Cita[]> {
    const rows = await this.db
      .select()
      .from(waCitas)
      .where(and(eq(waCitas.tenantId, tenantId), gte(waCitas.fecha, desde), lte(waCitas.fecha, hasta)))
      .orderBy(waCitas.fecha, waCitas.hora);

    return rows.map(filaACita);
  }

  async crearCita(cita: Omit<Cita, "id" | "creadaEn" | "estado">, verificar?: VerificarHorario): Promise<Cita> {
    return this.db.transaction(async (tx) => {
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
    await this.db
      .update(waCitas)
      .set({ gcalEventId: eventId })
      .where(and(eq(waCitas.id, citaId), eq(waCitas.tenantId, tenantId)));
  }

  async citasActivasCliente(tenantId: string, clienteWa: string, desdeFecha: string): Promise<Cita[]> {
    const rows = await this.db
      .select()
      .from(waCitas)
      .where(
        and(
          eq(waCitas.tenantId, tenantId),
          eq(waCitas.clienteWa, clienteWa),
          eq(waCitas.estado, "agendada"),
          sql`${waCitas.fecha} >= ${desdeFecha}`,
        ),
      )
      .orderBy(waCitas.fecha, waCitas.hora);
    return rows.map(filaACita);
  }

  async reprogramarCita(
    tenantId: string,
    citaId: string,
    fecha: string,
    hora: string,
    verificar?: VerificarHorario,
  ): Promise<Cita | null> {
    return this.db.transaction(async (tx) => {
      // Se bloquea la fecha DESTINO: es la única donde se consume capacidad (la de
      // origen solo se libera).
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
    const [r] = await this.db
      .select()
      .from(waCitas)
      .where(and(eq(waCitas.id, citaId), eq(waCitas.tenantId, tenantId)))
      .limit(1);
    return r ? filaACita(r) : null;
  }

  async reasignarCita(tenantId: string, citaId: string, empleadoId: string | null): Promise<Cita | null> {
    const [r] = await this.db
      .update(waCitas)
      .set({ empleadoId })
      .where(and(eq(waCitas.id, citaId), eq(waCitas.tenantId, tenantId)))
      .returning();
    return r ? filaACita(r) : null;
  }

  async cancelarCita(tenantId: string, citaId: string): Promise<Cita | null> {
    const [r] = await this.db
      .update(waCitas)
      .set({ estado: "cancelada" })
      .where(and(eq(waCitas.id, citaId), eq(waCitas.tenantId, tenantId)))
      .returning();
    return r ? filaACita(r) : null;
  }

  async confirmarCita(tenantId: string, citaId: string): Promise<Cita | null> {
    // COALESCE conserva la primera confirmación si el cliente toca el botón dos veces.
    // Solo confirma citas "agendada" (no una cancelada/completada).
    const [r] = await this.db
      .update(waCitas)
      .set({ confirmadaEn: sql`COALESCE(${waCitas.confirmadaEn}, now())` })
      .where(and(eq(waCitas.id, citaId), eq(waCitas.tenantId, tenantId), eq(waCitas.estado, "agendada")))
      .returning();
    return r ? filaACita(r) : null;
  }

  async completarCita(tenantId: string, citaId: string): Promise<Cita | null> {
    const [r] = await this.db
      .update(waCitas)
      .set({ estado: "completada" })
      .where(and(eq(waCitas.id, citaId), eq(waCitas.tenantId, tenantId), eq(waCitas.estado, "agendada")))
      .returning();
    return r ? filaACita(r) : null;
  }

  async marcarNoShow(tenantId: string, citaId: string): Promise<Cita | null> {
    const [r] = await this.db
      .update(waCitas)
      .set({ estado: "no_show" })
      .where(and(eq(waCitas.id, citaId), eq(waCitas.tenantId, tenantId), eq(waCitas.estado, "agendada")))
      .returning();
    return r ? filaACita(r) : null;
  }

  async registrarCotizacion(tenantId: string, clienteWa: string, servicioId: string, monto: number): Promise<Cotizacion | null> {
    const [activa] = await this.db
      .select({ id: waCotizaciones.id })
      .from(waCotizaciones)
      .where(
        and(
          eq(waCotizaciones.tenantId, tenantId),
          eq(waCotizaciones.clienteWa, clienteWa),
          sql`${waCotizaciones.estado} IN ('pendiente', 'toque1', 'toque2')`,
        ),
      )
      .limit(1);
    if (activa) return null; // no dos rescates activos al mismo teléfono

    const [r] = await this.db.insert(waCotizaciones).values({ tenantId, clienteWa, servicioId, monto }).returning();
    return filaACotizacion(r);
  }

  async actualizarCotizacionPorCita(
    tenantId: string,
    clienteWa: string,
    servicioId: string,
    citaId: string,
    montoCita?: number,
  ): Promise<void> {
    const [activa] = await this.db
      .select()
      .from(waCotizaciones)
      .where(
        and(
          eq(waCotizaciones.tenantId, tenantId),
          eq(waCotizaciones.clienteWa, clienteWa),
          eq(waCotizaciones.servicioId, servicioId),
          sql`${waCotizaciones.estado} IN ('pendiente', 'toque1', 'toque2')`,
        ),
      )
      .limit(1);
    if (!activa) return;

    const yaTuvoToque = activa.estado === "toque1" || activa.estado === "toque2";
    await this.db
      .update(waCotizaciones)
      .set({
        estado: yaTuvoToque ? "recuperada" : "agendada",
        citaId,
        montoRecuperado: yaTuvoToque ? (montoCita ?? activa.monto) : null,
      })
      .where(eq(waCotizaciones.id, activa.id));
  }

  async agregarAddonACita(tenantId: string, citaId: string, addon: AddonCita): Promise<Cita | null> {
    const [fila] = await this.db
      .select()
      .from(waCitas)
      .where(and(eq(waCitas.id, citaId), eq(waCitas.tenantId, tenantId)))
      .limit(1);
    if (!fila) return null;
    if (fila.addons.some((a) => a.servicioId === addon.servicioId)) return filaACita(fila); // idempotente

    const [actualizada] = await this.db
      .update(waCitas)
      .set({ addons: [...fila.addons, addon] })
      // Defensa en profundidad (F4): el SELECT de arriba ya validó el tenant, pero
      // el UPDATE debe scopear igual — no depender solo del filtro previo.
      .where(and(eq(waCitas.id, citaId), eq(waCitas.tenantId, tenantId)))
      .returning();
    return filaACita(actualizada);
  }

  async registrarRechazoAddon(tenantId: string, clienteWa: string, addonId: string): Promise<void> {
    const [conv] = await this.db
      .select({ id: waConversaciones.id, upsellsRechazados: waConversaciones.upsellsRechazados })
      .from(waConversaciones)
      .where(and(eq(waConversaciones.tenantId, tenantId), eq(waConversaciones.clienteWa, clienteWa)))
      .limit(1);
    if (!conv) return;
    const rechazo = { addonId, fecha: new Date().toISOString().slice(0, 10) };
    await this.db
      .update(waConversaciones)
      .set({ upsellsRechazados: [...conv.upsellsRechazados, rechazo] })
      .where(eq(waConversaciones.id, conv.id));
  }

  async fueRechazadoAddonRecientemente(tenantId: string, clienteWa: string, addonId: string, hoy: string): Promise<boolean> {
    const [conv] = await this.db
      .select({ upsellsRechazados: waConversaciones.upsellsRechazados })
      .from(waConversaciones)
      .where(and(eq(waConversaciones.tenantId, tenantId), eq(waConversaciones.clienteWa, clienteWa)))
      .limit(1);
    if (!conv) return false;
    const corte = fechaHaceDias(DIAS_NO_INSISTIR_ADDON, hoy);
    return conv.upsellsRechazados.some((r) => r.addonId === addonId && r.fecha >= corte);
  }

  async marcarRecordatorio(tenantId: string, citaId: string, tipo: TipoRecordatorio): Promise<void> {
    const cambio =
      tipo === "dia_antes"
        ? { recordatorioDiaAntesEn: new Date() }
        : tipo === "mismo_dia"
          ? { recordatorioMismoDiaEn: new Date() }
          : { postServicioEn: new Date() };
    await this.db
      .update(waCitas)
      .set(cambio)
      .where(and(eq(waCitas.id, citaId), eq(waCitas.tenantId, tenantId)));
  }

  async reclamarRecordatorio(tenantId: string, citaId: string, tipo: TipoRecordatorio): Promise<boolean> {
    // UPDATE ... WHERE col IS NULL RETURNING id — atómico: solo una instancia pasa
    // de NULL a timestamp; las demás obtienen 0 filas → claim perdido → continue.
    const col =
      tipo === "dia_antes"
        ? waCitas.recordatorioDiaAntesEn
        : tipo === "mismo_dia"
          ? waCitas.recordatorioMismoDiaEn
          : waCitas.postServicioEn;
    const cambio =
      tipo === "dia_antes"
        ? { recordatorioDiaAntesEn: new Date() }
        : tipo === "mismo_dia"
          ? { recordatorioMismoDiaEn: new Date() }
          : { postServicioEn: new Date() };
    const filas = await this.db
      .update(waCitas)
      .set(cambio)
      .where(and(eq(waCitas.id, citaId), eq(waCitas.tenantId, tenantId), isNull(col)))
      .returning({ id: waCitas.id });
    return filas.length > 0;
  }

  async revertirRecordatorio(tenantId: string, citaId: string, tipo: TipoRecordatorio): Promise<void> {
    const cambio =
      tipo === "dia_antes"
        ? { recordatorioDiaAntesEn: null }
        : tipo === "mismo_dia"
          ? { recordatorioMismoDiaEn: null }
          : { postServicioEn: null };
    await this.db
      .update(waCitas)
      .set(cambio)
      .where(and(eq(waCitas.id, citaId), eq(waCitas.tenantId, tenantId)));
  }

  // ── Motor de reseñas de Google completo (Carril D, Fase 1 - 1.3) ──
  async crearSeguimiento(tenantId: string, citaId: string): Promise<void> {
    await this.db.insert(waSeguimientos).values({ tenantId, citaId }).onConflictDoNothing();
  }

  async registrarRespuestaSeguimiento(
    tenantId: string,
    citaId: string,
    sentimiento: Sentimiento,
    resenaSolicitada: boolean,
    respuestaTexto: string,
  ): Promise<void> {
    await this.db
      .update(waSeguimientos)
      .set({ sentimiento, resenaSolicitada, respuestaTexto })
      .where(and(eq(waSeguimientos.citaId, citaId), eq(waSeguimientos.tenantId, tenantId)));
  }

  async seguimientosDeTenant(tenantId: string): Promise<Seguimiento[]> {
    const rows = await this.db.select().from(waSeguimientos).where(eq(waSeguimientos.tenantId, tenantId));
    return rows.map(filaASeguimiento);
  }

  async guardarSnapshotReputacion(tenantId: string, fecha: string, rating: number, totalResenas: number): Promise<void> {
    await this.db
      .insert(waSnapshotReputacion)
      .values({ tenantId, fecha, rating, totalResenas })
      .onConflictDoUpdate({
        target: [waSnapshotReputacion.tenantId, waSnapshotReputacion.fecha],
        set: { rating, totalResenas },
      });
  }

  async historicoReputacion(tenantId: string, limite: number): Promise<SnapshotReputacion[]> {
    const rows = await this.db
      .select({ fecha: waSnapshotReputacion.fecha, rating: waSnapshotReputacion.rating, totalResenas: waSnapshotReputacion.totalResenas })
      .from(waSnapshotReputacion)
      .where(eq(waSnapshotReputacion.tenantId, tenantId))
      .orderBy(desc(waSnapshotReputacion.fecha))
      .limit(limite);
    return rows;
  }

  async guardarEntranteYEncolar(
    conversacionId: string,
    msg: MensajeConversacion,
    payload: PendienteSerializado,
    ejecutarDespuesDe?: Date,
  ): Promise<boolean> {
    // Una sola transacción: "mensaje persistido ⇒ job encolado" es invariante.
    // Si el proceso muere a mitad, Postgres revierte ambas filas → Meta reintenta
    // → Fase 1 vuelve a intentar → finalmente quedan ambas o ninguna.
    let encolado = false;
    await this.db.transaction(async (tx) => {
      const filas = await tx
        .insert(waMensajes)
        .values({
          conversacionId,
          rol: msg.rol,
          contenido: msg.contenido,
          porHumano: msg.porHumano ?? false,
          waMessageId: msg.waMessageId ?? null,
        })
        .onConflictDoNothing()
        .returning({ id: waMensajes.id });
      if (filas.length === 0) return; // mensaje duplicado → no encolar
      await tx
        .insert(waJobs)
        .values({
          tenantId: payload.tenantId,
          payload,
          waMessageId: msg.waMessageId ?? null,
          // F10: rate limit de ingesta excedido → el worker no lo reclama hasta
          // ese momento (ver el WHERE de reclamarUno en queue/cola.ts, que ya
          // respeta esta columna). undefined deja el default de la columna (now()).
          ...(ejecutarDespuesDe ? { ejecutarDespuesDe } : {}),
        })
        .onConflictDoNothing(); // idempotencia extra por waMessageId
      // Cola de trabajo (C2.3): un mensaje nuevo del cliente reabre la conversación,
      // aunque el operador la hubiera marcado "atendida". Misma transacción: atómico
      // con el insert del mensaje.
      await tx.update(waConversaciones).set({ estado: "abierta" }).where(eq(waConversaciones.id, conversacionId));
      encolado = true;
    });
    return encolado;
  }

  async registrarCalidad(evento: {
    tenantId: string;
    clienteWa: string;
    tipo: "mensaje_ok" | "fuera_de_alcance" | "error";
    detalle?: string;
  }): Promise<void> {
    await this.db.insert(waEventosCalidad).values(evento);
  }

  // ── Panel / bandeja humana ──
  async setModoConversacion(tenantId: string, conversacionId: string, modo: ModoConversacion): Promise<void> {
    // Al pasar de bot a humano marcamos humano_en = now() (el ÚLTIMO traspaso: es el
    // reloj de `modoHumanoVencido`). Si ya estaba en humano, no se pisa (re-disparo).
    // Al volver a bot NO la borramos: `humano_en IS NULL` sigue significando "nunca
    // se escaló" para las métricas de ahorro (C3.3).
    await this.db
      .update(waConversaciones)
      .set(
        modo === "humano"
          ? {
              modo,
              humanoEn: sql`CASE WHEN ${waConversaciones.modo} <> 'humano' THEN now() ELSE COALESCE(${waConversaciones.humanoEn}, now()) END`,
            }
          : { modo },
      )
      .where(and(eq(waConversaciones.id, conversacionId), eq(waConversaciones.tenantId, tenantId)));
  }

  async marcarEstadoConversacion(tenantId: string, conversacionId: string, estado: EstadoConversacion): Promise<void> {
    await this.db
      .update(waConversaciones)
      .set({ estado })
      .where(and(eq(waConversaciones.id, conversacionId), eq(waConversaciones.tenantId, tenantId)));
  }

  async listarConversaciones(tenantId: string): Promise<ResumenConversacion[]> {
    // Una sola consulta: por cada conversación trae su último mensaje vía LATERAL
    // (usa el índice wa_msg_conv_idx). Evita el patrón N+1 (1 query por conversación)
    // que hacía lento el panel, sobre todo con el polling cada 4s.
    // sin_leer se calcula (no es un contador mutable): cuenta los mensajes del
    // cliente posteriores a leido_hasta, y SOLO cuando la conversación está en modo
    // humano (en modo bot no requiere atención, así el badge significa algo).
    // También trae datos para el lead score (último rol, cita activa, histórico de citas).
    // filasDe (F4): db.execute(sql`…`) devuelve formas distintas según el driver
    // (postgres.js en producción → arreglo directo; PGlite en tests → `{ rows }`).
    // Antes de F4 esta consulta nunca se había ejercido contra PGlite (el ángulo 5
    // de fiabilidad no cubre listarConversaciones) y el cast a Array asumía siempre
    // postgres.js — se cae en seco contra PGlite. Mismo gotcha que ya resuelve
    // `metricas()` más abajo.
    const filas = filasDe<{
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
      await this.db.execute(sql`
      SELECT
        c.id,
        c.cliente_wa,
        c.modo,
        c.estado,
        c.creada_en,
        m.contenido AS ultimo_mensaje,
        m.rol AS ultimo_rol,
        COALESCE(m.creado_en, c.creada_en) AS ultima_actividad,
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
          AND estado = 'agendada' AND fecha >= current_date::text
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
      WHERE c.tenant_id = ${tenantId}
      ORDER BY ultima_actividad DESC
    `),
    );

    const hace24h = Date.now() - 24 * 60 * 60 * 1000;

    return filas.map((r) => {
      const ultimaActividad = new Date(r.ultima_actividad);
      // Heurística tentativa de lead score (calibrar con el negocio):
      // base 40 + tuvo alguna vez intención de cita (+25) + cliente esperando respuesta (+15)
      // + actividad reciente <24h (+10) + cita activa futura (+10).
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
    // Una sola consulta: el JOIN con la conversación aplica la frontera de tenant
    // (wa_mensajes no tiene tenant_id). Los N MÁS RECIENTES (desc + limit) y se
    // invierten a orden cronológico, mismo criterio que `obtenerOConversacion`. Sin
    // `resolverMediaParaPanel`: el agente no lee `mediaUrl` (ver nota F9 más arriba).
    const filas = await this.db
      .select({ m: waMensajes })
      .from(waMensajes)
      .innerJoin(waConversaciones, eq(waConversaciones.id, waMensajes.conversacionId))
      .where(and(eq(waMensajes.conversacionId, conversacionId), eq(waConversaciones.tenantId, tenantId)))
      .orderBy(desc(waMensajes.creadoEn))
      .limit(limite);
    return filas.reverse().map(({ m }) => ({
      rol: m.rol as "user" | "assistant",
      contenido: m.contenido,
      creadoEn: m.creadoEn.toISOString(),
      porHumano: m.porHumano,
      waMessageId: m.waMessageId ?? undefined,
      mediaUrl: m.mediaUrl ?? undefined,
      mediaTipo: (m.mediaTipo as "imagen" | undefined) ?? undefined,
    }));
  }

  async obtenerConversacionPorId(tenantId: string, conversacionId: string): Promise<Conversacion | null> {
    // Las dos lecturas (conversación + mensajes) van en paralelo: los mensajes se
    // filtran por conversacionId, que ya conocemos, así no hay que esperar la primera
    // consulta. Esto evita 2 viajes secuenciales a la base remota al abrir un chat.
    const [convRows, msgsDesc] = await Promise.all([
      this.db
        .select()
        .from(waConversaciones)
        .where(and(eq(waConversaciones.id, conversacionId), eq(waConversaciones.tenantId, tenantId)))
        .limit(1),
      // Los 100 MÁS RECIENTES (desc + limit), luego se invierten a orden cronológico.
      // Con `asc` + limit una conversación de >100 mensajes mostraba el principio y
      // nunca lo último, que es justo lo que el operador necesita ver.
      this.db
        .select()
        .from(waMensajes)
        .where(eq(waMensajes.conversacionId, conversacionId))
        .orderBy(desc(waMensajes.creadoEn))
        .limit(100),
    ]);
    const conv = convRows[0];
    if (!conv) return null; // no existe / no es de este tenant → descartamos los mensajes leídos
    const msgsAsc = msgsDesc.reverse();

    // Cita activa más próxima del cliente (para badge "Cita agendada" y subtítulo servicio).
    const [citaActiva] = await this.db
      .select({ servicioId: waCitas.servicioId, confirmadaEn: waCitas.confirmadaEn })
      .from(waCitas)
      .where(
        and(
          eq(waCitas.tenantId, tenantId),
          eq(waCitas.clienteWa, conv.clienteWa),
          eq(waCitas.estado, "agendada"),
          sql`${waCitas.fecha} >= current_date::text`,
        ),
      )
      .orderBy(waCitas.fecha, waCitas.hora)
      .limit(1);

    // F9: este es el payload del chat que sirve el panel (`router.ts`, hasta 100
    // mensajes) — acá SÍ vale la pena resolver `mediaUrl` a algo mostrable: si la
    // columna guarda una ruta de Storage, se firma (URL de corta vida); si es un
    // data URL legado (filas de antes de F9, o el fallback sin Storage
    // configurado), se devuelve tal cual. `resolverMediaParaPanel` nunca lanza.
    const mensajes: MensajeConversacion[] = await Promise.all(
      msgsAsc.map(async (m) => ({
        rol: m.rol as "user" | "assistant",
        contenido: m.contenido,
        creadoEn: m.creadoEn.toISOString(),
        porHumano: m.porHumano,
        // waMessageId (hallazgo de F4): faltaba en esta proyección — RepositorioEnMemoria
        // SÍ lo expone (guarda el objeto completo), así que un consumidor que necesite
        // ubicar un mensaje por su id de WhatsApp tras una lectura vería un
        // comportamiento distinto según la implementación. Nada en producción lo lee
        // hoy (el dedup usa el índice único al escribir, no una relectura), pero es la
        // clase de divergencia que este ítem pide no esconder.
        waMessageId: m.waMessageId ?? undefined,
        mediaUrl: await resolverMediaParaPanel(m.mediaUrl),
        mediaTipo: (m.mediaTipo as "imagen" | undefined) ?? undefined,
      })),
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

  async obtenerModo(tenantId: string, conversacionId: string): Promise<ModoConversacion | null> {
    const [row] = await this.db
      .select({ modo: waConversaciones.modo })
      .from(waConversaciones)
      .where(and(eq(waConversaciones.id, conversacionId), eq(waConversaciones.tenantId, tenantId)))
      .limit(1);
    return row ? (row.modo as ModoConversacion) : null;
  }

  async marcarLeidas(tenantId: string, conversacionId: string): Promise<void> {
    await this.db
      .update(waConversaciones)
      .set({ leidoHasta: new Date() })
      .where(and(eq(waConversaciones.id, conversacionId), eq(waConversaciones.tenantId, tenantId)));
  }

  async fichaCliente(tenantId: string, clienteWa: string): Promise<FichaCliente | null> {
    const [conv] = await this.db
      .select()
      .from(waConversaciones)
      .where(and(eq(waConversaciones.tenantId, tenantId), eq(waConversaciones.clienteWa, clienteWa)))
      .limit(1);

    const citas = await this.db
      .select()
      .from(waCitas)
      .where(and(eq(waCitas.tenantId, tenantId), eq(waCitas.clienteWa, clienteWa)))
      .orderBy(desc(waCitas.fecha));

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
    await this.db
      .update(waConversaciones)
      .set({ notas })
      .where(and(eq(waConversaciones.id, conversacionId), eq(waConversaciones.tenantId, tenantId)));
  }

  async metricas(tenantId: string): Promise<Metricas> {
    const ahora = new Date();
    const hace7d = new Date(ahora.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const hace14d = new Date(ahora.getTime() - 14 * 24 * 60 * 60 * 1000).toISOString();

    // Totales all-time + conteo por período para deltas (en paralelo).
    const [aggResult, citas, periodoResult, cotizacionesFilas, rechazosResult, seguimientosFilas] = await Promise.all([
      // Total de conversaciones all-time + cuántas en modo humano + cuántas NUNCA
      // escalaron (humano_en IS NULL → el bot las resolvió solo, para "ahorro". C3.3).
      this.db.execute(sql`
        SELECT count(*) AS total, count(*) FILTER (WHERE modo = 'humano') AS humano,
               count(*) FILTER (WHERE humano_en IS NULL) AS sin_escalar
        FROM wa_conversaciones WHERE tenant_id = ${tenantId}
      `) as unknown as Promise<Array<{ total: number | string; humano: number | string; sin_escalar: number | string }>>,
      // Todas las citas (para calcularMetricas all-time). Incluye creadaEn para deltas.
      this.db
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
      // Nuevas conversaciones por período (creada_en, no última actividad → más estable).
      this.db.execute(sql`
        SELECT
          count(*) FILTER (WHERE creada_en >= ${hace7d}) AS convs_actual,
          count(*) FILTER (WHERE creada_en >= ${hace14d} AND creada_en < ${hace7d}) AS convs_previo
        FROM wa_conversaciones WHERE tenant_id = ${tenantId}
      `) as unknown as Promise<Array<{ convs_actual: number | string; convs_previo: number | string }>>,
      // Rescate de cotizaciones (Carril D, 1.1): solo estado + monto recuperado, para la tarjeta.
      this.db
        .select({ estado: waCotizaciones.estado, montoRecuperado: waCotizaciones.montoRecuperado })
        .from(waCotizaciones)
        .where(eq(waCotizaciones.tenantId, tenantId)),
      // Upsell (Carril D, 1.2): total de add-ons rechazados (para la tasa de aceptación).
      this.db.execute(sql`
        SELECT COALESCE(SUM(jsonb_array_length(upsells_rechazados)), 0) AS rechazos
        FROM wa_conversaciones WHERE tenant_id = ${tenantId}
      `) as unknown as Promise<Array<{ rechazos: number | string }>>,
      // Motor de reseñas (Carril D, 1.3): solo sentimiento, para el contador de solicitudes.
      this.db
        .select({ sentimiento: waSeguimientos.sentimiento })
        .from(waSeguimientos)
        .where(eq(waSeguimientos.tenantId, tenantId)),
    ]);

    // Normaliza el resultado del SQL crudo: postgres.js (producción) devuelve el
    // arreglo directo, PGlite (tests de fiabilidad) devuelve `{ rows: [...] }`.
    const agg = filasDe<{ total: number | string; humano: number | string; sin_escalar: number | string }>(aggResult)[0];
    const periodo = filasDe<{ convs_actual: number | string; convs_previo: number | string }>(periodoResult)[0];
    const rechazosAddon = Number(filasDe<{ rechazos: number | string }>(rechazosResult)[0]?.rechazos ?? 0);
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
    const citasActivas = (c: typeof citas[0]) => c.estado !== "cancelada";
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
    // Si ningún delta tiene valor, omitir el objeto completo.
    const hayDeltas = Object.values(deltas).some(Boolean);

    // Reputación en Google (Carril D, 1.3-c, Places API): último snapshot + histórico.
    const historico = await this.historicoReputacion(tenantId, 30);
    const reputacion = historico.length
      ? { rating: historico[0].rating, totalResenas: historico[0].totalResenas, historico: [...historico].reverse() }
      : undefined;

    return { ...base, ...(hayDeltas ? { deltas } : {}), ...(reputacion ? { reputacion } : {}) };
  }

  // ── Notificaciones push ──
  async guardarPushSub(tenantId: string, sub: PushSub, opciones?: { maxPorUsuario?: number }): Promise<void> {
    const usuarioId = sub.usuarioId ?? null;
    const sessionEpoch = sub.sessionEpoch ?? null;
    // Upsert por endpoint: el dispositivo pasa a ser de quien se suscribe AHORA (otro
    // usuario logueado en el mismo navegador, o el mismo tras un cambio de clave). Se
    // renueva `creada_en` para que la poda de abajo lo trate como el más reciente.
    await this.db
      .insert(waPushSubs)
      .values({ tenantId, usuarioId, sessionEpoch, endpoint: sub.endpoint, p256dh: sub.p256dh, auth: sub.auth })
      .onConflictDoUpdate({
        target: waPushSubs.endpoint,
        set: { tenantId, usuarioId, sessionEpoch, p256dh: sub.p256dh, auth: sub.auth, creadaEn: new Date() },
      });
    const max = opciones?.maxPorUsuario;
    if (usuarioId && max && max > 0) {
      // Tope por usuario: se quedan las `max` más recientes; el resto se borra.
      const filas = await this.db
        .select({ id: waPushSubs.id })
        .from(waPushSubs)
        .where(and(eq(waPushSubs.tenantId, tenantId), eq(waPushSubs.usuarioId, usuarioId)))
        .orderBy(desc(waPushSubs.creadaEn));
      const sobrantes = filas.slice(max).map((f) => f.id);
      if (sobrantes.length) await this.db.delete(waPushSubs).where(inArray(waPushSubs.id, sobrantes));
    }
  }

  async listarPushSubs(tenantId: string): Promise<PushSub[]> {
    const rows = await this.db.select().from(waPushSubs).where(eq(waPushSubs.tenantId, tenantId));
    return rows.map((r) => ({
      endpoint: r.endpoint,
      p256dh: r.p256dh,
      auth: r.auth,
      usuarioId: r.usuarioId,
      sessionEpoch: r.sessionEpoch,
    }));
  }

  async borrarPushSub(tenantId: string, endpoint: string, usuarioId?: string): Promise<void> {
    await this.db
      .delete(waPushSubs)
      .where(
        and(
          eq(waPushSubs.endpoint, endpoint),
          eq(waPushSubs.tenantId, tenantId),
          usuarioId !== undefined ? eq(waPushSubs.usuarioId, usuarioId) : undefined,
        ),
      );
  }

  async borrarPushSubsDeUsuario(tenantId: string, usuarioId: string): Promise<void> {
    await this.db.delete(waPushSubs).where(and(eq(waPushSubs.tenantId, tenantId), eq(waPushSubs.usuarioId, usuarioId)));
  }
}
