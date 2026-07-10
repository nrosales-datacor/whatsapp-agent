import { pgTable, text, timestamp, integer, boolean, jsonb, index, uniqueIndex } from "drizzle-orm/pg-core";
import { randomUUID } from "node:crypto";
import type { Bloqueo, HorarioDia, KnowledgeBase, PendienteSerializado, Service } from "../types";

// ─────────────────────────────────────────────────────────────────────────────
// Esquema Drizzle del agente de WhatsApp.
// Tablas prefijadas con "wa_" para no chocar con las tablas existentes de @gp/db.
//
// Cómo integrarlo al monorepo:
//   1. Pegá estas tablas en tu paquete @gp/db (src/schema/…) y exportálas.
//   2. Como son multi-tenant (columna tenant_id), agregá políticas RLS en tu
//      flujo `rls/apply.ts`, igual que tus otras tablas.
// ─────────────────────────────────────────────────────────────────────────────

const id = () => text("id").primaryKey().$defaultFn(() => randomUUID());

export const waConversaciones = pgTable(
  "wa_conversaciones",
  {
    id: id(),
    tenantId: text("tenant_id").notNull(),
    clienteWa: text("cliente_wa").notNull(),
    optInEn: timestamp("opt_in_en", { withTimezone: true }),
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
  },
  (t) => ({
    uq: uniqueIndex("wa_conv_tenant_cliente_uq").on(t.tenantId, t.clienteWa),
    idxTenant: index("wa_conv_tenant_idx").on(t.tenantId),
  }),
);

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
    // Foto adjunta del cliente (C1.5): data URL ("data:image/...;base64,...") para
    // mostrarla en el panel. Se completa en fase 2, después de descargarla de Meta.
    mediaUrl: text("media_url"),
    mediaTipo: text("media_tipo"), // "imagen" | null
  },
  (t) => ({
    idxConv: index("wa_msg_conv_idx").on(t.conversacionId),
    uqWaId: uniqueIndex("wa_msg_waid_uq").on(t.waMessageId),
  }),
);

export const waCitas = pgTable(
  "wa_citas",
  {
    id: id(),
    tenantId: text("tenant_id").notNull(),
    clienteWa: text("cliente_wa").notNull(),
    clienteNombre: text("cliente_nombre").notNull(),
    servicioId: text("servicio_id").notNull(),
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
  },
  (t) => ({
    idxTenantFecha: index("wa_citas_tenant_fecha_idx").on(t.tenantId, t.fecha),
  }),
);

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
);

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
);

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
    // Link para pedir reseña de Google (Maps / "Escribir reseña"), usado en el
    // seguimiento post-servicio (C3.1). null = sin configurar (no se pide reseña).
    linkResenas: text("link_resenas"),
    activo: boolean("activo").notNull().default(true),
    creadoEn: timestamp("creado_en", { withTimezone: true }).notNull().defaultNow(),
    actualizadoEn: timestamp("actualizado_en", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uqPnid: uniqueIndex("wa_tenants_pnid_uq").on(t.phoneNumberId),
  }),
);

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
  },
  (t) => ({
    uqUsuario: uniqueIndex("wa_usuarios_usuario_uq").on(t.usuario),
    idxTenant: index("wa_usuarios_tenant_idx").on(t.tenantId),
  }),
);

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
);

export const schema = { waConversaciones, waMensajes, waCitas, waEventosCalidad, waPushSubs, waTenants, waUsuarios, waJobs };
