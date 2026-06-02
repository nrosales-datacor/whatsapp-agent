import type { Cita, Conversacion, MensajeConversacion, Repositorio } from "../types";

// ─────────────────────────────────────────────────────────────────────────────
// Repositorio EN MEMORIA. Sirve para probar el agente YA, sin base de datos.
// Los datos se pierden al reiniciar el proceso. NO usar en producción.
// En el monorepo se reemplaza por la impl Prisma (mismos métodos).
// ─────────────────────────────────────────────────────────────────────────────

export class RepositorioEnMemoria implements Repositorio {
  private conversaciones = new Map<string, Conversacion>();
  private citas: Cita[] = [];

  private clave(tenantId: string, clienteWa: string) {
    return `${tenantId}:${clienteWa}`;
  }

  async obtenerOConversacion(tenantId: string, clienteWa: string): Promise<Conversacion> {
    const k = this.clave(tenantId, clienteWa);
    let c = this.conversaciones.get(k);
    if (!c) {
      c = { id: k, tenantId, clienteWa, optInEn: null, mensajes: [] };
      this.conversaciones.set(k, c);
    }
    return c;
  }

  async guardarMensaje(conversacionId: string, msg: MensajeConversacion): Promise<void> {
    const c = this.conversaciones.get(conversacionId);
    if (c) {
      c.mensajes.push(msg);
      // Mantener el historial acotado (últimos 20) para no inflar tokens.
      if (c.mensajes.length > 20) c.mensajes = c.mensajes.slice(-20);
    }
  }

  async marcarOptIn(conversacionId: string): Promise<void> {
    const c = this.conversaciones.get(conversacionId);
    if (c && !c.optInEn) c.optInEn = new Date().toISOString();
  }

  async citasPorFecha(tenantId: string, fecha: string): Promise<Cita[]> {
    return this.citas.filter((c) => c.tenantId === tenantId && c.fecha === fecha);
  }

  async crearCita(cita: Omit<Cita, "id" | "creadaEn" | "estado">): Promise<Cita> {
    const nueva: Cita = {
      ...cita,
      id: `cita_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      estado: "agendada",
      creadaEn: new Date().toISOString(),
    };
    this.citas.push(nueva);
    return nueva;
  }

  async registrarCalidad(evento: {
    tenantId: string;
    clienteWa: string;
    tipo: "mensaje_ok" | "fuera_de_alcance" | "error";
    detalle?: string;
  }): Promise<void> {
    // En memoria solo lo mostramos por consola. En prod se guarda en tabla.
    console.log("[calidad]", JSON.stringify(evento));
  }
}
