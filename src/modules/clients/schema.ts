import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { instant, oneOf, timestamps, uuidPk } from "../../platform/db/columns";
import { tenantPolicy } from "../../platform/db/rls";
import { businesses, locations } from "../business/schema";
import { staff } from "../team/schema";

// ─────────────────────────────────────────────────────────────────────────────
// Módulo clients: el cliente es la entidad raíz del CRM (PLAN-GESTION.md §1 y §4). Ya no
// es "el teléfono de una conversación": existe sin WhatsApp, y la conversación (módulo
// whatsapp) le pertenece a él.
//
// El ESTADO del cliente (new / active / vip / at_risk / inactive) no se guarda: se calcula
// al consultar con la caché de abajo (visitas, última visita, gasto) y las reglas del
// negocio (`businesses.client_status_rules`). La caché la mantiene el servicio que
// completa citas y registra pagos, en la misma transacción.
// ─────────────────────────────────────────────────────────────────────────────

export const CLIENT_CHANNELS = ["whatsapp", "email"] as const;
export type ClientChannel = (typeof CLIENT_CHANNELS)[number];

export const clients = pgTable(
  "clients",
  {
    id: uuidPk(),
    businessId: uuid("business_id")
      .notNull()
      .references(() => businesses.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    // E.164 ("+50688887777"), único por negocio. Nullable: un cliente de mostrador puede
    // no dar teléfono (varios NULL no chocan en el índice único).
    phone: text("phone"),
    email: text("email"),
    birthDate: date("birth_date"),
    // Responsable (p. ej. de un menor en dental): otro cliente del mismo negocio.
    guardianId: uuid("guardian_id").references((): AnyPgColumn => clients.id, { onDelete: "set null" }),
    notes: text("notes"),
    tags: jsonb("tags").$type<string[]>().notNull().default([]),
    // De dónde llegó (texto libre: "Instagram", "referido", "importación"…).
    source: text("source"),
    // Valores de los campos personalizados (definiciones en `custom_fields`).
    customData: jsonb("custom_data").$type<Record<string, unknown>>().notNull().default({}),
    preferredLocationId: uuid("preferred_location_id").references(() => locations.id, { onDelete: "set null" }),
    preferredStaffId: uuid("preferred_staff_id").references(() => staff.id, { onDelete: "set null" }),
    // Canal preferido para recordatorios (null = el default del negocio).
    preferredChannel: text("preferred_channel"),
    // VIP manual, además del VIP que sale de las reglas.
    vip: boolean("vip").notNull().default(false),
    // Marketing (campañas): consentimiento EXPLÍCITO y baja. Las campañas solo van a quien
    // consintió y no pidió la baja después. No afecta recordatorios ni avisos de servicio.
    marketingConsentAt: instant("marketing_consent_at"),
    marketingOptOutAt: instant("marketing_opt_out_at"),
    // Cuándo se le preguntó por última vez (para no insistir).
    marketingConsentRequestedAt: instant("marketing_consent_requested_at"),
    // Caché para el estado y los reportes (la mantiene scheduling/sales).
    visitCount: integer("visit_count").notNull().default(0),
    firstVisitAt: instant("first_visit_at"),
    lastVisitAt: instant("last_visit_at"),
    totalSpentCents: bigint("total_spent_cents", { mode: "number" }).notNull().default(0),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("clients_business_phone_uq").on(t.businessId, t.phone),
    // Búsqueda por nombre (Ctrl+K) y listados ordenados.
    index("clients_business_name_idx").on(t.businessId, t.name),
    // Segmentos por recencia: en riesgo, inactivos, campañas.
    index("clients_business_last_visit_idx").on(t.businessId, t.lastVisitAt),
    index("clients_business_email_idx").on(t.businessId, t.email),
    check("clients_phone_check", sql`${t.phone} ~ '^\\+[1-9][0-9]{6,14}$'`),
    check("clients_preferred_channel_check", oneOf(t.preferredChannel, CLIENT_CHANNELS)),
    check("clients_guardian_check", sql`${t.guardianId} <> ${t.id}`),
    tenantPolicy(),
  ],
).enableRLS();

export type Client = typeof clients.$inferSelect;
export type NewClient = typeof clients.$inferInsert;
