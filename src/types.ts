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
  /**
   * Upsell inteligente al agendar (Carril D, 1.2): id de OTRO servicio a ofrecer como
   * add-on cuando se agenda ESTE. undefined = no sugiere nada.
   */
  addonSugeridoId?: string;
  /** Precio ancla del add-on ("en vez de X") al ofrecerlo. undefined = sin precio promo. */
  addonPrecioPromo?: number;
  /** true => el upsell de este servicio está activo. false/omitido => no se ofrece. */
  addonActivo?: boolean;
}

/** Add-on aceptado y agregado a una cita (Carril D, 1.2). */
export interface AddonCita {
  /** id del servicio ofrecido como add-on (Service.addonSugeridoId del servicio base). */
  servicioId: string;
  /** Precio al que se aceptó (el ancla `addonPrecioPromo` configurado en ese momento). */
  precio: number;
}

/** Un add-on rechazado por el cliente, para no volver a ofrecérselo pronto (Carril D, 1.2). */
export interface RechazoAddon {
  addonId: string;
  fecha: string; // "YYYY-MM-DD"
}

/** Horario de atención por día de la semana (0 = domingo … 6 = sábado). */
export interface HorarioDia {
  abre: string | null; // "06:00" (null = cerrado ese día)
  cierra: string | null; // "18:00"
}

/**
 * Sección de conocimiento nombrada por el dueño (multi-mercado): reemplaza a los
 * campos fijos `tarifas`/`parabrisas` que eran de lavacar. El dueño la titula como
 * quiera ("Precios", "Menú", "Tratamientos"…) y llena sus ítems, uno por línea.
 */
export interface SeccionConocimiento {
  /** Slug estable derivado del título; sirve de key en el prompt/UI. */
  id: string;
  /** Nombre visible que elige el dueño. */
  titulo: string;
  /** Ítems de la sección, uno por línea. */
  items: string[];
}

/** Base de conocimiento del negocio. SIN RAG todavía: va directo al prompt. */
export interface KnowledgeBase {
  faq: { pregunta: string; respuesta: string }[];
  /** Información general del negocio (universal a cualquier rubro). Una línea c/u. */
  datos: string[];
  /** Políticas del negocio (universal a cualquier rubro). Una línea c/u. */
  politicas: string[];
  /**
   * Secciones libres nombradas por el dueño (multi-mercado). Se inyectan al prompt
   * bajo su título. Reemplaza a los antiguos `tarifas`/`parabrisas`.
   */
  secciones?: SeccionConocimiento[];
  /** @deprecated Migrado a `secciones` al leer (ver normalizarKb); ya no se escribe. */
  tarifas?: string[];
  /** @deprecated Migrado a `secciones` al leer (ver normalizarKb); ya no se escribe. */
  parabrisas?: string[];
}

/** Rango de fechas cerrado (feriado, vacaciones, etc.), ambos extremos inclusive. */
export interface Bloqueo {
  desde: string; // "YYYY-MM-DD"
  hasta: string; // "YYYY-MM-DD"
  motivo?: string;
}

/**
 * Quién atiende una cita: un empleado, una bahía, un sillón, un consultorio. La agenda
 * nació con UN solo recurso implícito (cualquier solape bloqueaba el horario), así que
 * un negocio con 2+ personas atendiendo perdía la mitad de su capacidad — hallazgo
 * ALTO-07 de `AUDIT.md`.
 *
 * Vive como arreglo JSONB en `wa_tenants` y se referencia por slug desde
 * `wa_citas.empleado_id`, exactamente igual que `servicios`/`servicio_id`: son la misma
 * clase de cosa (lista chica, read-mostly, sin FK). Así llega gratis al agente por el
 * caché del tenantStore, sin una query extra por turno.
 *
 * ⚠️ El id es INMUTABLE una vez que hay citas apuntándole. Por eso el panel desactiva
 * en vez de borrar (`activo: false` conserva el histórico y su nombre); el borrado duro
 * solo se permite cuando el empleado no tiene ninguna cita.
 */
export interface Empleado {
  /** Slug estable derivado del nombre. Inmutable: `wa_citas.empleado_id` lo referencia. */
  id: string;
  nombre: string;
  /** false = no recibe citas nuevas ni se le ofrece al cliente, pero su histórico se conserva. */
  activo: boolean;
  /**
   * Servicios que sabe hacer. undefined o vacío = hace TODOS los agendables (default
   * amable: el dueño que solo escribe nombres no tiene que configurar nada más).
   */
  serviciosIds?: string[];
  /**
   * Días libres puntuales de ESTA persona (vacaciones, incapacidad), aparte de los
   * bloqueos del negocio. El horario semanal sigue siendo el del tenant.
   */
  bloqueos?: Bloqueo[];
  /** Color hex "#rrggbb" del carril en la Agenda. undefined = se asigna uno por posición. */
  color?: string;
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
  /** Fechas puntuales cerradas (feriados/vacaciones), fuera del horario semanal recurrente. */
  bloqueos: Bloqueo[];
  /**
   * Quiénes atienden (personas, bahías, sillones). Vacío = el negocio se comporta como
   * UN solo recurso, que es exactamente el comportamiento anterior a ALTO-07: así los
   * tenants que ya existen no cambian en nada hasta que el dueño cargue su equipo.
   */
  empleados: Empleado[];
  /**
   * Link para pedir reseña de Google (Maps / "Escribir reseña"), usado en el
   * seguimiento post-servicio (C3.1). undefined = sin configurar (no se pide reseña).
   */
  linkResenas?: string;
  /**
   * Nombre de la plantilla MARKETING aprobada en Meta para este tenant (campañas
   * segmentadas, C3.2). undefined = sin configurar (no se pueden enviar campañas).
   */
  plantillaMarketing?: string;
  /**
   * Nombre de la plantilla de UTILIDAD aprobada en Meta para reabrir conversaciones
   * fuera de la ventana de 24h (Carril D, 0.3). undefined = sin configurar (el panel
   * no puede reabrir; solo queda esperar a que el cliente escriba de nuevo).
   */
  plantillaReapertura?: string;
  /** Color de acento del panel (hex "#rrggbb"), white-label C4.1. undefined = paleta default. */
  colorAcento?: string;
  /** Color del encabezado del panel (hex "#rrggbb"), white-label C4.1. undefined = paleta default. */
  colorHeader?: string;
  /** URL del logo del negocio, white-label C4.1. undefined = se muestran las iniciales del nombre. */
  logoUrl?: string;
  /**
   * Plan de suscripción (C4.3, Stripe): gobierna campañas/multi-usuario/white-label
   * (ver src/billing/planes.ts). Default "pro" — ver nota de grandfathering en el schema.
   */
  plan: Plan;
  /** Id del customer en Stripe. undefined = nunca pasó por Checkout. */
  stripeCustomerId?: string;
  /** Id de la suscripción activa/última en Stripe. */
  stripeSubscriptionId?: string;
  /** Espejo local del status de la suscripción de Stripe. undefined = nunca se suscribió. */
  estadoFacturacion?: EstadoFacturacion;
  /** current_period_end de la suscripción (ISO), para mostrar "próximo cobro" en el panel. */
  facturacionPeriodoFin?: string;
  /**
   * Rescate de cotizaciones abandonadas (Carril D, Fase 1 - 1.1): on/off. false/undefined =
   * el bot registra cotizaciones igual (dato barato) pero no se manda ningún seguimiento.
   */
  rescateActivo?: boolean;
  /** Horas sin cita antes del primer toque de seguimiento. undefined = default (3h). */
  rescateHorasEspera?: number;
  /** Texto editable del primer toque (dentro de la ventana de 24h, con lista de horarios). */
  rescateToque1Texto?: string;
  /** Texto/variable editable que llena la plantilla del segundo toque (fuera de 24h). */
  rescateToque2Texto?: string;
  /** Nombre de la plantilla de Meta (marketing/utilidad) para el segundo toque. undefined = sin configurar. */
  rescatePlantilla?: string;
  /**
   * Place ID de Google (Carril D, Fase 1 - 1.3): habilita el job diario de Places API
   * que alimenta la sección "Reputación" del dashboard. undefined = sin configurar
   * (no corre el job para este tenant).
   */
  googlePlaceId?: string;
  /**
   * ID del Google Calendar DE ESTE NEGOCIO (auditoría BLOQ-05). undefined = sin
   * configurar → no se sincronizan citas con Calendar para este tenant. Nunca se cae
   * al calendario de otro negocio: ver src/calendar/googleCalendar.ts.
   */
  googleCalendarId?: string;
  // ── Perfil del negocio (B7, motor multi-mercado) ──
  // Con estos campos el system prompt se arma para cualquier rubro (ver src/agent/systemPrompt.ts).
  /** Rubro/persona del negocio: "una barbería", "una empresa de software e IA". undefined = "un negocio". */
  tipoNegocio?: string;
  /** País del negocio. undefined = se infiere de la zona horaria. */
  pais?: string;
  /** Formas de pago (texto libre). undefined/"" = no se menciona en el prompt. */
  formasPago?: string;
  /** Registro del trato al cliente. undefined = se infiere del país. */
  registro?: "vos" | "tu" | "usted";
  /** Tono/estilo del bot (texto corto). undefined = default "cordial y breve". */
  tono?: string;
  /** Instrucciones libres del dueño para el bot (reglas particulares del negocio). undefined = ninguna. */
  instrucciones?: string;
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

export type EstadoCita = "agendada" | "cancelada" | "completada" | "no_show";

export interface Cita {
  id: string;
  tenantId: string;
  /** Número del cliente en formato E.164 sin "+", ej "50688887777". */
  clienteWa: string;
  clienteNombre: string;
  servicioId: string;
  /**
   * Quién atiende (`Empleado.id`). undefined = sin asignar: son las citas anteriores a
   * ALTO-07 y las de negocios que no cargaron equipo. Una cita sin asignar NO bloquea a
   * ningún empleado en particular — ver src/booking/availability.ts.
   */
  empleadoId?: string;
  fecha: string; // "YYYY-MM-DD"
  hora: string; // "HH:mm"
  placa?: string;
  estado: EstadoCita;
  creadaEn: string; // ISO
  /**
   * Quién la generó: "bot" (agendado por WhatsApp) o "manual" (creada en la Agenda
   * del panel, C2.1). Undefined = fila vieja anterior a este campo → se trata como
   * "bot" (todas las citas eran del bot antes de que existiera la Agenda). C3.3.
   */
  origen?: "bot" | "manual";
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
  /**
   * Cuándo se envió el seguimiento post-servicio (satisfacción + reseña, C3.1).
   * null/undefined = pendiente.
   */
  postServicioEn?: string | null;
  /** Add-ons aceptados por el cliente al agendar (upsell, Carril D 1.2). Vacío/undefined = ninguno. */
  addons?: AddonCita[];
}

export type TipoRecordatorio = "dia_antes" | "mismo_dia" | "post_servicio";

// ─────────────────────────────────────────────────────────────────────────────
// Motor de reseñas de Google completo (Carril D, Fase 1 - 1.3): extiende el
// post-servicio de C3.1. Con plan Pro, el seguimiento post-servicio manda 3
// botones (Excelente/Bien/Mal en vez de Todo bien/Tuve un problema) y registra
// la respuesta en wa_seguimientos, para el contador "solicitudes enviadas" del
// dashboard. El plan Básico sigue el flujo legacy de 2 botones sin esta fila.
// ─────────────────────────────────────────────────────────────────────────────
export type Sentimiento = "positivo" | "neutral" | "negativo";

export interface Seguimiento {
  id: string;
  citaId: string;
  tenantId: string;
  enviadoEn: string; // ISO
  /** null = el cliente todavía no respondió el seguimiento. */
  sentimiento: Sentimiento | null;
  /** true si "positivo" (Excelente): se le mandó el link de reseña. */
  resenaSolicitada: boolean;
  respuestaTexto?: string | null;
}

/** Snapshot diario de reputación en Google (Carril D 1.3-c, vía Places API). */
export interface SnapshotReputacion {
  fecha: string; // "YYYY-MM-DD"
  rating: number;
  totalResenas: number;
}

/**
 * Rol de un usuario del panel dentro de su negocio (C2.3): "dueno" puede editar
 * "Mi negocio" y gestionar usuarios; "operador" solo atiende bandeja/agenda.
 */
export type Rol = "dueno" | "operador";

/**
 * Plan de suscripción del negocio (C4.3): "basico" (bot + panel + agenda) o "pro" (suma
 * campañas segmentadas, multi-usuario y white-label). Ver src/billing/planes.ts.
 */
export type Plan = "basico" | "pro";

/**
 * Espejo local del status de la suscripción de Stripe (src/billing/webhook.ts sincroniza
 * esto ante cada webhook). "atrasado" = pago falló pero Stripe sigue reintentando (el bot
 * y el panel NO se ven afectados); "cancelado" = Stripe agotó los reintentos o el dueño
 * canceló desde el Customer Portal (downgrade suave a plan "basico").
 */
export type EstadoFacturacion = "trial" | "activo" | "atrasado" | "cancelado";

/**
 * Payload serializable de un Pendiente para la cola durable (wa_jobs).
 * No incluye el `tenant`; el worker lo relee del tenantStore por phoneNumberId.
 * Los campos de `entrante` se inlinean para evitar dependencia circular con
 * whatsapp/client.ts (que importa Tenant desde este mismo módulo).
 */
export interface PendienteSerializado {
  clase: "texto" | "no-texto" | "audio" | "imagen" | "documento" | "contacto";
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
    /** id del media de documento (solo cuando clase === "documento"). No se descarga aún (E12). */
    documentoId?: string;
    /** nombre de archivo del documento (solo cuando clase === "documento"), para el push al operador. */
    documentoNombre?: string;
    /** nombre del contacto compartido (solo cuando clase === "contacto"), para el push al operador. */
    contactoNombre?: string;
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

/**
 * Cola de trabajo del operador (C2.3): "abierta" = necesita atención, "atendida" =
 * el operador la cerró. Vuelve a "abierta" sola en cuanto el cliente escribe de
 * nuevo, sin importar que estuviera "atendida".
 */
export type EstadoConversacion = "abierta" | "atendida";

export interface Conversacion {
  id: string;
  tenantId: string;
  clienteWa: string;
  optInEn: string | null;
  /**
   * Opt-out de CAMPAÑAS de marketing (C3.2): cuándo el cliente escribió "BAJA".
   * null = sigue recibiendo campañas. NO afecta recordatorios ni seguimiento
   * post-servicio (son mensajes de servicio ligados a una cita, no marketing).
   */
  optOutEn?: string | null;
  /** "bot" => responde la IA. "humano" => la IA se calla y atiende una persona. */
  modo: ModoConversacion;
  /** Cola de trabajo (C2.3): "abierta" | "atendida". */
  estado: EstadoConversacion;
  mensajes: MensajeConversacion[];
  /** Nombre del servicio de la cita activa más próxima (o null si no tiene). */
  servicio?: string | null;
  /** true si el cliente tiene al menos una cita agendada futura activa. */
  tieneCita?: boolean;
  /** true si esa cita activa más próxima está confirmada por el cliente (C1.3). */
  citaConfirmada?: boolean;
  /**
   * Ventana de sesión de WhatsApp (Carril D, 0.3): true si el último mensaje del
   * cliente fue hace menos de 24h — solo entonces se puede mandar texto libre.
   * Derivada de `mensajes`, no se persiste (ver src/whatsapp/ventana.ts).
   */
  ventanaAbierta: boolean;
  /** ISO de cuándo cierra la ventana de 24h; null = el cliente nunca escribió. */
  ventanaCierraEn: string | null;
}

/** Fila liviana para la lista de la bandeja del panel (sin todo el historial). */
export interface ResumenConversacion {
  id: string;
  clienteWa: string;
  modo: ModoConversacion;
  /** Cola de trabajo (C2.3): "abierta" | "atendida". */
  estado: EstadoConversacion;
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
  /** Nombre del cliente si ya quedó registrado en alguna cita; null si aún no se sabe. */
  nombre?: string | null;
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
   * % de citas pasadas resueltas (completadas + no-show) que terminaron en
   * no-show. undefined si todavía no hay ninguna cita resuelta. C3.3.
   */
  noShowPct?: number;
  /** Citas activas (no canceladas/no-show) agendadas por el bot vs. creadas a mano en la Agenda. C3.3. */
  citasBot: number;
  citasManuales: number;
  /** Clientes con una sola cita registrada vs. con dos o más (fidelización). C3.3. */
  clientesNuevos: number;
  clientesRecurrentes: number;
  /** % de conversaciones que el bot resolvió SIN pasar nunca a modo humano. C3.3. */
  ahorroBotPct: number;
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
  /** Cotizaciones que recibieron al menos un toque de seguimiento (Carril D, 1.1). */
  rescateEnviados: number;
  /** De esas, cuántas terminaron en una cita (el seguimiento funcionó). */
  rescateRecuperados: number;
  /** rescateRecuperados / rescateEnviados. undefined si nunca se envió ningún toque. */
  rescateTasaPct?: number;
  /** Suma de lo cotizado en las cotizaciones recuperadas ("₡ recuperados", la tarjeta de venta). */
  rescateMontoRecuperado: number;
  /** Ticket promedio por cita, INCLUYENDO add-ons aceptados (Carril D, 1.2). 0 si no hay citas. */
  ticketPromedio: number;
  /** Suma de lo cobrado en add-ons aceptados ("₡ extra" del mes, la tarjeta de venta del upsell). */
  upsellMontoExtra: number;
  /** Citas con add-on aceptado / (aceptados + rechazos registrados). undefined si nunca hubo ninguno de los dos. */
  upsellTasaPct?: number;
  /**
   * Seguimientos post-servicio respondidos con "Excelente" (Carril D, 1.3): se les
   * mandó el link de reseña. Solo cuenta el flujo Pro (wa_seguimientos) — el flujo
   * Básico legacy (2 botones) no registra nada acá.
   */
  resenasSolicitadas: number;
  /** Seguimientos respondidos con "Bien" o "Mal" (NO se les pidió reseña), para el split del dashboard. */
  resenasNoSolicitadas: number;
  /**
   * Reputación en Google (Carril D, 1.3-c, Places API): snapshot más reciente +
   * histórico para graficar la evolución. undefined = sin googlePlaceId configurado,
   * o el job diario todavía no corrió ninguna vez.
   */
  reputacion?: {
    rating: number;
    totalResenas: number;
    historico: { fecha: string; rating: number; totalResenas: number }[];
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Campañas segmentadas (C3.2): envío masivo de plantilla MARKETING a un segmento
// del CRM. Viven en un módulo aparte (src/campaigns/), DB-directo, gateado por
// hayBaseDeDatos() — mismo precedente que "Usuarios" (C2.3) en tenantStore.ts.
// ─────────────────────────────────────────────────────────────────────────────

/** Cómo se arma la lista de destinatarios de una campaña. */
export type SegmentoTipo = "todos" | "inactivos" | "servicio_antiguo";

export interface SegmentoFiltro {
  tipo: SegmentoTipo;
  /** "inactivos": última cita hace ≥ `dias` días. */
  dias?: number;
  /** "servicio_antiguo": servicio a considerar. */
  servicioId?: string;
  /** "servicio_antiguo": última cita completada de ese servicio hace ≥ `meses` meses. */
  meses?: number;
}

/** Cliente que calificó para el segmento de una campaña (preview o materializado). */
export interface ClienteSegmento {
  clienteWa: string;
  nombre: string;
  ultimaVisita: string | null; // "YYYY-MM-DD"
}

export type EstadoCampania = "borrador" | "programada" | "enviando" | "completada" | "cancelada";

export interface Campania {
  id: string;
  tenantId: string;
  nombre: string;
  mensaje: string;
  segmentoTipo: SegmentoTipo;
  segmentoParametros: SegmentoFiltro;
  estado: EstadoCampania;
  programadaPara: string | null;
  creadaEn: string;
  iniciadaEn: string | null;
  completadaEn: string | null;
  totalDestinatarios: number;
}

export type EstadoEnvioCampania = "pendiente" | "procesando" | "enviado" | "error" | "omitido_opt_out";

export interface CampaniaEnvio {
  id: string;
  campaniaId: string;
  clienteWa: string;
  clienteNombre: string;
  estado: EstadoEnvioCampania;
  intentos: number;
  error: string | null;
  enviadoEn: string | null;
}

/** Métricas de una campaña, calculadas sobre wa_campania_envios + mensajes/citas posteriores. */
export interface MetricasCampania {
  destinatarios: number;
  enviados: number;
  fallidos: number;
  omitidosOptOut: number;
  /** Clientes distintos que escribieron algo después de recibir el envío. */
  respuestas: number;
  /** Citas nuevas creadas por clientes de la campaña después de recibir el envío. */
  citasGeneradas: number;
}

export interface CampaniaConDetalle extends Campania {
  metricas: MetricasCampania;
  envios: CampaniaEnvio[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Rescate de cotizaciones abandonadas (Carril D, Fase 1 - 1.1): el bot cotiza un
// pulido pero el cliente no agenda; si no vuelve, se le manda un seguimiento
// automático (máx. 2 toques). El CRUD vive en el Repositorio (memoria y Drizzle)
// para que aparezca en el dashboard y en el seed de demo; el ENVÍO de los toques
// es DB-directo en src/rescate/ (mini-cola independiente de wa_jobs, mismo patrón
// que C3.2 — ver [[patron-colas-independientes]]).
// ─────────────────────────────────────────────────────────────────────────────
export type EstadoCotizacion =
  | "pendiente" // recién cotizada, sin cita, esperando el plazo del primer toque
  | "toque1" // se mandó el primer toque (lista de horarios), sin cita todavía
  | "toque2" // se mandó el segundo toque (plantilla), sin cita todavía; ya no hay más toques
  | "agendada" // el cliente agendó ANTES de que saliera ningún toque (el rescate no hizo nada)
  | "recuperada" // el cliente agendó DESPUÉS de un toque (el rescate funcionó)
  | "descartada" // el dueño la descartó a mano (no va a volver)
  | "opt_out"; // el cliente pidió "BAJA": se detiene el seguimiento

export interface Cotizacion {
  id: string;
  tenantId: string;
  clienteWa: string;
  servicioId: string;
  /** Monto cotizado en colones. */
  monto: number;
  estado: EstadoCotizacion;
  /** Cita que resultó de esta cotización (agendada o recuperada). null = todavía sin cita. */
  citaId?: string | null;
  /** Precio final de la cita recuperada (para "₡ recuperados"). null = no aplica. */
  montoRecuperado?: number | null;
  creadaEn: string; // ISO
  /** Cuándo se mandó el primer toque. null = pendiente. */
  toque1En?: string | null;
  /** Cuándo se mandó el segundo toque. null = pendiente (o nunca hizo falta). */
  toque2En?: string | null;
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
   * Opt-out de CAMPAÑAS de marketing (C3.2): el cliente escribió "BAJA". Marca
   * `optOutEn` en la conversación; el segmento de cualquier campaña futura lo
   * excluye. No afecta recordatorios ni seguimiento post-servicio.
   */
  marcarOptOut(conversacionId: string): Promise<void>;
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
   * Una cita por id, scopeada por tenantId. null si no existe o no es de ese negocio.
   * La necesitan reprogramar/reasignar para saber a quién está asignada ANTES de mover
   * nada (ALTO-07) — sin esto habría que escanear el rango completo de citas.
   */
  obtenerCitaPorId(tenantId: string, citaId: string): Promise<Cita | null>;
  /**
   * Cambia quién atiende una cita ya creada (ALTO-07), desde la Agenda del panel.
   * `null` la deja sin asignar. Scopeada por tenantId. Devuelve la cita actualizada,
   * o null si no existe / no es del tenant.
   *
   * Con DB, el índice único `wa_citas_empleado_slot_uq` rechaza (23505) el intento de
   * dejar a la misma persona con dos citas "agendada" en el mismo horario: el caller
   * debe traducir ese error a un 409, no dejarlo escapar como 500.
   */
  reasignarCita(tenantId: string, citaId: string, empleadoId: string | null): Promise<Cita | null>;
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
  /**
   * Marca una cita como no-show (el cliente no se presentó), desde el panel.
   * Scopeada por tenantId. Solo aplica si estaba "agendada". Devuelve la cita, o
   * null si no existe / no es del tenant / no estaba agendada. C3.3.
   */
  marcarNoShow(tenantId: string, citaId: string): Promise<Cita | null>;
  /**
   * Registra que se cotizó un pulido con intención de venta (Carril D, 1.1). Devuelve
   * null (sin crear nada) si el cliente YA tiene una cotización activa (pendiente/
   * toque1/toque2) — regla dura: no dos rescates activos al mismo teléfono.
   */
  registrarCotizacion(tenantId: string, clienteWa: string, servicioId: string, monto: number): Promise<Cotizacion | null>;
  /**
   * Se llama al crear una cita (bot o manual, C1.1). Si el cliente tiene una cotización
   * ACTIVA para ese mismo servicio, la cierra: "agendada" si todavía no se le mandó
   * ningún toque (el rescate no hizo nada), o "recuperada" si ya se le había mandado
   * alguno (el seguimiento funcionó). No-op si no hay ninguna cotización activa.
   */
  actualizarCotizacionPorCita(
    tenantId: string,
    clienteWa: string,
    servicioId: string,
    citaId: string,
    montoCita?: number,
  ): Promise<void>;
  /**
   * Agrega un add-on ACEPTADO a una cita ya agendada (upsell, Carril D 1.2). Idempotente:
   * si el add-on ya estaba, no lo duplica. Scopeada por tenantId. Devuelve la cita
   * actualizada, o null si no existe / no es del tenant.
   */
  agregarAddonACita(tenantId: string, citaId: string, addon: AddonCita): Promise<Cita | null>;
  /**
   * Registra que el cliente RECHAZÓ un add-on (upsell, Carril D 1.2), para no
   * volver a ofrecérselo pronto. Vive en la conversación del cliente (no en la
   * cita): el rechazo es una preferencia del cliente, no de un agendamiento puntual.
   */
  registrarRechazoAddon(tenantId: string, clienteWa: string, addonId: string): Promise<void>;
  /**
   * true si el cliente rechazó ese add-on en los últimos 60 días (Carril D 1.2) —
   * el bot no debe volver a ofrecérselo. `hoy` ("YYYY-MM-DD") es inyectable para
   * pruebas deterministas.
   */
  fueRechazadoAddonRecientemente(tenantId: string, clienteWa: string, addonId: string, hoy: string): Promise<boolean>;
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
  /** Cambia el estado de la cola de trabajo (abierta ↔ atendida), a mano desde el panel (C2.3). */
  marcarEstadoConversacion(tenantId: string, conversacionId: string, estado: EstadoConversacion): Promise<void>;
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

  // ── Motor de reseñas de Google completo (Carril D, Fase 1 - 1.3) ──
  /**
   * Registra que se mandó el seguimiento post-servicio con el flujo Pro (3 botones).
   * Idempotente por citaId: si ya existe una fila (reintento del scheduler), no
   * lanza ni duplica. Solo se llama para tenants en plan Pro.
   */
  crearSeguimiento(tenantId: string, citaId: string): Promise<void>;
  /**
   * Registra la respuesta del cliente al seguimiento post-servicio: sentimiento
   * marcado, si se le pidió reseña y el texto legible de su respuesta. No-op si no
   * existe una fila para esa cita (tenant en plan Básico, flujo legacy sin tracking)
   * — el caller no necesita saber de antemano si el tenant es Pro.
   */
  registrarRespuestaSeguimiento(
    citaId: string,
    sentimiento: Sentimiento,
    resenaSolicitada: boolean,
    respuestaTexto: string,
  ): Promise<void>;
  /** Seguimientos post-servicio del tenant, para el contador del dashboard (Carril D 1.3). */
  seguimientosDeTenant(tenantId: string): Promise<Seguimiento[]>;
  /**
   * Guarda el snapshot diario de reputación en Google (Carril D 1.3-c, Places API).
   * Upsert por (tenantId, fecha): si el job corre dos veces el mismo día, no duplica.
   */
  guardarSnapshotReputacion(tenantId: string, fecha: string, rating: number, totalResenas: number): Promise<void>;
  /** Últimos snapshots de reputación del tenant, más reciente primero (gráfico de evolución). */
  historicoReputacion(tenantId: string, limite: number): Promise<SnapshotReputacion[]>;

  // ── Notificaciones push (Web Push) ──
  guardarPushSub(tenantId: string, sub: PushSub): Promise<void>;
  listarPushSubs(tenantId: string): Promise<PushSub[]>;
  borrarPushSub(endpoint: string): Promise<void>;
}
