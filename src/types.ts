// ─────────────────────────────────────────────────────────────────────────────
// Tipos del dominio del agente de WhatsApp.
// Pensados para multi-tenant: un solo código atiende muchos negocios.
// ─────────────────────────────────────────────────────────────────────────────

/** Un servicio que ofrece el negocio. */
export interface Service {
  id: string;
  nombre: string;
  /** Precio en la moneda del tenant. Omitir si se cotiza por vehículo. */
  precio?: number;
  /** true => el precio se cotiza por vehículo (se muestra "se cotiza"). */
  precioVariable?: boolean;
  /** Duración estimada en minutos. Se usa para los espacios de agenda. */
  duracionMin: number;
  /** true => requiere cita (ej: pulidos). false/omitido => por orden de llegada. */
  agendable?: boolean;
  descripcion?: string;
}

/** Horario de atención por día de la semana (0 = domingo … 6 = sábado). */
export interface HorarioDia {
  abre: string | null; // "06:00" (null = cerrado ese día)
  cierra: string | null; // "18:00"
}

/** Base de conocimiento del negocio. SIN RAG todavía: va directo al prompt. */
export interface KnowledgeBase {
  faq: { pregunta: string; respuesta: string }[];
  datos: string[];
  politicas: string[];
  /** Tabla de precios de servicios por orden de llegada (sin cita). Una línea c/u. */
  tarifas?: string[];
}

/** Un negocio conectado al agente. */
export interface Tenant {
  id: string;
  nombre: string;
  /** phone_number_id de WhatsApp Cloud API. Así ruteamos el mensaje entrante. */
  phoneNumberId: string;
  /** Token del WABA del cliente. Si no se da, cae al de .env (número de prueba). */
  accessToken?: string;
  timezone: string;
  moneda: string;
  ubicacion: string;
  /** Indexado 0..6 (domingo..sábado). */
  horario: Record<number, HorarioDia>;
  /** Intervalo entre espacios de agenda, en minutos (aplica a servicios agendables). */
  intervaloAgendaMin: number;
  servicios: Service[];
  kb: KnowledgeBase;
}

export type EstadoCita = "agendada" | "cancelada" | "completada";

export interface Cita {
  id: string;
  tenantId: string;
  /** Número del cliente en formato E.164 sin "+", ej "50688887777". */
  clienteWa: string;
  clienteNombre: string;
  servicioId: string;
  fecha: string; // "YYYY-MM-DD"
  hora: string; // "HH:mm"
  placa?: string;
  estado: EstadoCita;
  creadaEn: string; // ISO
}

export interface MensajeConversacion {
  rol: "user" | "assistant";
  contenido: string;
  creadoEn: string; // ISO
}

export interface Conversacion {
  id: string;
  tenantId: string;
  clienteWa: string;
  optInEn: string | null;
  mensajes: MensajeConversacion[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Repositorio: abstrae la persistencia (impl en memoria o Prisma).
// ─────────────────────────────────────────────────────────────────────────────
export interface Repositorio {
  obtenerOConversacion(tenantId: string, clienteWa: string): Promise<Conversacion>;
  guardarMensaje(conversacionId: string, msg: MensajeConversacion): Promise<void>;
  marcarOptIn(conversacionId: string): Promise<void>;

  citasPorFecha(tenantId: string, fecha: string): Promise<Cita[]>;
  crearCita(cita: Omit<Cita, "id" | "creadaEn" | "estado">): Promise<Cita>;

  registrarCalidad(evento: {
    tenantId: string;
    clienteWa: string;
    tipo: "mensaje_ok" | "fuera_de_alcance" | "error";
    detalle?: string;
  }): Promise<void>;
}
