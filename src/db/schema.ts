import { pgTable, text, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
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
      .references(() => waConversaciones.id),
    rol: text("rol").notNull(), // "user" | "assistant"
    contenido: text("contenido").notNull(),
    creadoEn: timestamp("creado_en", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    idxConv: index("wa_msg_conv_idx").on(t.conversacionId),
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

export const schema = { waConversaciones, waMensajes, waCitas, waEventosCalidad };
