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
import { calcularMetricas } from "../panel/metricas";

// ─────────────────────────────────────────────────────────────────────────────
// Repositorio EN MEMORIA. Sirve para probar el agente YA, sin base de datos.
// Los datos se pierden al reiniciar el proceso. NO usar en producción.
// En el monorepo se reemplaza por la impl Prisma (mismos métodos).
// ─────────────────────────────────────────────────────────────────────────────

// Estado interno de una conversación en memoria. Incluye campos que NO se exponen
// en el DTO Conversacion (notas, marcas de tiempo) — por eso se proyecta con dto().
type ConvInterna = Conversacion & {
  notas: string;
  creadaEn: string; // ISO, para primerContacto (no deriva del primer mensaje, que se trunca)
  leidoHasta: string | null;
  humanoEn: string | null;
};

const TOPE_MENSAJES = 200; // historial que se guarda por conversación (la vista del panel usa los últimos 100)
const MAX_WA_IDS = 5000; // tope del set de dedup de waMessageId (evita crecimiento sin límite)

export class RepositorioEnMemoria implements Repositorio {
  private conversaciones = new Map<string, ConvInterna>();
  private citas: Cita[] = [];
  private pushSubs = new Map<string, PushSub & { tenantId: string }>();
  // ids de mensajes de WhatsApp ya vistos, para deduplicar reintentos de Meta.
  private waIdsVistos = new Set<string>();

  private clave(tenantId: string, clienteWa: string) {
    return `${tenantId}:${clienteWa}`;
  }

  /** Proyecta el estado interno al DTO público (copia los mensajes; no filtra notas). */
  private dto(c: ConvInterna, limite: number): Conversacion {
    return {
      id: c.id,
      tenantId: c.tenantId,
      clienteWa: c.clienteWa,
      optInEn: c.optInEn,
      modo: c.modo,
      // porHumano normalizado a boolean (paridad con Drizzle, que nunca es undefined).
      mensajes: c.mensajes.slice(-limite).map((m) => ({ ...m, porHumano: m.porHumano ?? false })),
    };
  }

  async obtenerOConversacion(tenantId: string, clienteWa: string): Promise<Conversacion> {
    const k = this.clave(tenantId, clienteWa);
    let c = this.conversaciones.get(k);
    if (!c) {
      c = {
        id: k,
        tenantId,
        clienteWa,
        optInEn: null,
        modo: "bot",
        mensajes: [],
        notas: "",
        creadaEn: new Date().toISOString(),
        leidoHasta: null,
        humanoEn: null,
      };
      this.conversaciones.set(k, c);
    }
    // Devolvemos una COPIA (últimos 20) — nunca el objeto vivo del Map, para que
    // mutar el resultado no corrompa el estado interno ni filtre campos privados.
    return this.dto(c, 20);
  }

  async guardarMensaje(conversacionId: string, msg: MensajeConversacion): Promise<boolean> {
    const c = this.conversaciones.get(conversacionId);
    if (!c) return false;
    // Idempotencia: si ya vimos este waMessageId (reintento de Meta), lo ignoramos.
    if (msg.waMessageId) {
      if (this.waIdsVistos.has(msg.waMessageId)) return false;
      this.waIdsVistos.add(msg.waMessageId);
      // Acotar el set para que no crezca sin límite (evicta el más viejo; el Set
      // mantiene orden de inserción). Los reintentos de Meta son inmediatos.
      if (this.waIdsVistos.size > MAX_WA_IDS) {
        const masViejo = this.waIdsVistos.values().next().value;
        if (masViejo !== undefined) this.waIdsVistos.delete(masViejo);
      }
    }
    c.mensajes.push({ ...msg });
    if (c.mensajes.length > TOPE_MENSAJES) c.mensajes = c.mensajes.slice(-TOPE_MENSAJES);
    return true;
  }

  async actualizarMediaMensaje(
    conversacionId: string,
    waMessageId: string,
    mediaUrl: string,
    mediaTipo: "imagen",
  ): Promise<void> {
    const c = this.conversaciones.get(conversacionId);
    if (!c) return;
    const msg = c.mensajes.find((m) => m.waMessageId === waMessageId);
    if (msg) {
      msg.mediaUrl = mediaUrl;
      msg.mediaTipo = mediaTipo;
    }
  }

  async marcarOptIn(conversacionId: string): Promise<void> {
    const c = this.conversaciones.get(conversacionId);
    if (c && !c.optInEn) c.optInEn = new Date().toISOString();
  }

  async citasPorFecha(tenantId: string, fecha: string): Promise<Cita[]> {
    return this.citas.filter((c) => c.tenantId === tenantId && c.fecha === fecha);
  }

  async citasEnRango(tenantId: string, desde: string, hasta: string): Promise<Cita[]> {
    return this.citas
      .filter((c) => c.tenantId === tenantId && c.fecha >= desde && c.fecha <= hasta)
      .sort((a, b) => (a.fecha + a.hora).localeCompare(b.fecha + b.hora));
  }

  async crearCita(cita: Omit<Cita, "id" | "creadaEn" | "estado">): Promise<Cita> {
    const nueva: Cita = {
      ...cita,
      origen: cita.origen ?? "bot",
      id: `cita_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      estado: "agendada",
      creadaEn: new Date().toISOString(),
    };
    this.citas.push(nueva);
    return nueva;
  }

  async guardarGcalEventId(citaId: string, eventId: string): Promise<void> {
    const c = this.citas.find((x) => x.id === citaId);
    if (c) c.gcalEventId = eventId;
  }

  async citasActivasCliente(tenantId: string, clienteWa: string, desdeFecha: string): Promise<Cita[]> {
    return this.citas
      .filter(
        (c) =>
          c.tenantId === tenantId &&
          c.clienteWa === clienteWa &&
          c.estado === "agendada" &&
          c.fecha >= desdeFecha,
      )
      .sort((a, b) => (a.fecha + a.hora).localeCompare(b.fecha + b.hora));
  }

  async reprogramarCita(tenantId: string, citaId: string, fecha: string, hora: string): Promise<Cita | null> {
    const c = this.citas.find((x) => x.id === citaId && x.tenantId === tenantId);
    if (!c) return null;
    c.fecha = fecha;
    c.hora = hora;
    // Reinicia recordatorios: deben salir según el nuevo horario, no el viejo.
    c.recordatorioDiaAntesEn = null;
    c.recordatorioMismoDiaEn = null;
    return { ...c };
  }

  async cancelarCita(tenantId: string, citaId: string): Promise<Cita | null> {
    const c = this.citas.find((x) => x.id === citaId && x.tenantId === tenantId);
    if (!c) return null;
    c.estado = "cancelada";
    return { ...c };
  }

  async confirmarCita(tenantId: string, citaId: string): Promise<Cita | null> {
    const c = this.citas.find((x) => x.id === citaId && x.tenantId === tenantId && x.estado === "agendada");
    if (!c) return null;
    if (!c.confirmadaEn) c.confirmadaEn = new Date().toISOString(); // idempotente: conserva la primera
    return { ...c };
  }

  async completarCita(tenantId: string, citaId: string): Promise<Cita | null> {
    const c = this.citas.find((x) => x.id === citaId && x.tenantId === tenantId && x.estado === "agendada");
    if (!c) return null;
    c.estado = "completada";
    return { ...c };
  }

  async marcarNoShow(tenantId: string, citaId: string): Promise<Cita | null> {
    const c = this.citas.find((x) => x.id === citaId && x.tenantId === tenantId && x.estado === "agendada");
    if (!c) return null;
    c.estado = "no_show";
    return { ...c };
  }

  async marcarRecordatorio(citaId: string, tipo: TipoRecordatorio): Promise<void> {
    const c = this.citas.find((x) => x.id === citaId);
    if (!c) return;
    const ahora = new Date().toISOString();
    if (tipo === "dia_antes") c.recordatorioDiaAntesEn = ahora;
    else c.recordatorioMismoDiaEn = ahora;
  }

  async reclamarRecordatorio(citaId: string, tipo: TipoRecordatorio): Promise<boolean> {
    const c = this.citas.find((x) => x.id === citaId);
    if (!c) return false;
    if (tipo === "dia_antes") {
      if (c.recordatorioDiaAntesEn) return false;
      c.recordatorioDiaAntesEn = new Date().toISOString();
    } else {
      if (c.recordatorioMismoDiaEn) return false;
      c.recordatorioMismoDiaEn = new Date().toISOString();
    }
    return true;
  }

  async revertirRecordatorio(citaId: string, tipo: TipoRecordatorio): Promise<void> {
    const c = this.citas.find((x) => x.id === citaId);
    if (!c) return;
    if (tipo === "dia_antes") c.recordatorioDiaAntesEn = null;
    else c.recordatorioMismoDiaEn = null;
  }

  async guardarEntranteYEncolar(
    conversacionId: string,
    msg: MensajeConversacion,
    _payload: PendienteSerializado,
  ): Promise<boolean> {
    // Sin base de datos no hay cola: solo guardamos el mensaje (comportamiento de dev).
    return this.guardarMensaje(conversacionId, msg);
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

  // ── Panel / bandeja humana ──
  async setModoConversacion(tenantId: string, conversacionId: string, modo: ModoConversacion): Promise<void> {
    const c = this.conversaciones.get(conversacionId);
    if (!c || c.tenantId !== tenantId) return;
    c.modo = modo;
    // Marca el primer traspaso a humano y NO la borra al volver a bot (paridad con Drizzle).
    if (modo === "humano" && !c.humanoEn) c.humanoEn = new Date().toISOString();
  }

  async listarConversaciones(tenantId: string): Promise<ResumenConversacion[]> {
    const hoy = new Date().toISOString().slice(0, 10); // "YYYY-MM-DD"
    const hace24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    return [...this.conversaciones.values()]
      .filter((c) => c.tenantId === tenantId)
      .map((c) => {
        const ult = c.mensajes[c.mensajes.length - 1];
        // sin_leer se calcula (no hay contador): mensajes del cliente posteriores a
        // leidoHasta, y solo en modo humano. Misma semántica que el repo Drizzle.
        const sinLeer =
          c.modo === "humano"
            ? c.mensajes.filter((m) => m.rol === "user" && (!c.leidoHasta || m.creadoEn > c.leidoHasta)).length
            : 0;

        const ultimaActividadEn = ult ? ult.creadoEn : c.creadaEn;
        const citasCliente = this.citas.filter(
          (ct) => ct.tenantId === tenantId && ct.clienteWa === c.clienteWa,
        );
        const citaActiva = citasCliente.find((ct) => ct.estado === "agendada" && ct.fecha >= hoy);

        // Heurística tentativa de lead score (misma que el repo Drizzle).
        let leadScore = 40;
        if (citasCliente.length > 0) leadScore += 25;
        if (ult?.rol === "user") leadScore += 15;
        if (ultimaActividadEn >= hace24h) leadScore += 10;
        if (citaActiva) leadScore += 10;
        leadScore = Math.min(100, Math.max(0, leadScore));

        return {
          id: c.id,
          clienteWa: c.clienteWa,
          modo: c.modo,
          ultimoMensaje: ult ? ult.contenido : null,
          ultimaActividadEn,
          sinLeer,
          leadScore,
          servicio: citaActiva?.servicioId ?? null,
          tieneCita: !!citaActiva,
          citaConfirmada: !!citaActiva?.confirmadaEn,
        };
      })
      .sort((a, b) => (b.ultimaActividadEn ?? "").localeCompare(a.ultimaActividadEn ?? ""));
  }

  async obtenerConversacionPorId(tenantId: string, conversacionId: string): Promise<Conversacion | null> {
    const c = this.conversaciones.get(conversacionId);
    if (!c || c.tenantId !== tenantId) return null;
    const hoy = new Date().toISOString().slice(0, 10);
    const citaActiva = this.citas.find(
      (ct) => ct.tenantId === tenantId && ct.clienteWa === c.clienteWa && ct.estado === "agendada" && ct.fecha >= hoy,
    );
    const base = this.dto(c, 100);
    return {
      ...base,
      servicio: citaActiva?.servicioId ?? null,
      tieneCita: !!citaActiva,
      citaConfirmada: !!citaActiva?.confirmadaEn,
    };
  }

  async obtenerModo(tenantId: string, conversacionId: string): Promise<ModoConversacion | null> {
    const c = this.conversaciones.get(conversacionId);
    return c && c.tenantId === tenantId ? c.modo : null;
  }

  async marcarLeidas(tenantId: string, conversacionId: string): Promise<void> {
    const c = this.conversaciones.get(conversacionId);
    if (c && c.tenantId === tenantId) c.leidoHasta = new Date().toISOString();
  }

  async fichaCliente(tenantId: string, clienteWa: string): Promise<FichaCliente | null> {
    const conv = this.conversaciones.get(this.clave(tenantId, clienteWa));
    const citas = this.citas
      .filter((c) => c.tenantId === tenantId && c.clienteWa === clienteWa)
      .sort((a, b) => b.fecha.localeCompare(a.fecha));
    if (!conv && citas.length === 0) return null;
    const placas = [...new Set(citas.map((c) => c.placa).filter((p): p is string => !!p))];
    return {
      clienteWa,
      nombre: citas.find((c) => c.clienteNombre)?.clienteNombre ?? null,
      placas,
      totalCitas: citas.length,
      ultimaVisita: citas[0]?.fecha ?? null,
      primerContacto: conv?.creadaEn ?? null,
      notas: conv?.notas ?? "",
      historial: citas.map((c) => ({ servicioId: c.servicioId, fecha: c.fecha, hora: c.hora, estado: c.estado })),
    };
  }

  async guardarNotas(tenantId: string, conversacionId: string, notas: string): Promise<void> {
    const c = this.conversaciones.get(conversacionId);
    if (c && c.tenantId === tenantId) c.notas = notas;
  }

  async metricas(tenantId: string): Promise<Metricas> {
    const convs = [...this.conversaciones.values()].filter((c) => c.tenantId === tenantId);
    const citas = this.citas.filter((c) => c.tenantId === tenantId);
    const sinEscalar = convs.filter((c) => !c.humanoEn).length;
    return calcularMetricas(convs.length, convs.filter((c) => c.modo === "humano").length, sinEscalar, citas);
  }

  // ── Notificaciones push ──
  async guardarPushSub(tenantId: string, sub: PushSub): Promise<void> {
    this.pushSubs.set(sub.endpoint, { ...sub, tenantId });
  }

  async listarPushSubs(tenantId: string): Promise<PushSub[]> {
    return [...this.pushSubs.values()]
      .filter((s) => s.tenantId === tenantId)
      .map(({ endpoint, p256dh, auth }) => ({ endpoint, p256dh, auth }));
  }

  async borrarPushSub(endpoint: string): Promise<void> {
    this.pushSubs.delete(endpoint);
  }
}
