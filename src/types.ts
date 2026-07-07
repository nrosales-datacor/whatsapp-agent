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
  /**
   * Nota de precio a mostrar en lugar de "se cotiza" cuando el precio depende del
   * vehículo pero SÍ está tabulado (ej: "según vehículo, ver tabla de parabrisas").
   */
  precioNota?: string;
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
  /** Tabla de precios de servicios de parabrisas (pulido / repelente / sellado). Una línea c/u. */
  parabrisas?: string[];
}

/** Un negocio conectado al agente. */
export interface Tenant {
  id: string;
  nombre: string;
  /** phone_number_id de WhatsApp Cloud API. Así ruteamos el mensaje entrante. */
  phoneNumberId: string;
  /** Token del WABA del cliente. Si no se da, cae al de .env (número de prueba). */
  accessToken?: string;
  /**
   * @deprecated La contraseña del panel ya no vive en el tenant: está en la tabla
   * `wa_usuarios` (resuelta por src/config/tenantStore.ts). Se mantiene el campo por
   * compatibilidad del fallback hardcodeado; el código de login ya no lo lee.
   */
  panelPasswordHash?: string;
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

// ─────────────────────────────────────────────────────────────────────────────
// Mensajes interactivos de WhatsApp (botones y listas nativas). El agente decide
// mostrarlos (runAgent) y la capa de WhatsApp los envía (whatsapp/client.ts).
// La CONVENCIÓN del `id` de cada opción (p. ej. "slot|<fecha>|<hora>") vive en
// whatsapp/client.ts, que es quien la genera y la decodifica al llegar la respuesta.
// ─────────────────────────────────────────────────────────────────────────────
export interface OpcionInteractiva {
  /** id opaco que WhatsApp devuelve al tocar la opción (≤200 chars). Convención nuestra. */
  id: string;
  /** Texto visible. Botón ≤20 chars; fila de lista ≤24. */
  titulo: string;
  /** Descripción secundaria (solo listas, ≤72 chars). */
  descripcion?: string;
}

export interface MensajeInteractivo {
  tipo: "botones" | "lista";
  /** Texto principal del mensaje (el cuerpo sobre los botones/lista). */
  cuerpo: string;
  /** Solo listas: texto del botón que despliega la lista (≤20 chars). */
  textoBoton?: string;
  opciones: OpcionInteractiva[];
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
  /** Precio cotizado al agendar (colones). Para métricas de ingresos. */
  precio?: number;
  /** id del evento creado en Google Calendar (si la integración está configurada). */
  gcalEventId?: string;
  /** Cuándo se envió el recordatorio del día antes (ISO). null/undefined = pendiente. */
  recordatorioDiaAntesEn?: string | null;
  /** Cuándo se envió el recordatorio del mismo día (ISO). null/undefined = pendiente. */
  recordatorioMismoDiaEn?: string | null;
  /** Cuándo el cliente confirmó la cita tocando el botón del recordatorio (ISO). null = sin confirmar. */
  confirmadaEn?: string | null;
}

export type TipoRecordatorio = "dia_antes" | "mismo_dia";

/**
 * Payload serializable de un Pendiente para la cola durable (wa_jobs).
 * No incluye el `tenant`; el worker lo relee del tenantStore por phoneNumberId.
 * Los campos de `entrante` se inlinean para evitar dependencia circular con
 * whatsapp/client.ts (que importa Tenant desde este mismo módulo).
 */
export interface PendienteSerializado {
  clase: "texto" | "no-texto" | "audio" | "imagen";
  tenantId: string;
  entrante: {
    phoneNumberId: string;
    clienteWa: string;
    messageId?: string;
    esTexto: boolean;
    texto: string;
    /** id del media de audio en WhatsApp (solo cuando clase === "audio"). */
    audioId?: string;
    /** id del media de imagen en WhatsApp (solo cuando clase === "imagen"). Para cotizar con visión (C1.5). */
    imagenId?: string;
    /** leyenda opcional que el cliente escribió junto a la foto. */
    imagenCaption?: string;
    /** id crudo de la respuesta interactiva (botón/lista); habilita acciones directas (C1.3). */
    interactiveId?: string;
  };
  conv: Conversacion;
  primerContacto?: boolean;
  historialPrevio?: MensajeConversacion[];
}

export interface MensajeConversacion {
  rol: "user" | "assistant";
  contenido: string;
  creadoEn: string; // ISO
  /** true => lo escribió un operador humano desde el panel (se guarda como "assistant"). */
  porHumano?: boolean;
  /** id del mensaje en WhatsApp (msg.id). Permite deduplicar reintentos de Meta. */
  waMessageId?: string;
  /** URL de datos ("data:image/...;base64,...") de una foto adjunta del cliente (C1.5). */
  mediaUrl?: string;
  /** Tipo de adjunto de `mediaUrl`. Omitido si el mensaje no tiene media. */
  mediaTipo?: "imagen";
}

/** Quién atiende la conversación: la IA ("bot") o un humano desde el panel ("humano"). */
export type ModoConversacion = "bot" | "humano";

export interface Conversacion {
  id: string;
  tenantId: string;
  clienteWa: string;
  optInEn: string | null;
  /** "bot" => responde la IA. "humano" => la IA se calla y atiende una persona. */
  modo: ModoConversacion;
  mensajes: MensajeConversacion[];
  /** Nombre del servicio de la cita activa más próxima (o null si no tiene). */
  servicio?: string | null;
  /** true si el cliente tiene al menos una cita agendada futura activa. */
  tieneCita?: boolean;
  /** true si esa cita activa más próxima está confirmada por el cliente (C1.3). */
  citaConfirmada?: boolean;
}

/** Fila liviana para la lista de la bandeja del panel (sin todo el historial). */
export interface ResumenConversacion {
  id: string;
  clienteWa: string;
  modo: ModoConversacion;
  ultimoMensaje: string | null;
  ultimaActividadEn: string | null; // ISO
  /** Mensajes del cliente sin "ver" por el operador (para el badge). */
  sinLeer: number;
  /**
   * Puntuación de prioridad del lead (0–100). Heurística tentativa — calibrar con el
   * negocio. Omitida si no hay suficientes datos; la UI oculta el tile cuando falta.
   */
  leadScore?: number;
  /** Nombre del servicio de la cita activa más próxima (o null si no tiene). */
  servicio?: string | null;
  /** true si el cliente tiene al menos una cita agendada futura activa. */
  tieneCita?: boolean;
  /** true si esa cita activa más próxima está confirmada por el cliente (C1.3). */
  citaConfirmada?: boolean;
}

/** Suscripción de notificaciones push de un navegador (Web Push). */
export interface PushSub {
  endpoint: string;
  p256dh: string;
  auth: string;
}

/** Métricas del negocio para el dashboard del panel. */
export interface Metricas {
  totalConversaciones: number;
  totalCitas: number;
  conversionPct: number;
  ingresosEstimados: number;
  enModoHumano: number;
  serviciosTop: { servicioId: string; nombre?: string; cantidad: number }[];
  citasPorDia: { fecha: string; cantidad: number }[];
  horasPico: { hora: string; cantidad: number }[];
  /**
   * Variación vs. los 7 días anteriores ("+12%", "-5%", "+∞").
   * Omitido si no hay período comparable (p. ej. repo en memoria).
   */
  deltas?: {
    conversaciones?: string;
    citas?: string;
    conversion?: string;
    ingresos?: string;
  };
}

/** Ficha (mini-CRM) de un cliente: datos agregados para el panel. */
export interface FichaCliente {
  clienteWa: string;
  nombre: string | null;
  placas: string[];
  totalCitas: number;
  ultimaVisita: string | null; // "YYYY-MM-DD" de la cita más reciente
  primerContacto: string | null; // ISO (creación de la conversación)
  notas: string;
  historial: { servicioId: string; fecha: string; hora: string; estado: string }[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Repositorio: abstrae la persistencia (impl en memoria o Prisma).
// ─────────────────────────────────────────────────────────────────────────────
export interface Repositorio {
  obtenerOConversacion(tenantId: string, clienteWa: string): Promise<Conversacion>;
  /**
   * Guarda un mensaje. Devuelve `true` si se almacenó y `false` si se descartó por
   * ser un duplicado (mismo waMessageId ya visto) — así el webhook es idempotente
   * ante los reintentos de Meta. Los mensajes salientes (sin waMessageId) siempre
   * devuelven `true`.
   */
  guardarMensaje(conversacionId: string, msg: MensajeConversacion): Promise<boolean>;
  marcarOptIn(conversacionId: string): Promise<void>;
  /**
   * Adjunta la URL de una foto a un mensaje YA guardado, identificado por su
   * waMessageId (C1.5). Fase 1 guarda un placeholder de texto rápido; fase 2
   * descarga la imagen de Meta y la completa acá para que se vea en el panel.
   */
  actualizarMediaMensaje(
    conversacionId: string,
    waMessageId: string,
    mediaUrl: string,
    mediaTipo: "imagen",
  ): Promise<void>;

  citasPorFecha(tenantId: string, fecha: string): Promise<Cita[]>;
  /**
   * Citas del tenant con fecha entre `desde` y `hasta` (inclusive), ordenadas por
   * fecha/hora ascendente. Base de la vista Agenda del panel (día/semana).
   */
  citasEnRango(tenantId: string, desde: string, hasta: string): Promise<Cita[]>;
  crearCita(cita: Omit<Cita, "id" | "creadaEn" | "estado">): Promise<Cita>;
  /** Guarda el id del evento de Google Calendar asociado a la cita. */
  guardarGcalEventId(citaId: string, eventId: string): Promise<void>;
  /**
   * Citas ACTIVAS (estado "agendada") futuras de un cliente, de `desdeFecha` en
   * adelante (inclusive), ordenadas por fecha/hora ascendente. `desdeFecha` es
   * "hoy" en la zona del tenant, calculada por el caller. Sirve para que el bot
   * identifique la cita a reprogramar/cancelar por el número del cliente.
   */
  citasActivasCliente(tenantId: string, clienteWa: string, desdeFecha: string): Promise<Cita[]>;
  /**
   * Reprograma una cita a nueva fecha/hora y REINICIA sus recordatorios (para que
   * salgan según el nuevo horario, no el viejo). Scopeada por tenantId (defensa en
   * profundidad). Devuelve la cita actualizada, o null si no existe / no es del tenant.
   */
  reprogramarCita(tenantId: string, citaId: string, fecha: string, hora: string): Promise<Cita | null>;
  /**
   * Cancela una cita (estado "cancelada"). Scopeada por tenantId. Devuelve la cita
   * (con su gcalEventId, para borrar el evento del Calendar), o null si no existe.
   */
  cancelarCita(tenantId: string, citaId: string): Promise<Cita | null>;
  /**
   * Marca una cita como confirmada por el cliente (anti no-show, C1.3). Idempotente:
   * conserva la primera confirmación si se repite. Devuelve la cita, o null si no
   * existe / no es del tenant / no está agendada.
   */
  confirmarCita(tenantId: string, citaId: string): Promise<Cita | null>;
  /**
   * Marca una cita como completada (servicio ya realizado), desde el panel.
   * Scopeada por tenantId. Solo aplica si estaba "agendada". Devuelve la cita, o
   * null si no existe / no es del tenant / no estaba agendada.
   */
  completarCita(tenantId: string, citaId: string): Promise<Cita | null>;
  /** Marca un recordatorio como enviado (para no mandarlo dos veces). */
  marcarRecordatorio(citaId: string, tipo: TipoRecordatorio): Promise<void>;
  /**
   * Intenta marcar el recordatorio como enviado atómicamente (compare-and-swap).
   * Devuelve `true` si esta instancia ganó el claim (la columna estaba NULL y se
   * seteó); `false` si ya fue reclamado por otra instancia.
   * Pooler-safe: es un UPDATE de una sola fila, sin advisory locks de sesión.
   */
  reclamarRecordatorio(citaId: string, tipo: TipoRecordatorio): Promise<boolean>;
  /**
   * Revierte el claim (columna a NULL) cuando el envío falló, para que el próximo
   * tick pueda reintentarlo.
   */
  revertirRecordatorio(citaId: string, tipo: TipoRecordatorio): Promise<void>;
  /**
   * Transaccional (con DB): guarda el mensaje entrante Y encola el job de respuesta en
   * `wa_jobs` en una sola transacción → "mensaje persistido ⇒ job encolado" es
   * invariante. Devuelve `true` si el mensaje era nuevo (se encoló); `false` si era
   * duplicado (mismo waMessageId). Sin DB (repo en memoria), solo guarda el mensaje.
   */
  guardarEntranteYEncolar(
    conversacionId: string,
    msg: MensajeConversacion,
    payload: PendienteSerializado,
  ): Promise<boolean>;

  registrarCalidad(evento: {
    tenantId: string;
    clienteWa: string;
    tipo: "mensaje_ok" | "fuera_de_alcance" | "error";
    detalle?: string;
  }): Promise<void>;

  // ── Panel / bandeja humana ──
  // Las mutaciones reciben tenantId y lo aplican en el WHERE: la frontera entre
  // negocios la hace la capa de datos, no solo el router (defensa en profundidad).
  /** Cambia quién atiende la conversación (bot ↔ humano). */
  setModoConversacion(tenantId: string, conversacionId: string, modo: ModoConversacion): Promise<void>;
  /** Lista las conversaciones del negocio para la bandeja (más reciente primero). */
  listarConversaciones(tenantId: string): Promise<ResumenConversacion[]>;
  /** Trae una conversación con su historial por id (null si no existe o no es del tenant). */
  obtenerConversacionPorId(tenantId: string, conversacionId: string): Promise<Conversacion | null>;
  /** Lee SOLO el modo actual (lectura liviana, p. ej. para revalidar antes de que el bot responda). */
  obtenerModo(tenantId: string, conversacionId: string): Promise<ModoConversacion | null>;
  /** Marca como leídos los mensajes del cliente hasta ahora (resetea el badge). */
  marcarLeidas(tenantId: string, conversacionId: string): Promise<void>;
  /** Datos agregados de un cliente (citas, vehículos, visitas, notas) para la ficha. */
  fichaCliente(tenantId: string, clienteWa: string): Promise<FichaCliente | null>;
  /** Guarda las notas privadas del negocio sobre un cliente. */
  guardarNotas(tenantId: string, conversacionId: string, notas: string): Promise<void>;
  /** Métricas agregadas del negocio para el dashboard. */
  metricas(tenantId: string): Promise<Metricas>;

  // ── Notificaciones push (Web Push) ──
  guardarPushSub(tenantId: string, sub: PushSub): Promise<void>;
  listarPushSubs(tenantId: string): Promise<PushSub[]>;
  borrarPushSub(endpoint: string): Promise<void>;
}
