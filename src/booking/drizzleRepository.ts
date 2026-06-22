import { and, desc, eq, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { schema, waCitas, waConversaciones, waEventosCalidad, waMensajes, waPushSubs } from "../db/schema";
import type {
  Cita,
  Conversacion,
  FichaCliente,
  MensajeConversacion,
  Metricas,
  ModoConversacion,
  PushSub,
  Repositorio,
  ResumenConversacion,
  TipoRecordatorio,
} from "../types";
import { calcularMetricas } from "../panel/metricas";

// ─────────────────────────────────────────────────────────────────────────────
// Repositorio Drizzle. Implementa la MISMA interfaz que el de memoria.
// Recibe el cliente drizzle ya creado por tu monorepo (no crea uno nuevo).
//
// En el monorepo, importá las tablas desde "@gp/db/schema" en lugar de "../db/schema".
// ─────────────────────────────────────────────────────────────────────────────

type DB = PostgresJsDatabase<typeof schema>;

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
      })
      .onConflictDoNothing()
      .returning({ id: waMensajes.id });
    return filas.length > 0;
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

    return rows.map((r) => ({
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
      gcalEventId: r.gcalEventId ?? undefined,
      recordatorioDiaAntesEn: r.recordatorioDiaAntesEn ? r.recordatorioDiaAntesEn.toISOString() : null,
      recordatorioMismoDiaEn: r.recordatorioMismoDiaEn ? r.recordatorioMismoDiaEn.toISOString() : null,
    }));
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

  async marcarRecordatorio(citaId: string, tipo: TipoRecordatorio): Promise<void> {
    const cambio =
      tipo === "dia_antes"
        ? { recordatorioDiaAntesEn: new Date() }
        : { recordatorioMismoDiaEn: new Date() };
    await this.db.update(waCitas).set(cambio).where(eq(waCitas.id, citaId));
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
    const filas = (await this.db.execute(sql`
      SELECT
        c.id,
        c.cliente_wa,
        c.modo,
        c.creada_en,
        m.contenido AS ultimo_mensaje,
        COALESCE(m.creado_en, c.creada_en) AS ultima_actividad,
        CASE WHEN c.modo = 'humano' THEN (
          SELECT count(*) FROM wa_mensajes um
          WHERE um.conversacion_id = c.id AND um.rol = 'user'
            AND (c.leido_hasta IS NULL OR um.creado_en > c.leido_hasta)
        ) ELSE 0 END AS sin_leer
      FROM wa_conversaciones c
      LEFT JOIN LATERAL (
        SELECT contenido, creado_en
        FROM wa_mensajes
        WHERE conversacion_id = c.id
        ORDER BY creado_en DESC
        LIMIT 1
      ) m ON true
      WHERE c.tenant_id = ${tenantId}
      ORDER BY ultima_actividad DESC
    `)) as unknown as Array<{
      id: string;
      cliente_wa: string;
      modo: string;
      sin_leer: number | string;
      ultimo_mensaje: string | null;
      ultima_actividad: Date | string;
    }>;

    return filas.map((r) => ({
      id: r.id,
      clienteWa: r.cliente_wa,
      modo: r.modo as ModoConversacion,
      ultimoMensaje: r.ultimo_mensaje ?? null,
      ultimaActividadEn: new Date(r.ultima_actividad).toISOString(),
      sinLeer: Number(r.sin_leer),
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
    const msgs = msgsDesc.reverse();

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
      })),
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
    // Contamos las conversaciones en SQL en vez de traer todas las filas: la tabla
    // crece con cada chat y el dashboard no necesita el detalle, solo los totales.
    const [agg] = (await this.db.execute(sql`
      SELECT count(*) AS total, count(*) FILTER (WHERE modo = 'humano') AS humano
      FROM wa_conversaciones WHERE tenant_id = ${tenantId}
    `)) as unknown as Array<{ total: number | string; humano: number | string }>;
    const citas = await this.db
      .select({
        estado: waCitas.estado,
        precio: waCitas.precio,
        servicioId: waCitas.servicioId,
        fecha: waCitas.fecha,
        hora: waCitas.hora,
      })
      .from(waCitas)
      .where(eq(waCitas.tenantId, tenantId));
    return calcularMetricas(Number(agg.total), Number(agg.humano), citas);
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
