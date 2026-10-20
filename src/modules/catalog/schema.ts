import { sql } from "drizzle-orm";
import { bigint, boolean, check, index, integer, pgTable, primaryKey, text, uuid } from "drizzle-orm/pg-core";
import { instant, timestamps, uuidPk } from "../../platform/db/columns";
import { tenantPolicy } from "../../platform/db/rls";
import { businesses, locations } from "../business/schema";
import { staff } from "../team/schema";

// ─────────────────────────────────────────────────────────────────────────────
// Módulo catalog: categorías y servicios, en qué sucursales se ofrece cada uno y qué
// profesional hace qué (con precio y duración propios si difieren: senior vs. junior).
// PLAN-GESTION.md §3 y §4. Montos en céntimos de la moneda del negocio.
//
// Los servicios se desactivan en vez de borrarse: las líneas de las citas copian nombre,
// duración y precio, así que el histórico no depende de que el servicio siga existiendo.
// ─────────────────────────────────────────────────────────────────────────────

const businessId = () =>
  uuid("business_id")
    .notNull()
    .references(() => businesses.id, { onDelete: "cascade" });

export const serviceCategories = pgTable(
  "service_categories",
  {
    id: uuidPk(),
    businessId: businessId(),
    name: text("name").notNull(),
    position: integer("position").notNull().default(0),
    ...timestamps(),
  },
  (t) => [index("service_categories_business_idx").on(t.businessId, t.position), tenantPolicy()],
).enableRLS();

export const services = pgTable(
  "services",
  {
    id: uuidPk(),
    businessId: businessId(),
    // Sin categoría = "Otros". SET NULL: borrar una categoría no borra sus servicios.
    categoryId: uuid("category_id").references(() => serviceCategories.id, { onDelete: "set null" }),
    name: text("name").notNull(),
    description: text("description"),
    durationMin: integer("duration_min").notNull(),
    // Limpieza/preparación DESPUÉS del servicio (dental, estética): ocupa al profesional
    // pero no se le muestra al cliente como parte de la cita.
    bufferMin: integer("buffer_min").notNull().default(0),
    // Con `variable_price`, es el precio "desde" (se cotiza según el caso).
    priceCents: bigint("price_cents", { mode: "number" }).notNull().default(0),
    variablePrice: boolean("variable_price").notNull().default(false),
    // false = solo lo agenda el negocio (panel), no el agente ni la reserva web.
    onlineBooking: boolean("online_booking").notNull().default(true),
    active: boolean("active").notNull().default(true),
    position: integer("position").notNull().default(0),
    ...timestamps(),
  },
  (t) => [
    index("services_business_idx").on(t.businessId, t.categoryId, t.position),
    check("services_duration_check", sql`${t.durationMin} > 0`),
    check("services_buffer_check", sql`${t.bufferMin} >= 0`),
    check("services_price_check", sql`${t.priceCents} >= 0`),
    tenantPolicy(),
  ],
).enableRLS();

// ─────────────────────────────────────────────────────────────────────────────
// En qué sucursales se ofrece un servicio. SIN filas = en todas (mismo criterio que
// membership_locations): el negocio de una sola sucursal no tiene que cargar nada.
// ─────────────────────────────────────────────────────────────────────────────
export const serviceLocations = pgTable(
  "service_locations",
  {
    serviceId: uuid("service_id")
      .notNull()
      .references(() => services.id, { onDelete: "cascade" }),
    locationId: uuid("location_id")
      .notNull()
      .references(() => locations.id, { onDelete: "cascade" }),
    businessId: businessId(),
    createdAt: instant("created_at").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.serviceId, t.locationId] }),
    index("service_locations_location_idx").on(t.locationId),
    tenantPolicy(),
  ],
).enableRLS();

// ─────────────────────────────────────────────────────────────────────────────
// Qué servicios hace cada profesional, con precio y duración propios opcionales (null =
// los del servicio). Un profesional SIN filas hace todos los servicios agendables (el
// dueño que solo carga nombres no tiene que configurar nada más).
// ─────────────────────────────────────────────────────────────────────────────
export const staffServices = pgTable(
  "staff_services",
  {
    staffId: uuid("staff_id")
      .notNull()
      .references(() => staff.id, { onDelete: "cascade" }),
    serviceId: uuid("service_id")
      .notNull()
      .references(() => services.id, { onDelete: "cascade" }),
    businessId: businessId(),
    priceCents: bigint("price_cents", { mode: "number" }),
    durationMin: integer("duration_min"),
    ...timestamps(),
  },
  (t) => [
    primaryKey({ columns: [t.staffId, t.serviceId] }),
    // "¿Quién hace este servicio?" (disponibilidad del agente y de la agenda).
    index("staff_services_service_idx").on(t.serviceId),
    check("staff_services_price_check", sql`${t.priceCents} >= 0`),
    check("staff_services_duration_check", sql`${t.durationMin} > 0`),
    tenantPolicy(),
  ],
).enableRLS();

export type ServiceCategory = typeof serviceCategories.$inferSelect;
export type NewServiceCategory = typeof serviceCategories.$inferInsert;
export type Service = typeof services.$inferSelect;
export type NewService = typeof services.$inferInsert;
export type ServiceLocation = typeof serviceLocations.$inferSelect;
export type NewServiceLocation = typeof serviceLocations.$inferInsert;
export type StaffService = typeof staffServices.$inferSelect;
export type NewStaffService = typeof staffServices.$inferInsert;
