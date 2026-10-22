import { sql } from "drizzle-orm";
import { bigint, boolean, check, date, index, jsonb, pgTable, text, unique, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { instant, oneOf, timestamps, uuidPk } from "../../platform/db/columns";
import { tenantPolicy } from "../../platform/db/rls";
import { businesses, locations } from "../business/schema";
import { serviceCategories, services } from "../catalog/schema";
import { appointments, appointmentServices } from "../scheduling/schema";
import { staff, users } from "../team/schema";

// ─────────────────────────────────────────────────────────────────────────────
// Módulo commissions: reglas, movimientos y liquidaciones (PLAN-GESTION.md §4).
//
// La comisión se genera al completar la cita, POR LÍNEA de servicio, sobre lo cobrado.
// Gana la regla más específica: profesional + servicio → servicio → categoría →
// profesional → regla general del negocio (todas las columnas de alcance en null). Cada
// movimiento copia la regla que se aplicó (`rule`), así cambiar una regla no reescribe lo
// ya calculado.
// ─────────────────────────────────────────────────────────────────────────────

/** `percent`: `value` en puntos básicos (1500 = 15 %). `fixed`: `value` en céntimos por línea. */
export const COMMISSION_RULE_KINDS = ["percent", "fixed"] as const;
export type CommissionRuleKind = (typeof COMMISSION_RULE_KINDS)[number];

export const COMMISSION_ENTRY_STATUSES = ["pending", "paid"] as const;
export type CommissionEntryStatus = (typeof COMMISSION_ENTRY_STATUSES)[number];

/** Copia de la regla aplicada, guardada en cada movimiento. */
export interface AppliedCommissionRule {
  ruleId: string | null;
  kind: CommissionRuleKind;
  value: number;
}

const businessId = () =>
  uuid("business_id")
    .notNull()
    .references(() => businesses.id, { onDelete: "cascade" });

export const commissionRules = pgTable(
  "commission_rules",
  {
    id: uuidPk(),
    businessId: businessId(),
    // Alcance (todas null = regla general del negocio). Servicio y categoría se excluyen.
    staffId: uuid("staff_id").references(() => staff.id, { onDelete: "cascade" }),
    serviceId: uuid("service_id").references(() => services.id, { onDelete: "cascade" }),
    categoryId: uuid("category_id").references(() => serviceCategories.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    value: bigint("value", { mode: "number" }).notNull(),
    active: boolean("active").notNull().default(true),
    ...timestamps(),
  },
  (t) => [
    // Una sola regla por combinación de alcance (NULLS NOT DISTINCT: dos reglas generales
    // del mismo negocio también chocan).
    unique("commission_rules_scope_uq").on(t.businessId, t.staffId, t.serviceId, t.categoryId).nullsNotDistinct(),
    check("commission_rules_kind_check", oneOf(t.kind, COMMISSION_RULE_KINDS)),
    check("commission_rules_value_check", sql`${t.value} >= 0 AND (${t.kind} <> 'percent' OR ${t.value} <= 10000)`),
    check("commission_rules_scope_check", sql`${t.serviceId} IS NULL OR ${t.categoryId} IS NULL`),
    tenantPolicy(),
  ],
).enableRLS();

// ─────────────────────────────────────────────────────────────────────────────
// Liquidaciones: el pago de las comisiones de un profesional por un período.
// ─────────────────────────────────────────────────────────────────────────────
export const payouts = pgTable(
  "payouts",
  {
    id: uuidPk(),
    businessId: businessId(),
    staffId: uuid("staff_id")
      .notNull()
      .references(() => staff.id),
    periodStart: date("period_start").notNull(),
    periodEnd: date("period_end").notNull(),
    totalCents: bigint("total_cents", { mode: "number" }).notNull(),
    paidAt: instant("paid_at"),
    paidBy: uuid("paid_by").references(() => users.id, { onDelete: "set null" }),
    note: text("note"),
    ...timestamps(),
  },
  (t) => [
    index("payouts_staff_period_idx").on(t.staffId, t.periodStart),
    check("payouts_period_check", sql`${t.periodEnd} >= ${t.periodStart}`),
    check("payouts_total_check", sql`${t.totalCents} >= 0`),
    tenantPolicy(),
  ],
).enableRLS();

// ─────────────────────────────────────────────────────────────────────────────
// Movimientos: la comisión de UNA línea de servicio para el profesional que la atendió,
// sobre lo cobrado de esa línea (lo cobrado de la cita prorrateado por precio).
//
//   • Abierto (`payout_id` null): se recalcula con cada cobro o devolución de la cita.
//     Hay a lo sumo UNO por línea (índice único parcial).
//   • Liquidado (`payout_id` puesto): entró en una liquidación y NO se toca más; al pagarse
//     la liquidación pasa a `paid`. Si después de liquidar se cobra el resto o se devuelve
//     algo, la diferencia va en un movimiento abierto nuevo de la misma línea (un ajuste,
//     negativo si fue una devolución) que entra en la liquidación siguiente.
//   • `earned_at`: cuándo se ganó (el inicio de la cita; en un ajuste, cuándo se generó).
//     Ordena "Mis comisiones" y decide qué entra en una liquidación.
//
// NO ACTION hacia la línea, la cita y el profesional: no se pierde una comisión porque se
// editó la cita (las líneas de una cita completada no cambian).
// ─────────────────────────────────────────────────────────────────────────────
export const commissionEntries = pgTable(
  "commission_entries",
  {
    id: uuidPk(),
    businessId: businessId(),
    staffId: uuid("staff_id")
      .notNull()
      .references(() => staff.id),
    appointmentServiceId: uuid("appointment_service_id")
      .notNull()
      .references(() => appointmentServices.id),
    // Copias de la cita (filtros por sucursal y período sin ir a la agenda).
    appointmentId: uuid("appointment_id")
      .notNull()
      .references(() => appointments.id),
    locationId: uuid("location_id")
      .notNull()
      .references(() => locations.id),
    earnedAt: instant("earned_at").notNull(),
    // Lo cobrado de la línea sobre lo que se calcula (en un ajuste, la diferencia; puede
    // ser negativa, igual que el monto).
    baseCents: bigint("base_cents", { mode: "number" }).notNull(),
    amountCents: bigint("amount_cents", { mode: "number" }).notNull(),
    rule: jsonb("rule").$type<AppliedCommissionRule>().notNull(),
    status: text("status").notNull().default("pending"),
    // NO ACTION: anular una liquidación es devolver sus movimientos a `pending` primero.
    payoutId: uuid("payout_id").references(() => payouts.id),
    ...timestamps(),
  },
  (t) => [
    // Un movimiento ABIERTO por línea: recalcular es actualizar, no duplicar.
    uniqueIndex("commission_entries_open_line_uq").on(t.appointmentServiceId).where(sql`${t.payoutId} IS NULL`),
    // Todos los movimientos de una línea (recálculo: lo ya liquidado).
    index("commission_entries_line_idx").on(t.appointmentServiceId),
    // "Mis comisiones" y la liquidación: lo de un profesional por período.
    index("commission_entries_staff_earned_idx").on(t.businessId, t.staffId, t.earnedAt),
    // Resumen del negocio por período.
    index("commission_entries_business_earned_idx").on(t.businessId, t.earnedAt),
    index("commission_entries_payout_idx").on(t.payoutId),
    check("commission_entries_status_check", oneOf(t.status, COMMISSION_ENTRY_STATUSES)),
    check("commission_entries_paid_check", sql`${t.status} <> 'paid' OR ${t.payoutId} IS NOT NULL`),
    tenantPolicy(),
  ],
).enableRLS();

export type CommissionRule = typeof commissionRules.$inferSelect;
export type NewCommissionRule = typeof commissionRules.$inferInsert;
export type Payout = typeof payouts.$inferSelect;
export type NewPayout = typeof payouts.$inferInsert;
export type CommissionEntry = typeof commissionEntries.$inferSelect;
export type NewCommissionEntry = typeof commissionEntries.$inferInsert;
