import { and, asc, eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { schema, waCitas, waConversaciones, waEventosCalidad, waMensajes } from "../db/schema";
import type { Cita, Conversacion, MensajeConversacion, Repositorio, TipoRecordatorio } from "../types";

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

    const msgs = await this.db
      .select()
      .from(waMensajes)
      .where(eq(waMensajes.conversacionId, conv.id))
      .orderBy(asc(waMensajes.creadoEn))
      .limit(20);

    return {
      id: conv.id,
      tenantId: conv.tenantId,
      clienteWa: conv.clienteWa,
      optInEn: conv.optInEn ? conv.optInEn.toISOString() : null,
      mensajes: msgs.map((m) => ({
        rol: m.rol as "user" | "assistant",
        contenido: m.contenido,
        creadoEn: m.creadoEn.toISOString(),
      })),
    };
  }

  async guardarMensaje(conversacionId: string, msg: MensajeConversacion): Promise<void> {
    await this.db.insert(waMensajes).values({
      conversacionId,
      rol: msg.rol,
      contenido: msg.contenido,
    });
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
}
