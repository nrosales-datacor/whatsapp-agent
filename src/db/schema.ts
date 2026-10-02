import { pgTable, text, timestamp, integer, boolean, jsonb, index, uniqueIndex, numeric, bigint } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { AddonCita, Bloqueo, Empleado, HorarioDia, KnowledgeBase, PendienteSerializado, RechazoAddon, SegmentoFiltro, Service } from "../types";

// ─────────────────────────────────────────────────────────────────────────────
// Esquema Drizzle del agente de WhatsApp.
// Tablas prefijadas con "wa_" para no chocar con las tablas existentes de @gp/db.
//
// Cómo integrarlo al monorepo:
//   1. Pegá estas tablas en tu paquete @gp/db (src/schema/…) y exportálas.
//   2. Como son multi-tenant (columna tenant_id), agregá políticas RLS en tu
//      flujo `rls/apply.ts`, igual que tus otras tablas.
//
// RLS (revisión pre-venta 2026-10, G2): TODAS las tablas llevan `.enableRLS()` y,
// por ahora, NINGUNA política. Supabase expone `public` por su Data API (PostgREST)
// con la anon key —que es pública— y le da grants por defecto a `anon`/
// `authenticated`: sin RLS, cualquiera leía/escribía todas las tablas de todos los
// tenants. Con RLS activo y sin políticas, esos roles no ven ni una fila; la app no
// cambia porque conecta como `postgres` (BYPASSRLS). Las políticas por tenant y el
// rol sin BYPASSRLS son F1. Toda tabla NUEVA debe llevar `.enableRLS()` (lo exige
// `test/security/rls.test.ts`).
// ─────────────────────────────────────────────────────────────────────────────

const id = () => text("id").primaryKey().$defaultFn(() => randomUUID());

export const waConversaciones = pgTable(
  "wa_conversaciones",
  {
    id: id(),
    tenantId: text("tenant_id").notNull(),
    clienteWa: text("cliente_wa").notNull(),
    optInEn: timestamp("opt_in_en", { withTimezone: true }),
    // Opt-out de CAMPAÑAS de marketing (C3.2): el cliente escribió "BAJA". No afecta
    // recordatorios ni seguimiento post-servicio (son mensajes de servicio, no marketing).
    optOutEn: timestamp("opt_out_en", { withTimezone: true }),
    creadaEn: timestamp("creada_en", { withTimezone: true }).notNull().defaultNow(),
    // Panel / bandeja humana.
    modo: text("modo").notNull().default("bot"), // "bot" | "humano"
    humanoEn: timestamp("humano_en", { withTimezone: true }),
    // Cola de trabajo del operador (C2.3): "abierta" (necesita atención) | "atendida"
    // (el operador la cerró). Vuelve a "abierta" sola cuando el cliente escribe de
    // nuevo (ver guardarEntranteYEncolar), sin importar que estuviera "atendida".
    estado: text("estado").notNull().default("abierta"),
    // DEPRECADO: ya no se usa. El código calcula "sin leer" desde leido_hasta. Se deja
    // la columna para que la migración sea ADITIVA (sin DROP, sin perder datos en prod);
    // se puede eliminar más adelante con un `drizzle-kit generate` interactivo.
    noLeidos: integer("no_leidos").notNull().default(0),
    // Hasta cuándo leyó el operador. Los mensajes del cliente posteriores a esta
    // marca cuentan como "sin leer". Reemplaza al contador no_leidos, que tenía una
    // carrera (un reset en segundo plano pisaba un incremento concurrente).
    leidoHasta: timestamp("leido_hasta", { withTimezone: true }),
    // Notas privadas del negocio sobre este cliente (ficha / CRM).
    notas: text("notas"),
    // Upsell inteligente al agendar (Carril D, 1.2): add-ons que el cliente rechazó, para
    // no volver a ofrecérselos antes de 60 días. Vive en la conversación (preferencia del
    // cliente), no en la cita puntual.
    upsellsRechazados: jsonb("upsells_rechazados").$type<RechazoAddon[]>().notNull().default([]),
  },
  (t) => ({
    uq: uniqueIndex("wa_conv_tenant_cliente_uq").on(t.tenantId, t.clienteWa),
    idxTenant: index("wa_conv_tenant_idx").on(t.tenantId),
  }),
).enableRLS();

export const waMensajes = pgTable(
  "wa_mensajes",
  {
    id: id(),
    conversacionId: text("conversacion_id")
      .notNull()
      .references(() => waConversaciones.id, { onDelete: "cascade" }),
    rol: text("rol").notNull(), // "user" | "assistant"
    contenido: text("contenido").notNull(),
    creadoEn: timestamp("creado_en", { withTimezone: true }).notNull().defaultNow(),
    porHumano: boolean("por_humano").notNull().default(false),
    // id del mensaje en WhatsApp (msg.id). Único → hace el webhook idempotente ante
    // los reintentos de Meta. Null en los salientes (no vienen de Meta); Postgres
    // permite múltiples NULL en un índice único, así que no chocan entre sí.
    waMessageId: text("wa_message_id"),
    // Foto adjunta del cliente (C1.5). Se completa en fase 2, después de descargarla
    // de Meta. Carril F, F9: ahora guarda la RUTA CORTA del objeto en Supabase
    // Storage (ej. "tenantId/conversacionId/wamid.jpg"), no los bytes — el panel
    // pide una URL firmada de corta vida al leer la conversación
    // (`resolverMediaParaPanel` en `storage/supabaseStorage.ts`). Las filas de
    // ANTES de F9 (o las guardadas sin Storage configurado, fallback) siguen
    // teniendo un data URL completo ("data:image/...;base64,...") — se detectan
    // por el prefijo "data:" y se devuelven tal cual, sin intentar firmarlas.
    mediaUrl: text("media_url"),
    mediaTipo: text("media_tipo"), // "imagen" | null
  },
  (t) => ({
    idxConv: index("wa_msg_conv_idx").on(t.conversacionId),
    uqWaId: uniqueIndex("wa_msg_waid_uq").on(t.waMessageId),
  }),
).enableRLS();

export const waCitas = pgTable(
  "wa_citas",
  {
    id: id(),
    tenantId: text("tenant_id").notNull(),
    clienteWa: text("cliente_wa").notNull(),
    clienteNombre: text("cliente_nombre").notNull(),
    servicioId: text("servicio_id").notNull(),
    // Quién atiende (ALTO-07): slug de un Empleado del arreglo wa_tenants.empleados,
    // sin FK — mismo trato que servicio_id. null = sin asignar (citas anteriores a esta
    // columna y negocios que no cargaron equipo): NO bloquean a ningún empleado.
    empleadoId: text("empleado_id"),
    fecha: text("fecha").notNull(), // "YYYY-MM-DD"
    hora: text("hora").notNull(), // "HH:mm"
    placa: text("placa"),
    estado: text("estado").notNull().default("agendada"), // agendada|cancelada|completada|no_show
    // Quién la generó: "bot" (WhatsApp) o "manual" (Agenda del panel, C2.1). Default
    // "bot" porque todas las citas eran del bot antes de que existiera la Agenda.
    origen: text("origen").notNull().default("bot"),
    creadaEn: timestamp("creada_en", { withTimezone: true }).notNull().defaultNow(),
    // Precio cotizado al agendar (colones). Para métricas de ingresos. Puede ser null.
    precio: integer("precio"),
    // Integración con Google Calendar y recordatorios por WhatsApp.
    gcalEventId: text("gcal_event_id"),
    recordatorioDiaAntesEn: timestamp("recordatorio_dia_antes_en", { withTimezone: true }),
    recordatorioMismoDiaEn: timestamp("recordatorio_mismo_dia_en", { withTimezone: true }),
    // Cuándo el cliente CONFIRMÓ la cita (tocando el botón del recordatorio). null =
    // sin confirmar. Anti no-show: el dueño ve qué citas de mañana están confirmadas (C1.3).
    confirmadaEn: timestamp("confirmada_en", { withTimezone: true }),
    // Cuándo se envió el seguimiento post-servicio (satisfacción + reseña, C3.1).
    // null = pendiente.
    postServicioEn: timestamp("post_servicio_en", { withTimezone: true }),
    // Add-ons aceptados por el cliente al agendar (upsell, Carril D 1.2). El monto total
    // (base + add-ons) se calcula al leer (precio + suma de addons.precio), no se persiste
    // aparte: evita que un total guardado quede desincronizado del detalle.
    addons: jsonb("addons").$type<AddonCita[]>().notNull().default([]),
  },
  (t) => ({
    idxTenantFecha: index("wa_citas_tenant_fecha_idx").on(t.tenantId, t.fecha),
    // Red de último recurso contra la doble reserva de UNA MISMA persona (ALTO-07): dos
    // clientes tocando el mismo horario en el mismo instante ganan la carrera contra el
    // chequeo de `espaciosDisponibles`, que lee y decide fuera de la transacción.
    //
    // Parcial en dos sentidos, ambos deliberados: solo citas "agendada" (una cancelada
    // libera el espacio) y solo con empleado asignado (varias citas sin asignar a la
    // misma hora son legítimas — es el comportamiento de siempre).
    //
    // ⚠️ Cubre el choque de hora EXACTA, no el solape parcial (una cita de 60 min a las
    // 09:00 contra una de 30 a las 09:30). Eso necesitaría un EXCLUDE con btree_gist
    // sobre columnas generadas, porque fecha/hora son `text`. La lógica de solapes sí
    // vive completa en src/booking/availability.ts; esto es solo el guard de carrera.
    // El guard completo (recurso único, solapes, reprogramación) es el re-chequeo
    // atómico bajo advisory lock por tenant+fecha de RepositorioDrizzle.crearCita /
    // reprogramarCita (revisión pre-venta 2026-10); este índice queda de última red.
    uqEmpleadoSlot: uniqueIndex("wa_citas_empleado_slot_uq")
      .on(t.tenantId, t.empleadoId, t.fecha, t.hora)
      .where(sql`${t.estado} = 'agendada' AND ${t.empleadoId} IS NOT NULL`),
  }),
).enableRLS();

export const waEventosCalidad = pgTable(
  "wa_eventos_calidad",
  {
    id: id(),
    tenantId: text("tenant_id").notNull(),
    clienteWa: text("cliente_wa").notNull(),
    tipo: text("tipo").notNull(), // mensaje_ok | fuera_de_alcance | error
    detalle: text("detalle"),
    creadoEn: timestamp("creado_en", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    idxTenant: index("wa_eventos_tenant_idx").on(t.tenantId, t.creadoEn),
  }),
).enableRLS();

// Suscripciones de notificaciones push del panel (Web Push), por negocio.
export const waPushSubs = pgTable(
  "wa_push_subs",
  {
    id: id(),
    tenantId: text("tenant_id").notNull(),
    endpoint: text("endpoint").notNull(),
    p256dh: text("p256dh").notNull(),
    auth: text("auth").notNull(),
    creadaEn: timestamp("creada_en", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uq: uniqueIndex("wa_push_endpoint_uq").on(t.endpoint),
    idxTenant: index("wa_push_tenant_idx").on(t.tenantId),
  }),
).enableRLS();

// ─────────────────────────────────────────────────────────────────────────────
// Multi-tenant: los negocios y sus usuarios del panel viven en la base (antes
// estaban hardcodeados en src/config/tenants.ts). Así se da de alta un negocio sin
// tocar código (ROADMAP B2). El código los lee a través de un caché en memoria
// (src/config/tenantStore.ts); estas tablas son la fuente de verdad.
// ─────────────────────────────────────────────────────────────────────────────

export const waTenants = pgTable(
  "wa_tenants",
  {
    // OJO: el id es el SLUG del negocio ("lavacar-rosales"), NO un uuid. Tiene que
    // coincidir con el tenant_id ya guardado en wa_conversaciones/wa_citas/etc.
    // (no son FK, pero el valor debe ser el mismo). Por eso es inmutable.
    id: text("id").primaryKey(),
    nombre: text("nombre").notNull(),
    // phone_number_id de WhatsApp Cloud API. Único → ruteo determinístico del webhook.
    phoneNumberId: text("phone_number_id").notNull(),
    // Token del WABA del cliente. null => cae al token de .env (número de prueba).
    accessToken: text("access_token"),
    timezone: text("timezone").notNull(),
    moneda: text("moneda").notNull(),
    ubicacion: text("ubicacion").notNull(),
    intervaloAgendaMin: integer("intervalo_agenda_min").notNull().default(30),
    // Config rica como JSONB: árboles profundos, read-mostly, nunca se consultan por
    // dentro. El caché sirve la lectura; el onboarding (B3) escribe estos blobs.
    horario: jsonb("horario").$type<Record<number, HorarioDia>>().notNull(),
    servicios: jsonb("servicios").$type<Service[]>().notNull(),
    kb: jsonb("kb").$type<KnowledgeBase>().notNull(),
    // Feriados/vacaciones puntuales (C2.2), fuera del horario semanal recurrente.
    bloqueos: jsonb("bloqueos").$type<Bloqueo[]>().notNull().default([]),
    // Quiénes atienden: personas, bahías, sillones (ALTO-07). Mismo trato que `servicios`
    // (lista chica read-mostly referenciada por slug desde wa_citas.empleado_id).
    // [] = el negocio se comporta como UN solo recurso, igual que antes de esta columna.
    empleados: jsonb("empleados").$type<Empleado[]>().notNull().default([]),
    // Link para pedir reseña de Google (Maps / "Escribir reseña"), usado en el
    // seguimiento post-servicio (C3.1). null = sin configurar (no se pide reseña).
    linkResenas: text("link_resenas"),
    // Nombre de la plantilla MARKETING aprobada en Meta para este tenant (C3.2, campañas
    // segmentadas). null = sin configurar (el dueño no puede enviar campañas todavía).
    plantillaMarketing: text("plantilla_marketing"),
    // Plantilla de UTILIDAD aprobada en Meta para reabrir conversaciones fuera de la
    // ventana de 24h (Carril D, 0.3). null = sin configurar (no se puede reabrir).
    plantillaReapertura: text("plantilla_reapertura"),
    // Plantilla de recordatorio de cita, aprobada en Meta PARA ESTE NEGOCIO (E8/BLOQ-06:
    // antes era la env global WHATSAPP_TEMPLATE_RECORDATORIO, y las plantillas se aprueban
    // por WABA — con dos clientes, el nombre de uno no existe en el WABA del otro y los
    // recordatorios fallan en silencio para todos menos uno). null = sin configurar → el
    // recordatorio cae a texto libre con botones (ver src/reminders/scheduler.ts).
    plantillaRecordatorio: text("plantilla_recordatorio"),
    // Idioma con el que se aprobó la plantilla de recordatorio en Meta ("es", "es_MX",
    // "en_US"…). null = usa WHATSAPP_TEMPLATE_IDIOMA (.env) o "es" (E8/BLOQ-06). A
    // diferencia del nombre de la plantilla, esto NO es fail-closed: el idioma no es un
    // secreto ni causa fuga entre negocios, así que un default global razonable está bien.
    plantillaIdioma: text("plantilla_idioma"),
    // White-label (C4.1): color de acento/encabezado (hex "#rrggbb") y logo (URL). null =
    // sin configurar → el panel usa la paleta verde default de global.css.
    colorAcento: text("color_acento"),
    colorHeader: text("color_header"),
    logoUrl: text("logo_url"),
    // Facturación (C4.3, Stripe): plan vigente + espejo local del estado de la
    // suscripción (la fuente de verdad es Stripe; esto es un caché de lectura rápida
    // para el gating de features, igual que el resto de la config del tenant). Nace
    // en "pro" para no sacarle nada a ningún tenant existente (grandfathering) — el
    // gating solo aplica a quien termine en "basico" tras pasar por Checkout/Portal.
    plan: text("plan").notNull().default("pro"), // "basico" | "pro"
    stripeCustomerId: text("stripe_customer_id"),
    stripeSubscriptionId: text("stripe_subscription_id"),
    // "trial" | "activo" | "atrasado" | "cancelado". null = nunca se suscribió.
    estadoFacturacion: text("estado_facturacion"),
    // current_period_end de la suscripción de Stripe (para mostrar "próximo cobro").
    facturacionPeriodoFin: timestamp("facturacion_periodo_fin", { withTimezone: true }),
    activo: boolean("activo").notNull().default(true),
    creadoEn: timestamp("creado_en", { withTimezone: true }).notNull().defaultNow(),
    actualizadoEn: timestamp("actualizado_en", { withTimezone: true }).notNull().defaultNow(),
    // Rescate de cotizaciones abandonadas (Carril D, Fase 1 - 1.1). false = el bot igual
    // registra la cotización (dato barato), pero no se manda ningún seguimiento automático.
    rescateActivo: boolean("rescate_activo").notNull().default(false),
    rescateHorasEspera: integer("rescate_horas_espera").notNull().default(3),
    rescateToque1Texto: text("rescate_toque1_texto"),
    rescateToque2Texto: text("rescate_toque2_texto"),
    rescatePlantilla: text("rescate_plantilla"),
    // Motor de reseñas de Google completo (Carril D, 1.3): Place ID del negocio para
    // el job diario de Places API (rating + total de reseñas → snapshot_reputacion).
    // null = sin configurar (no corre el job para este tenant).
    googlePlaceId: text("google_place_id"),
    // Google Calendar DEL NEGOCIO (auditoría BLOQ-05). Antes el calendario era una env
    // GLOBAL (GOOGLE_CALENDAR_ID), así que con dos clientes las citas de uno aparecían
    // en el calendario del otro — fuga de datos personales entre tenants. null = sin
    // configurar → la sincronización con Calendar queda apagada para este negocio.
    googleCalendarId: text("google_calendar_id"),
    // Perfil del negocio (B7, motor multi-mercado): con estos campos el system prompt
    // se arma para CUALQUIER rubro, no solo lavacar. null = sin configurar (el prompt
    // usa un default o lo infiere de la zona horaria). Ver src/agent/systemPrompt.ts.
    tipoNegocio: text("tipo_negocio"), // rubro/persona: "una barbería", "una empresa de software"
    pais: text("pais"), // país explícito; null => se infiere del timezone
    formasPago: text("formas_pago"), // texto libre; reemplaza el "SINPE Móvil y efectivo" hardcodeado
    registro: text("registro"), // "vos" | "tu" | "usted"; null => se infiere del país
    tono: text("tono"), // texto corto; null => default "cordial y breve"
    instrucciones: text("instrucciones"), // texto libre grande: reglas particulares del negocio (híbrido)
    // Tope mensual de conversaciones (F10 — PLAN-ESCALA-MULTITENANT.md): interruptor
    // para clientes con contrato especial (ej. Pro con acuerdo custom) que NO deben
    // verse afectados por el tope del plan aunque lo superen. false = el tope del
    // plan (ver src/billing/planes.ts) se aplica normalmente. Lo cambia el
    // superadmin (no es self-service del dueño: es una excepción de contrato).
    topeConversacionesDesactivado: boolean("tope_conversaciones_desactivado").notNull().default(false),
    // Mensaje que recibe el cliente final cuando el negocio alcanza el 100% del tope
    // mensual (F10). null = usa el default razonable de handleWebhook.ts. Self-service
    // del dueño, mismo patrón que rescateToque1Texto/rescateToque2Texto.
    mensajeTopeExcedido: text("mensaje_tope_excedido"),
  },
  (t) => ({
    uqPnid: uniqueIndex("wa_tenants_pnid_uq").on(t.phoneNumberId),
    uqStripeCustomer: uniqueIndex("wa_tenants_stripe_customer_uq").on(t.stripeCustomerId),
  }),
).enableRLS();

export const waUsuarios = pgTable(
  "wa_usuarios",
  {
    id: id(),
    // Lo que se escribe en el login del panel. Único en todo el sistema.
    usuario: text("usuario").notNull(),
    // "salt:hash" scrypt (ver src/panel/auth.ts). Reemplaza al PANEL_PASSWORD_HASH_* de .env.
    passwordHash: text("password_hash").notNull(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => waTenants.id, { onDelete: "cascade" }),
    // Rol dentro del negocio (C2.3): "dueno" puede editar "Mi negocio" y gestionar
    // usuarios; "operador" solo atiende la bandeja/agenda.
    rol: text("rol").notNull().default("operador"),
    activo: boolean("activo").notNull().default(true),
    creadoEn: timestamp("creado_en", { withTimezone: true }).notNull().defaultNow(),
    // Reset de contraseña desde el admin (Carril D, 0.5): el superadmin genera una clave
    // temporal; el panel fuerza el cambio al primer login mientras este flag esté en true.
    debeCambiarClave: boolean("debe_cambiar_clave").notNull().default(false),
    // Vencimiento de la clave temporal (24h desde el reset). Null = clave normal, sin vencer.
    claveTemporalExpira: timestamp("clave_temporal_expira", { withTimezone: true }),
    // Revocación de sesiones (E13/ALTO-06): el token firmado lleva el epoch con el que se
    // firmó (ver src/panel/auth.ts). Cambiar clave/rol/estado incrementa esto — cualquier
    // token viejo (epoch distinto) queda inválido en la próxima request, sin esperar a que
    // expire (hasta 7 días). Empieza en 0 para todas las cuentas existentes.
    sessionEpoch: integer("session_epoch").notNull().default(0),
  },
  (t) => ({
    uqUsuario: uniqueIndex("wa_usuarios_usuario_uq").on(t.usuario),
    idxTenant: index("wa_usuarios_tenant_idx").on(t.tenantId),
  }),
).enableRLS();

// ─────────────────────────────────────────────────────────────────────────────
// Historial de config del tenant (ROADMAP F15). `actualizarConfigTenant`
// (src/config/tenantStore.ts) escribe acá, en la MISMA transacción que el
// `UPDATE` de wa_tenants: cada cambio de "Mi negocio" queda versionado, con
// quién lo hizo y cuándo. `snapshot` guarda el PATCH COMPLETO tal como quedó
// tras el cambio (mismo blob que recibió actualizarConfigTenant), no un diff —
// el diff legible para mostrarlo en el panel es trabajo de frontend, pendiente.
// Restaurar una versión vieja NO borra ni reescribe el historial: crea una fila
// NUEVA idéntica a la vieja (mismo criterio que un revert en git). Sin FK a
// wa_tenants/wa_usuarios a propósito, mismo criterio que el resto de las tablas
// de auditoría/log de este esquema (wa_jobs, wa_webhooks_crudos): tenant_id NO
// es FK en ningún lado salvo wa_usuarios.tenant_id (ver ROADMAP F16).
// ─────────────────────────────────────────────────────────────────────────────
export const waTenantsHistorial = pgTable(
  "wa_tenants_historial",
  {
    id: id(),
    tenantId: text("tenant_id").notNull(),
    snapshot: jsonb("snapshot").notNull(),
    // Quién hizo el cambio. Siempre presente: solo el dueño puede escribir acá
    // (ver el check rol === "dueno" en panel/router.ts), nunca un proceso del sistema.
    usuarioId: text("usuario_id").notNull(),
    creadoEn: timestamp("creado_en", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // Listado del historial de un tenant + poda por retención (src/config/tenantsHistorial.ts):
    // ambos filtran por tenant_id y ordenan por creado_en, así que este índice cubre los dos.
    idxTenant: index("wa_tenants_historial_tenant_idx").on(t.tenantId, t.creadoEn),
  }),
).enableRLS();

// ─────────────────────────────────────────────────────────────────────────────
// Cola durable de jobs (B1). Cada mensaje entrante genera un job aquí ANTES de
// responder 200 a Meta. El worker lo consume con FOR UPDATE SKIP LOCKED: N
// instancias comparten la cola sin doble-procesar. Sin esta tabla, un crash a
// mitad del LLM pierde el mensaje (fire-and-forget).
// ─────────────────────────────────────────────────────────────────────────────
export const waJobs = pgTable(
  "wa_jobs",
  {
    id: id(),
    tenantId: text("tenant_id").notNull(),
    tipo: text("tipo").notNull().default("responder_entrante"),
    estado: text("estado").notNull().default("pendiente"), // pendiente|procesando|hecho|error
    intentos: integer("intentos").notNull().default(0),
    maxIntentos: integer("max_intentos").notNull().default(5),
    ejecutarDespuesDe: timestamp("ejecutar_despues_de", { withTimezone: true }).notNull().defaultNow(),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    creadoEn: timestamp("creado_en", { withTimezone: true }).notNull().defaultNow(),
    finalizadoEn: timestamp("finalizado_en", { withTimezone: true }),
    payload: jsonb("payload").$type<PendienteSerializado>().notNull(),
    ultimoError: text("ultimo_error"),
    // Idempotencia: 1 job por mensaje entrante. NULL permitido (múltiples NULL no
    // chocan en un índice único de Postgres).
    waMessageId: text("wa_message_id"),
  },
  (t) => ({
    // Índice que usa el worker al reclamar: pendientes listos para correr, más viejos primero.
    idxClaim: index("wa_jobs_claim_idx").on(t.estado, t.ejecutarDespuesDe),
    uqWaId: uniqueIndex("wa_jobs_waid_uq").on(t.waMessageId),
  }),
).enableRLS();

// ─────────────────────────────────────────────────────────────────────────────
// Red de seguridad de ingesta cruda (ROADMAP F3). El webhook responde 200 a Meta
// en dos casos que ANTES tiraban el mensaje sin dejar rastro: el phone_number_id
// no resuelve a ningún tenant (caché en fallback tras una caída de la base, o un
// negocio recién dado de alta que el caché aún no cargó) o el payload tiene una
// forma que `clasificarEntrante` (whatsapp/client.ts) no sabe leer. En AMBOS
// casos guardamos acá el payload ya verificado por firma, ANTES de intentar
// resolver el tenant — a diferencia de wa_mensajes/wa_jobs (que solo se llenan en
// el camino feliz), esta tabla es la ÚNICA copia que sobrevive de esos mensajes.
//
// A propósito NO se guarda nada para eventos "status" (entregado/leído) ni otros
// eventos de `value` sin mensaje: son altísimo volumen y no hay nada que
// reprocesar (ver el discriminador en whatsapp/client.ts).
// ─────────────────────────────────────────────────────────────────────────────
export const waWebhooksCrudos = pgTable(
  "wa_webhooks_crudos",
  {
    id: id(),
    payload: jsonb("payload").notNull(),
    // Puede no venir: si el payload es tan raro que ni pudimos leer
    // value.metadata.phone_number_id, queda null (motivo "no_parseable").
    phoneNumberId: text("phone_number_id"),
    // Igual que wa_mensajes.wa_message_id/wa_jobs.wa_message_id: índice único
    // NORMAL (no parcial). Postgres permite múltiples NULL en un índice único
    // (cada NULL se trata como distinto de cualquier otro), así que ya se
    // comporta como "único solo entre los que sí traen id" sin necesidad de un
    // WHERE — mismo idioma que el resto del esquema, para no introducir un
    // segundo patrón de idempotencia.
    waMessageId: text("wa_message_id"),
    recibidoEn: timestamp("recibido_en", { withTimezone: true }).notNull().defaultNow(),
    // "pendiente" (a la espera de reproceso o de agotar los intentos) |
    // "procesado" (se reinyectó con éxito por el mismo camino de ingesta) |
    // "descartado" (agotó WEBHOOKS_CRUDOS_MAX_INTENTOS sin resolver).
    estado: text("estado").notNull().default("pendiente"),
    motivo: text("motivo").notNull(), // "tenant_desconocido" | "no_parseable"
    intentos: integer("intentos").notNull().default(0),
  },
  (t) => ({
    uqWaId: uniqueIndex("wa_webhooks_crudos_waid_uq").on(t.waMessageId),
    // Índice que usa el reproceso y el barrido de alertas: pendientes, más viejos primero.
    idxPendiente: index("wa_webhooks_crudos_pendiente_idx").on(t.estado, t.recibidoEn),
  }),
).enableRLS();

// ─────────────────────────────────────────────────────────────────────────────
// Campañas segmentadas (ROADMAP C3.2). Envío masivo de plantilla MARKETING a un
// segmento del CRM. Cola INDEPENDIENTE de wa_jobs: wa_jobs.payload está tipado
// hard a PendienteSerializado y su worker asume siempre "responder_entrante" —
// forzar un tipo de job nuevo ahí arriesga la pieza de fiabilidad más crítica
// del sistema (B1) para una feature que no es tiempo-crítica. wa_campania_envios
// se reclama con el mismo patrón FOR UPDATE SKIP LOCKED (src/campaigns/cola.ts)
// pero en un worker propio, con throttling entre envíos.
// ─────────────────────────────────────────────────────────────────────────────
export const waCampanias = pgTable(
  "wa_campanias",
  {
    id: id(),
    tenantId: text("tenant_id").notNull(),
    nombre: text("nombre").notNull(),
    // Texto libre que llena la variable {{2}} de la plantilla (mismo cliente para
    // todos los destinatarios; {{1}} es el nombre del cliente, por destinatario).
    mensaje: text("mensaje").notNull(),
    segmentoTipo: text("segmento_tipo").notNull(), // "todos" | "inactivos" | "servicio_antiguo"
    segmentoParametros: jsonb("segmento_parametros").$type<SegmentoFiltro>().notNull(),
    // borrador → (programada) → enviando → completada | cancelada
    estado: text("estado").notNull().default("borrador"),
    programadaPara: timestamp("programada_para", { withTimezone: true }),
    creadaEn: timestamp("creada_en", { withTimezone: true }).notNull().defaultNow(),
    iniciadaEn: timestamp("iniciada_en", { withTimezone: true }),
    completadaEn: timestamp("completada_en", { withTimezone: true }),
    totalDestinatarios: integer("total_destinatarios").notNull().default(0),
  },
  (t) => ({
    idxTenant: index("wa_campanias_tenant_idx").on(t.tenantId, t.creadaEn),
  }),
).enableRLS();

export const waCampaniaEnvios = pgTable(
  "wa_campania_envios",
  {
    id: id(),
    campaniaId: text("campania_id")
      .notNull()
      .references(() => waCampanias.id, { onDelete: "cascade" }),
    tenantId: text("tenant_id").notNull(),
    clienteWa: text("cliente_wa").notNull(),
    clienteNombre: text("cliente_nombre").notNull(),
    // pendiente → procesando → enviado | error (reintenta si quedan intentos) | omitido_opt_out
    estado: text("estado").notNull().default("pendiente"),
    intentos: integer("intentos").notNull().default(0),
    error: text("error"),
    enviadoEn: timestamp("enviado_en", { withTimezone: true }),
    creadoEn: timestamp("creado_en", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // Idempotencia: el segmento no puede insertar dos veces al mismo cliente en la misma campaña.
    uqCampaniaCliente: uniqueIndex("wa_campania_envios_campania_cliente_uq").on(t.campaniaId, t.clienteWa),
    idxClaim: index("wa_campania_envios_claim_idx").on(t.estado),
  }),
).enableRLS();

// ─────────────────────────────────────────────────────────────────────────────
// Contadores de uso mensual por tenant (Carril D, 0.2): cuántas conversaciones/
// mensajes/plantillas consume cada negocio, para acercarse al modelo de cobro de
// Meta (cobra por conversación) y habilitar a futuro el tope de ~500 conv/mes del
// plan Básico. Por ahora se MIDE sin bloquear (sin enforcement todavía). Una fila
// por tenant+mes; los contadores se incrementan atómicamente (INSERT ... ON
// CONFLICT DO UPDATE SET x = x + n) desde src/observabilidad/uso.ts.
// ─────────────────────────────────────────────────────────────────────────────
export const waUsoMensual = pgTable(
  "wa_uso_mensual",
  {
    id: id(),
    tenantId: text("tenant_id").notNull(),
    anioMes: text("anio_mes").notNull(), // "YYYY-MM"
    // "Conversación iniciada" ≈ primer mensaje tras 24 h de silencio (aproxima el
    // modelo de cobro de Meta: una conversación = una ventana de 24 h).
    conversacionesIniciadas: integer("conversaciones_iniciadas").notNull().default(0),
    mensajesEntrantes: integer("mensajes_entrantes").notNull().default(0),
    mensajesSalientes: integer("mensajes_salientes").notNull().default(0),
    plantillasMarketing: integer("plantillas_marketing").notNull().default(0),
    plantillasUtilidad: integer("plantillas_utilidad").notNull().default(0),
    // Costo de LLM por tenant (F13 — PLAN-ESCALA-MULTITENANT.md): tokens de entrada/salida
    // de OpenAI (chat completions, sumados de TODOS los pasos de tool-calling de cada
    // turno, ver src/agent/runAgent.ts) y de Whisper (transcripción de audio, estimado por
    // duración — Whisper no cobra por token, ver src/observabilidad/costoLlm.ts).
    tokensEntrada: integer("tokens_entrada").notNull().default(0),
    tokensSalida: integer("tokens_salida").notNull().default(0),
    // Costo estimado acumulado del mes, en MILLONÉSIMOS DE DÓLAR (1 unidad = USD 0,000001),
    // NUNCA en float: es un contador que se incrementa miles de veces (INSERT ... ON
    // CONFLICT DO UPDATE SET x = x + n) y un float acumularía error de redondeo turno a
    // turno. bigint porque, aunque hoy el volumen es chico, es un acumulado mensual sin
    // tope natural bajo (a diferencia de los contadores de mensajes) — más barato dejarlo
    // con margen que migrar la columna después. Dividir entre 1_000_000 para mostrar USD.
    costoEstimadoMillonesimos: bigint("costo_estimado_millonesimos", { mode: "number" }).notNull().default(0),
  },
  (t) => ({
    uqTenantMes: uniqueIndex("wa_uso_mensual_tenant_mes_uq").on(t.tenantId, t.anioMes),
  }),
).enableRLS();

// ─────────────────────────────────────────────────────────────────────────────
// Rescate de cotizaciones abandonadas (Carril D, Fase 1 - 1.1). El CRUD (crear al
// cotizar, cerrar al agendar) va por el Repositorio (memoria y Drizzle, ver
// src/types.ts) para que aparezca en el dashboard y en el seed de demo sin DB. El
// ENVÍO de los toques (toque1/toque2) es una mini-cola INDEPENDIENTE de wa_jobs
// (src/rescate/), mismo patrón que wa_campania_envios (C3.2): FOR UPDATE SKIP
// LOCKED sobre esta misma tabla, con su propio worker/throttling.
// ─────────────────────────────────────────────────────────────────────────────
export const waCotizaciones = pgTable(
  "wa_cotizaciones",
  {
    id: id(),
    tenantId: text("tenant_id").notNull(),
    clienteWa: text("cliente_wa").notNull(),
    servicioId: text("servicio_id").notNull(),
    monto: integer("monto").notNull(),
    // pendiente → toque1 → toque2 (máx. 2 toques) | agendada | recuperada | descartada | opt_out
    estado: text("estado").notNull().default("pendiente"),
    citaId: text("cita_id"),
    montoRecuperado: integer("monto_recuperado"),
    creadaEn: timestamp("creada_en", { withTimezone: true }).notNull().defaultNow(),
    toque1En: timestamp("toque1_en", { withTimezone: true }),
    toque2En: timestamp("toque2_en", { withTimezone: true }),
  },
  (t) => ({
    // Índice que usa la mini-cola al reclamar: candidatos a un toque, por tenant y antigüedad.
    idxClaim: index("wa_cotizaciones_claim_idx").on(t.tenantId, t.estado, t.creadaEn),
    idxCliente: index("wa_cotizaciones_cliente_idx").on(t.tenantId, t.clienteWa),
  }),
).enableRLS();

// ─────────────────────────────────────────────────────────────────────────────
// Motor de reseñas de Google completo (Carril D, Fase 1 - 1.3). Extiende el
// post-servicio de C3.1 (que solo mandaba 2 botones y un link, sin registrar
// nada): con plan Pro, el seguimiento pasa a 3 botones (Excelente/Bien/Mal) y
// se registra en wa_seguimientos para el contador del dashboard. El plan Básico
// sigue con el flujo legacy de 2 botones (sin fila acá, ver reminders/scheduler.ts).
// snapshot_reputacion es el histórico diario de Places API (rating + total de
// reseñas) para graficar la evolución — job independiente, 1 fila/tenant/día.
// ─────────────────────────────────────────────────────────────────────────────
export const waSeguimientos = pgTable(
  "wa_seguimientos",
  {
    id: id(),
    citaId: text("cita_id")
      .notNull()
      .references(() => waCitas.id, { onDelete: "cascade" }),
    tenantId: text("tenant_id").notNull(),
    enviadoEn: timestamp("enviado_en", { withTimezone: true }).notNull().defaultNow(),
    // 'positivo' | 'neutral' | 'negativo' | null (todavía no respondió).
    sentimiento: text("sentimiento"),
    resenaSolicitada: boolean("resena_solicitada").notNull().default(false),
    respuestaTexto: text("respuesta_texto"),
  },
  (t) => ({
    // Un seguimiento por cita: el scheduler no debe crear dos filas para la misma cita.
    uqCita: uniqueIndex("wa_seguimientos_cita_uq").on(t.citaId),
    idxTenant: index("wa_seguimientos_tenant_idx").on(t.tenantId),
  }),
).enableRLS();

export const waSnapshotReputacion = pgTable(
  "wa_snapshot_reputacion",
  {
    id: id(),
    tenantId: text("tenant_id").notNull(),
    fecha: text("fecha").notNull(), // "YYYY-MM-DD"
    rating: numeric("rating", { precision: 3, scale: 2, mode: "number" }).notNull(),
    totalResenas: integer("total_resenas").notNull(),
    creadaEn: timestamp("creada_en", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // Idempotencia: el job diario no duplica el snapshot si corre dos veces el mismo día.
    uqTenantFecha: uniqueIndex("wa_snapshot_reputacion_tenant_fecha_uq").on(t.tenantId, t.fecha),
  }),
).enableRLS();

// ─────────────────────────────────────────────────────────────────────────────
// Lease de liderazgo para schedulers tipo cron (ROADMAP F6). Recordatorios,
// reputación y reporte de métricas son loops periódicos (`iniciarCicloSinSolape`,
// F12) que recorren TODOS los tenants — a diferencia de los workers de cola
// (`wa_jobs`), no tienen un claim atómico por unidad de trabajo. Al separar
// procesos web/worker (F6), N réplicas con ROL=worker correrían el mismo ciclo
// a la vez sin esta tabla. Una fila por scheduler (`nombre`); el titular vigente
// se decide con una única sentencia atómica (`INSERT ... ON CONFLICT ... WHERE`,
// ver `src/red/liderazgo.ts`) — mismo estilo SQL-puro que el resto del repo
// (FOR UPDATE SKIP LOCKED / UPDATE...WHERE...IS NULL), sin advisory locks de
// sesión (no confiables contra el pooler de Supabase en modo transacción).
// ─────────────────────────────────────────────────────────────────────────────
export const waLideres = pgTable("wa_lideres", {
  // Clave del scheduler: "recordatorios" | "reputacion" | "metricas".
  nombre: text("nombre").primaryKey(),
  // Id random del proceso que tiene el lease ahora mismo (crypto.randomUUID(),
  // generado una vez por proceso). No es un usuario ni un tenant.
  titular: text("titular").notNull(),
  // Hasta cuándo es válido el lease. Vencido → cualquier otro titular puede
  // tomarlo en su próximo intento; no hace falta heartbeat ni quorum aparte.
  venceEn: timestamp("vence_en", { withTimezone: true }).notNull(),
}).enableRLS();

// ─────────────────────────────────────────────────────────────────────────────
// Registro auditable de operaciones de PLATAFORMA (revisión pre-venta 2026-10):
// pausar/reactivar un negocio por falta de pago, reconectar su WhatsApp, borrar
// los datos de un cliente final (derecho de supresión, Ley 8968) y dar de baja
// un negocio. A diferencia de `wa_tenants_historial` (F15) —que versiona la
// config de "Mi negocio", se poda a 30 versiones y se puede RESTAURAR— esto es
// un log append-only: no se poda, no se restaura y no se borra con la baja del
// tenant (es el rastro de que la baja ocurrió). Por eso tampoco está en el
// catálogo de `config/offboarding.ts`.
//
// `detalle` NUNCA guarda datos personales ni secretos: para un borrado de cliente
// se guardan conteos e ids internos (no el teléfono, ni el nombre, ni mensajes);
// para una reconexión, el phone_number_id nuevo pero jamás el token.
// ─────────────────────────────────────────────────────────────────────────────
export const waAuditoria = pgTable(
  "wa_auditoria",
  {
    id: id(),
    tenantId: text("tenant_id").notNull(),
    // "pausar" | "reactivar" | "reconectar_whatsapp" | "borrar_cliente" | "baja_tenant" | "baja_storage_pendiente"
    accion: text("accion").notNull(),
    // Quién lo hizo: "superadmin:<usuario>" o "usuario:<id de wa_usuarios>".
    actor: text("actor").notNull(),
    detalle: jsonb("detalle").$type<Record<string, unknown>>().notNull().default({}),
    creadoEn: timestamp("creado_en", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    idxTenant: index("wa_auditoria_tenant_idx").on(t.tenantId, t.creadoEn),
  }),
).enableRLS();

export const schema = {
  waConversaciones,
  waMensajes,
  waCitas,
  waEventosCalidad,
  waPushSubs,
  waTenants,
  waUsuarios,
  waJobs,
  waWebhooksCrudos,
  waCampanias,
  waCampaniaEnvios,
  waUsoMensual,
  waCotizaciones,
  waSeguimientos,
  waSnapshotReputacion,
  waLideres,
  waAuditoria,
};
