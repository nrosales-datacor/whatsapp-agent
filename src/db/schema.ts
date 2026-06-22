import { pgTable, text, timestamp, integer, boolean, index, uniqueIndex } from "drizzle-orm/pg-core";
import { randomUUID } from "node:crypto";

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
    estado: text("estado").notNull().default("agendada"),
    creadaEn: timestamp("creada_en", { withTimezone: true }).notNull().defaultNow(),
    // Precio cotizado al agendar (colones). Para métricas de ingresos. Puede ser null.
    precio: integer("precio"),
    // Integración con Google Calendar y recordatorios por WhatsApp.
    gcalEventId: text("gcal_event_id"),
    recordatorioDiaAntesEn: timestamp("recordatorio_dia_antes_en", { withTimezone: true }),
    recordatorioMismoDiaEn: timestamp("recordatorio_mismo_dia_en", { withTimezone: true }),
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

export const schema = { waConversaciones, waMensajes, waCitas, waEventosCalidad, waPushSubs };
