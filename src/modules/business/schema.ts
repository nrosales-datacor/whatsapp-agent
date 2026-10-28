import { sql } from "drizzle-orm";
import { boolean, check, index, integer, jsonb, pgTable, smallint, text, time, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { instant, oneOf, timestamps, uuidPk } from "../../platform/db/columns";
import { tenantPolicy } from "../../platform/db/rls";
import {
  DEFAULT_REMINDER_CHANNELS,
  type Branding,
  type ClientStatusRules,
  type ExtraModules,
  type ReminderChannel,
  type Terminology,
} from "./settings";

// ─────────────────────────────────────────────────────────────────────────────
// Módulo business: el negocio (tenant), sus sucursales con su horario y las definiciones
// de campos personalizados (PLAN-GESTION.md §3 y §4).
//
// Toda tabla de negocio de cualquier módulo lleva `business_id` con FK a `businesses`
// (ON DELETE CASCADE: dar de baja un negocio borra todos sus datos) y `tenantPolicy()`.
// Las tablas hijas copian el `business_id` del padre para que la política RLS no necesite
// un JOIN (mismo criterio que el esquema viejo con los mensajes).
// ─────────────────────────────────────────────────────────────────────────────

export const PLANS = ["basic", "pro"] as const;
export type Plan = (typeof PLANS)[number];

/** `paused`: sin servicio (p. ej. falta de pago), con los datos intactos. `closed`: dado de baja. */
export const BUSINESS_STATUSES = ["active", "paused", "closed"] as const;
export type BusinessStatus = (typeof BUSINESS_STATUSES)[number];

/**
 * Estado del cobro manual (PROCESO-COBRO-MANUAL.md) que lleva el superadmin: prueba, al
 * día, atrasado o cancelado. Es informativo: lo que corta el servicio es `status = paused`.
 */
export const BILLING_STATUSES = ["trial", "active", "past_due", "cancelled"] as const;
export type BillingStatus = (typeof BILLING_STATUSES)[number];

export const CUSTOM_FIELD_ENTITIES = ["client", "appointment"] as const;
export type CustomFieldEntity = (typeof CUSTOM_FIELD_ENTITIES)[number];

export const CUSTOM_FIELD_TYPES = ["text", "long_text", "number", "date", "boolean", "select", "multi_select"] as const;
export type CustomFieldType = (typeof CUSTOM_FIELD_TYPES)[number];

/** `business_id` estándar de una tabla hija de un negocio. */
const businessId = () =>
  uuid("business_id")
    .notNull()
    .references(() => businesses.id, { onDelete: "cascade" });

// ─────────────────────────────────────────────────────────────────────────────
// El negocio. Su política compara la propia `id` (no hay `business_id`): con el contexto
// de un negocio solo se ve esa fila. Crear o listar negocios es del superadmin
// (withSystem).
// ─────────────────────────────────────────────────────────────────────────────
export const businesses = pgTable(
  "businesses",
  {
    id: uuidPk(),
    // Identificador legible y estable (URLs, soporte). Único en toda la plataforma.
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    // Rubro: el nombre de la plantilla con la que nació (dental, aesthetics, nails,
    // generic…). Sin CHECK a propósito: sumar un rubro es sumar un JSON en
    // src/modules/business/templates/, sin migración (§3). Lo valida la app.
    industry: text("industry").notNull().default("generic"),
    plan: text("plan").notNull().default("basic"),
    extraModules: jsonb("extra_modules").$type<ExtraModules>().notNull().default({}),
    status: text("status").notNull().default("active"),
    billingStatus: text("billing_status").notNull().default("trial"),
    // ISO 4217 (montos en céntimos de esta moneda) e ISO 3166-1 alfa-2.
    currency: text("currency").notNull().default("CRC"),
    country: text("country").notNull().default("CR"),
    // Zona horaria por defecto: la de las sucursales nuevas y la de los reportes del
    // negocio entero ("hoy" de todas las sucursales). Cada sucursal tiene la suya.
    timezone: text("timezone").notNull().default("America/Costa_Rica"),
    // Configuración parcial: lo que no está, sale de los defaults de ./settings.ts.
    terminology: jsonb("terminology").$type<Partial<Terminology>>().notNull().default({}),
    clientStatusRules: jsonb("client_status_rules").$type<Partial<ClientStatusRules>>().notNull().default({}),
    // Canales activos de recordatorio, en orden de preferencia (el primero es el default).
    reminderChannels: jsonb("reminder_channels")
      .$type<ReminderChannel[]>()
      .notNull()
      .default([...DEFAULT_REMINDER_CHANNELS]),
    branding: jsonb("branding").$type<Branding>().notNull().default({}),
    // Datos de facturación (a quién le facturamos el plan).
    legalName: text("legal_name"),
    taxId: text("tax_id"),
    billingEmail: text("billing_email"),
    // ── Cobro en línea con Stripe (I6, modules/billing). Lo escribe SOLO billing (webhook,
    // barrido de vencimientos y superadmin); null en los negocios de cobro manual. ──
    // Cliente y suscripción de Stripe del negocio (ids públicos de Stripe, no secretos).
    stripeCustomerId: text("stripe_customer_id"),
    stripeSubscriptionId: text("stripe_subscription_id"),
    // Estado crudo de la suscripción en Stripe (`active`, `past_due`, `canceled`…), para el
    // superadmin. Lo que usa el producto es `billing_status`.
    stripeSubscriptionStatus: text("stripe_subscription_status"),
    // Fin del período pagado y si la suscripción se cancela al llegar a esa fecha.
    currentPeriodEnd: instant("current_period_end"),
    cancelAtPeriodEnd: boolean("cancel_at_period_end").notNull().default(false),
    // Instante del último evento de Stripe aplicado (los eventos pueden llegar desordenados:
    // uno más viejo que este no pisa el estado).
    stripeSyncedAt: instant("stripe_synced_at"),
    // Fin de la prueba del alta self-service (null = sin vencimiento automático: los negocios
    // que da de alta el superadmin siguen con el cobro manual).
    trialEndsAt: instant("trial_ends_at"),
    // Desde cuándo está atrasado el pago (Stripe); con la gracia vencida, el barrido pausa.
    pastDueSince: instant("past_due_since"),
    // El negocio está pausado POR EL COBRO (gracia vencida, prueba vencida o suscripción
    // terminada), no por decisión del superadmin: el dueño puede entrar a pagar y, al
    // pagar, se reactiva solo.
    billingPausedAt: instant("billing_paused_at"),
    // Checklist de primeros pasos del Inicio: cuándo se descartó (null = se muestra mientras
    // no esté completa). Los negocios anteriores a la migración nacen descartados.
    onboardingDismissedAt: instant("onboarding_dismissed_at"),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("businesses_slug_uq").on(t.slug),
    uniqueIndex("businesses_stripe_customer_uq").on(t.stripeCustomerId),
    uniqueIndex("businesses_stripe_subscription_uq").on(t.stripeSubscriptionId),
    check("businesses_slug_check", sql`${t.slug} ~ '^[a-z0-9]+(-[a-z0-9]+)*$'`),
    check("businesses_plan_check", oneOf(t.plan, PLANS)),
    check("businesses_status_check", oneOf(t.status, BUSINESS_STATUSES)),
    check("businesses_billing_status_check", oneOf(t.billingStatus, BILLING_STATUSES)),
    check("businesses_currency_check", sql`${t.currency} ~ '^[A-Z]{3}$'`),
    check("businesses_country_check", sql`${t.country} ~ '^[A-Z]{2}$'`),
    check(
      "businesses_reminder_channels_check",
      sql`jsonb_typeof(${t.reminderChannels}) = 'array' AND ${t.reminderChannels} <@ '["whatsapp", "email"]'::jsonb`,
    ),
    tenantPolicy("id"),
  ],
).enableRLS();

// ─────────────────────────────────────────────────────────────────────────────
// Sucursales. Existen desde el día 1 en el modelo (el plan Básico tiene una sola). La
// sucursal es un permiso de aplicación, no de RLS (§2): el router valida que el usuario
// tenga acceso a la sucursal de cada request.
// ─────────────────────────────────────────────────────────────────────────────
export const locations = pgTable(
  "locations",
  {
    id: uuidPk(),
    businessId: businessId(),
    name: text("name").notNull(),
    address: text("address"),
    phone: text("phone"),
    // Zona IANA ("America/Costa_Rica"): la agenda y los horarios de la sucursal se
    // interpretan en esta zona.
    timezone: text("timezone").notNull(),
    active: boolean("active").notNull().default(true),
    position: integer("position").notNull().default(0),
    ...timestamps(),
  },
  (t) => [index("locations_business_idx").on(t.businessId, t.position), tenantPolicy()],
).enableRLS();

// ─────────────────────────────────────────────────────────────────────────────
// Horario semanal de atención de una sucursal. Varias filas para el mismo día = turnos
// con descanso en medio (09:00–12:00 y 13:00–18:00). Sin filas para un día = cerrado.
// `weekday`: 0 = domingo … 6 = sábado (igual que Date#getDay). Horas locales de la
// sucursal.
// ─────────────────────────────────────────────────────────────────────────────
export const locationHours = pgTable(
  "location_hours",
  {
    id: uuidPk(),
    businessId: businessId(),
    locationId: uuid("location_id")
      .notNull()
      .references(() => locations.id, { onDelete: "cascade" }),
    weekday: smallint("weekday").notNull(),
    opensAt: time("opens_at").notNull(),
    closesAt: time("closes_at").notNull(),
    ...timestamps(),
  },
  (t) => [
    index("location_hours_location_idx").on(t.locationId, t.weekday),
    check("location_hours_weekday_check", sql`${t.weekday} BETWEEN 0 AND 6`),
    check("location_hours_range_check", sql`${t.closesAt} > ${t.opensAt}`),
    tenantPolicy(),
  ],
).enableRLS();

// ─────────────────────────────────────────────────────────────────────────────
// Definiciones de campos personalizados de clientes y citas (§3): dental "alergias",
// estética "tipo de piel", uñas "forma preferida". Los VALORES viven en `custom_data`
// (jsonb) de `clients` y `appointments`, con `key` como clave, y se validan contra esta
// definición en la app.
// ─────────────────────────────────────────────────────────────────────────────
export const customFields = pgTable(
  "custom_fields",
  {
    id: uuidPk(),
    businessId: businessId(),
    entity: text("entity").notNull(),
    // Clave estable dentro de `custom_data` (snake_case). Inmutable una vez que hay datos.
    key: text("key").notNull(),
    label: text("label").notNull(),
    type: text("type").notNull(),
    // Opciones de `select` / `multi_select`; vacío para el resto.
    options: jsonb("options").$type<string[]>().notNull().default([]),
    required: boolean("required").notNull().default(false),
    position: integer("position").notNull().default(0),
    active: boolean("active").notNull().default(true),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("custom_fields_business_entity_key_uq").on(t.businessId, t.entity, t.key),
    check("custom_fields_entity_check", oneOf(t.entity, CUSTOM_FIELD_ENTITIES)),
    check("custom_fields_type_check", oneOf(t.type, CUSTOM_FIELD_TYPES)),
    check("custom_fields_key_check", sql`${t.key} ~ '^[a-z][a-z0-9_]*$'`),
    tenantPolicy(),
  ],
).enableRLS();

export type Business = typeof businesses.$inferSelect;
export type NewBusiness = typeof businesses.$inferInsert;
export type Location = typeof locations.$inferSelect;
export type NewLocation = typeof locations.$inferInsert;
export type LocationHour = typeof locationHours.$inferSelect;
export type NewLocationHour = typeof locationHours.$inferInsert;
export type CustomField = typeof customFields.$inferSelect;
export type NewCustomField = typeof customFields.$inferInsert;
