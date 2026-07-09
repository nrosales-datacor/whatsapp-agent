import { and, desc, eq, gte, isNull, lte, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { schema, waCitas, waConversaciones, waEventosCalidad, waMensajes, waPushSubs, waJobs } from "../db/schema";
import type {
  Cita,
  Conversacion,
  FichaCliente,
  MensajeConversacion,
  Metricas,
  ModoConversacion,
  PendienteSerializado,
  PushSub,
  Repositorio,
  ResumenConversacion,
  TipoRecordatorio,
} from "../types";
import { calcularMetricas, formatDelta } from "../panel/metricas";

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
  };
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

    return {
      id: conv.id,
      tenantId: conv.tenantId,
      clienteWa: conv.clienteWa,
      optInEn: conv.optInEn ? conv.optInEn.toISOString() : null,
      modo: conv.modo as ModoConversacion,
      mensajes: msgs.map((m) => ({
        rol: m.rol as "user" | "assistant",
        contenido: m.contenido,
        creadoEn: m.creadoEn.toISOString(),
        porHumano: m.porHumano,
        mediaUrl: m.mediaUrl ?? undefined,
        mediaTipo: (m.mediaTipo as "imagen" | undefined) ?? undefined,
      })),
    };
  }

  async guardarMensaje(conversacionId: string, msg: MensajeConversacion): Promise<boolean> {
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
    conversacionId: string,
    waMessageId: string,
    mediaUrl: string,
    mediaTipo: "imagen",
  ): Promise<void> {
    await this.db
      .update(waMensajes)
      .set({ mediaUrl, mediaTipo })
      .where(and(eq(waMensajes.conversacionId, conversacionId), eq(waMensajes.waMessageId, waMessageId)));
  }

  async marcarOptIn(conversacionId: string): Promise<void> {
    await this.db
      .update(waConversaciones)
      .set({ optInEn: new Date() })
      .where(eq(waConversaciones.id, conversacionId));
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

  async crearCita(cita: Omit<Cita, "id" | "creadaEn" | "estado">): Promise<Cita> {
    const [r] = await this.db
      .insert(waCitas)
      .values({
        tenantId: cita.tenantId,
        clienteWa: cita.clienteWa,
        clienteNombre: cita.clienteNombre,
        servicioId: cita.servicioId,
        fecha: cita.fecha,
        hora: cita.hora,
        placa: cita.placa,
        precio: cita.precio,
        origen: cita.origen ?? "bot",
      })
      .returning();

    return {
      id: r.id,
      tenantId: r.tenantId,
      clienteWa: r.clienteWa,
      clienteNombre: r.clienteNombre,
      servicioId: r.servicioId,
      fecha: r.fecha,
      hora: r.hora,
      placa: r.placa ?? undefined,
      estado: r.estado as Cita["estado"],
      creadaEn: r.creadaEn.toISOString(),
      precio: r.precio ?? undefined,
    };
  }

  async guardarGcalEventId(citaId: string, eventId: string): Promise<void> {
    await this.db.update(waCitas).set({ gcalEventId: eventId }).where(eq(waCitas.id, citaId));
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

  async reprogramarCita(tenantId: string, citaId: string, fecha: string, hora: string): Promise<Cita | null> {
    // Reinicia los recordatorios: deben salir según el nuevo horario, no el viejo.
    const [r] = await this.db
      .update(waCitas)
      .set({ fecha, hora, recordatorioDiaAntesEn: null, recordatorioMismoDiaEn: null })
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

  async marcarRecordatorio(citaId: string, tipo: TipoRecordatorio): Promise<void> {
    const cambio =
      tipo === "dia_antes"
        ? { recordatorioDiaAntesEn: new Date() }
        : { recordatorioMismoDiaEn: new Date() };
    await this.db.update(waCitas).set(cambio).where(eq(waCitas.id, citaId));
  }

  async reclamarRecordatorio(citaId: string, tipo: TipoRecordatorio): Promise<boolean> {
    // UPDATE ... WHERE col IS NULL RETURNING id — atómico: solo una instancia pasa
    // de NULL a timestamp; las demás obtienen 0 filas → claim perdido → continue.
    const col = tipo === "dia_antes" ? waCitas.recordatorioDiaAntesEn : waCitas.recordatorioMismoDiaEn;
    const cambio =
      tipo === "dia_antes"
        ? { recordatorioDiaAntesEn: new Date() }
        : { recordatorioMismoDiaEn: new Date() };
    const filas = await this.db
      .update(waCitas)
      .set(cambio)
      .where(and(eq(waCitas.id, citaId), isNull(col)))
      .returning({ id: waCitas.id });
    return filas.length > 0;
  }

  async revertirRecordatorio(citaId: string, tipo: TipoRecordatorio): Promise<void> {
    const cambio =
      tipo === "dia_antes"
        ? { recordatorioDiaAntesEn: null }
        : { recordatorioMismoDiaEn: null };
    await this.db.update(waCitas).set(cambio).where(eq(waCitas.id, citaId));
  }

  async guardarEntranteYEncolar(
    conversacionId: string,
    msg: MensajeConversacion,
    payload: PendienteSerializado,
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
        .values({ tenantId: payload.tenantId, payload, waMessageId: msg.waMessageId ?? null })
        .onConflictDoNothing(); // idempotencia extra por waMessageId
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
    // Al pasar a humano marcamos humano_en SOLO si aún no estaba (COALESCE), para no
    // pisar la marca del primer traspaso si se re-dispara. Al volver a bot NO la
    // borramos: queda el registro de cuándo se atendió por última vez.
    await this.db
      .update(waConversaciones)
      .set(
        modo === "humano"
          ? { modo, humanoEn: sql`COALESCE(${waConversaciones.humanoEn}, now())` }
          : { modo },
      )
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
    const filas = (await this.db.execute(sql`
      SELECT
        c.id,
        c.cliente_wa,
        c.modo,
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
        ) AS tuvo_cita
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
      WHERE c.tenant_id = ${tenantId}
      ORDER BY ultima_actividad DESC
    `)) as unknown as Array<{
      id: string;
      cliente_wa: string;
      modo: string;
      sin_leer: number | string;
      ultimo_mensaje: string | null;
      ultimo_rol: string | null;
      ultima_actividad: Date | string;
      servicio_id: string | null;
      tiene_cita: boolean;
      cita_confirmada: boolean;
      tuvo_cita: boolean;
    }>;

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
        ultimoMensaje: r.ultimo_mensaje ?? null,
        ultimaActividadEn: ultimaActividad.toISOString(),
        sinLeer: Number(r.sin_leer),
        leadScore,
        servicio: r.servicio_id ?? null,
        tieneCita: r.tiene_cita,
        citaConfirmada: r.cita_confirmada,
      };
    });
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
    const msgs = msgsDesc.reverse();

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

    return {
      id: conv.id,
      tenantId: conv.tenantId,
      clienteWa: conv.clienteWa,
      optInEn: conv.optInEn ? conv.optInEn.toISOString() : null,
      modo: conv.modo as ModoConversacion,
      mensajes: msgs.map((m) => ({
        rol: m.rol as "user" | "assistant",
        contenido: m.contenido,
        creadoEn: m.creadoEn.toISOString(),
        porHumano: m.porHumano,
        mediaUrl: m.mediaUrl ?? undefined,
        mediaTipo: (m.mediaTipo as "imagen" | undefined) ?? undefined,
      })),
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
    const [aggResult, citas, periodoResult] = await Promise.all([
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
    ]);

    const agg = aggResult[0];
    const periodo = periodoResult[0];
    const base = calcularMetricas(Number(agg.total), Number(agg.humano), Number(agg.sin_escalar), citas);

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

    return { ...base, ...(hayDeltas ? { deltas } : {}) };
  }

  // ── Notificaciones push ──
  async guardarPushSub(tenantId: string, sub: PushSub): Promise<void> {
    await this.db
      .insert(waPushSubs)
      .values({ tenantId, endpoint: sub.endpoint, p256dh: sub.p256dh, auth: sub.auth })
      .onConflictDoNothing();
  }

  async listarPushSubs(tenantId: string): Promise<PushSub[]> {
    const rows = await this.db.select().from(waPushSubs).where(eq(waPushSubs.tenantId, tenantId));
    return rows.map((r) => ({ endpoint: r.endpoint, p256dh: r.p256dh, auth: r.auth }));
  }

  async borrarPushSub(endpoint: string): Promise<void> {
    await this.db.delete(waPushSubs).where(eq(waPushSubs.endpoint, endpoint));
  }
}
