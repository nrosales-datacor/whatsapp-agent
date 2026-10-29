import { sql } from "drizzle-orm";
import { bigint, boolean, check, index, integer, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { instant, oneOf, timestamps, uuidPk } from "../../platform/db/columns";
import { tenantPolicy } from "../../platform/db/rls";
import { businesses, locations } from "../business/schema";
import { clients } from "../clients/schema";
import { appointments } from "../scheduling/schema";
import { users } from "../team/schema";

// ─────────────────────────────────────────────────────────────────────────────
// Módulo sales: métodos de pago y pagos registrados (PLAN-GESTION.md §0 y §4). Solo se
// REGISTRAN pagos y señas: sin cobro en línea ni factura electrónica en v1.
//   • Saldo de una cita = appointments.total_cents − pagos de la cita (las devoluciones
//     restan).
//   • Caja = resumen del día por método, sin apertura ni cierre.
// Los pagos son registro contable: sus FKs a sucursal, cliente, cita y método son
// NO ACTION (ver el comentario de scheduling/schema.ts).
// ─────────────────────────────────────────────────────────────────────────────

/** `deposit` = seña (antes de la cita), `payment` = cobro, `refund` = devolución. */
export const PAYMENT_KINDS = ["deposit", "payment", "refund"] as const;
export type PaymentKind = (typeof PAYMENT_KINDS)[number];

const businessId = () =>
  uuid("business_id")
    .notNull()
    .references(() => businesses.id, { onDelete: "cascade" });

// Precargados al crear el negocio: efectivo, SINPE, tarjeta, transferencia. Se
// desactivan en vez de borrarse (los pagos los referencian).
export const paymentMethods = pgTable(
  "payment_methods",
  {
    id: uuidPk(),
    businessId: businessId(),
    name: text("name").notNull(),
    active: boolean("active").notNull().default(true),
    position: integer("position").notNull().default(0),
    ...timestamps(),
  },
  (t) => [uniqueIndex("payment_methods_business_name_uq").on(t.businessId, t.name), tenantPolicy()],
).enableRLS();

export const payments = pgTable(
  "payments",
  {
    id: uuidPk(),
    businessId: businessId(),
    locationId: uuid("location_id")
      .notNull()
      .references(() => locations.id),
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id),
    // null = pago suelto, sin cita (p. ej. una seña antes de agendar).
    appointmentId: uuid("appointment_id").references(() => appointments.id),
    kind: text("kind").notNull().default("payment"),
    // Siempre positivo; una devolución es `kind = 'refund'` (resta en saldos y caja).
    amountCents: bigint("amount_cents", { mode: "number" }).notNull(),
    paymentMethodId: uuid("payment_method_id")
      .notNull()
      .references(() => paymentMethods.id),
    // Quién lo registró (null = sistema, o el usuario ya no existe).
    recordedBy: uuid("recorded_by").references(() => users.id, { onDelete: "set null" }),
    // Cuándo se cobró (puede ser anterior a cuándo se registró). Manda en caja y reportes.
    paidAt: instant("paid_at").notNull().defaultNow(),
    note: text("note"),
    ...timestamps(),
  },
  (t) => [
    // Caja del día y reportes de ingresos por sucursal.
    index("payments_location_paid_idx").on(t.businessId, t.locationId, t.paidAt),
    // Ingresos del negocio entero por rango.
    index("payments_business_paid_idx").on(t.businessId, t.paidAt),
    // Saldo de una cita.
    index("payments_appointment_idx").on(t.appointmentId),
    // Historial de pagos del cliente (ficha).
    index("payments_client_paid_idx").on(t.clientId, t.paidAt),
    check("payments_kind_check", oneOf(t.kind, PAYMENT_KINDS)),
    check("payments_amount_check", sql`${t.amountCents} > 0`),
    tenantPolicy(),
  ],
).enableRLS();

export type PaymentMethod = typeof paymentMethods.$inferSelect;
export type NewPaymentMethod = typeof paymentMethods.$inferInsert;
export type Payment = typeof payments.$inferSelect;
export type NewPayment = typeof payments.$inferInsert;
