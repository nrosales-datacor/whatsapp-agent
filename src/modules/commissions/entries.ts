import { and, desc, eq, gte, inArray, isNotNull, isNull, lt, sql, type SQL } from "drizzle-orm";
import { withTenant, type Executor, type Tx } from "../../platform/db/scope";
import { getServices } from "../catalog";
import { getAppointmentCollected, prorateByPrice } from "../sales";
import { getAppointment, getAppointmentsByIds } from "../scheduling";
import { listStaff } from "../team";
import { appliedRule, listCommissionRules, resolveRule } from "./rules";
import { commissionEntries, type AppliedCommissionRule, type CommissionEntry, type CommissionEntryStatus } from "./schema";

// ─────────────────────────────────────────────────────────────────────────────
// Movimientos de comisión: cálculo SOBRE LO COBRADO, por línea de servicio.
//
// Cuándo se calcula: al completar una cita y con cada cobro o devolución de una cita
// completada. No hay ciclo entre módulos: commissions depende de scheduling (la cita y sus
// líneas) y de sales (lo cobrado), y ninguno de los dos conoce a commissions; la
// composición (src/routes.ts) les inyecta `recalculateAppointmentCommissions` como gancho
// (`onAppointmentCompleted` de la agenda y `onPaymentsChanged` de ventas), que corre en la
// MISMA transacción que la operación (si falla, no queda la cita completada ni el pago).
//
// Cómo (`recalculateAppointmentCommissions`):
//   1. Solo citas completadas. Lo cobrado neto de la cita (señas + cobros − devoluciones,
//      acotado a [0, total]) se reparte entre sus líneas en proporción al precio.
//   2. Regla de cada línea: la copia guardada en sus movimientos si ya tiene alguno (cambiar
//      una regla no reescribe lo ya calculado); si no, la más específica activa hoy
//      (./rules.ts). Sin regla, no hay comisión.
//   3. Comisión debida = % de lo cobrado de la línea, o el fijo prorrateado por la parte
//      cobrada de la línea (precio 0: el fijo entero).
//   4. Lo ya liquidado no se toca: el movimiento abierto de la línea lleva la diferencia
//      entre lo debido y lo liquidado (un ajuste si la línea ya tenía algo liquidado,
//      negativo si fue una devolución). Diferencia 0 = sin movimiento abierto.
//
// Concurrencia: un lock de transacción por cita serializa los recálculos (completar y
// cobrar a la vez no duplican el movimiento abierto; además lo frena el índice único).
// ─────────────────────────────────────────────────────────────────────────────

export interface CommissionEntryView {
  id: string;
  staffId: string;
  staff: { id: string; name: string; color: string | null } | null;
  appointmentId: string;
  appointmentServiceId: string;
  locationId: string;
  /** Cuándo se ganó (ISO): el inicio de la cita, o cuándo se generó el ajuste. */
  earnedAt: string;
  /** Inicio de la cita (ISO), si todavía se puede leer. */
  appointmentStartsAt: string | null;
  serviceName: string | null;
  clientName: string | null;
  baseCents: number;
  amountCents: number;
  rule: AppliedCommissionRule;
  status: CommissionEntryStatus;
  payoutId: string | null;
  /** Diferencia generada después de liquidar la línea (cobro tardío o devolución). */
  adjustment: boolean;
  createdAt: string;
  updatedAt: string;
}

/** Comisión debida de una línea según la regla y lo cobrado de esa línea. */
export function commissionFor(rule: AppliedCommissionRule, baseCents: number, priceCents: number): number {
  if (rule.kind === "percent") return Math.round((baseCents * rule.value) / 10_000);
  if (priceCents <= 0) return rule.value;
  return Math.round((rule.value * Math.min(Math.max(baseCents, 0), priceCents)) / priceCents);
}

async function lockAppointment(tx: Tx, appointmentId: string): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`commissions:appointment:${appointmentId}`}, 0))`);
}

/**
 * Recalcula los movimientos de comisión de una cita (ver el encabezado). Idempotente: se
 * puede llamar las veces que haga falta. Pasá la transacción de la operación que lo
 * dispara. Es el gancho que la composición inyecta en la agenda y en ventas.
 */
export async function recalculateAppointmentCommissions(
  executor: Executor,
  businessId: string,
  appointmentId: string,
  options: { now?: Date } = {},
): Promise<void> {
  const now = options.now ?? new Date();
  await withTenant(executor, businessId, async (tx) => {
    await lockAppointment(tx, appointmentId.toLowerCase());
    const appointment = await getAppointment(tx, businessId, appointmentId);
    if (!appointment || appointment.status !== "completed" || appointment.services.length === 0) return;
    const lineIds = appointment.services.map((l) => l.id);
    const existing = await tx
      .select()
      .from(commissionEntries)
      .where(and(eq(commissionEntries.businessId, businessId), inArray(commissionEntries.appointmentServiceId, lineIds)));
    const rules = await listCommissionRules(tx, businessId, { activeOnly: true });
    if (rules.length === 0 && existing.length === 0) return;

    const collected = Math.min(appointment.totalCents, Math.max(0, await getAppointmentCollected(tx, businessId, appointment.id)));
    const bases = prorateByPrice(collected, appointment.services);
    const needsCategory = rules.some((r) => r.scope === "category");
    const categoryOf = new Map<string, string | null>();
    if (needsCategory) for (const s of await getServices(tx, businessId)) categoryOf.set(s.id, s.categoryId);

    for (const [i, line] of appointment.services.entries()) {
      const entries = existing.filter((e) => e.appointmentServiceId === line.id).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
      const open = entries.find((e) => e.payoutId === null) ?? null;
      const settled = entries.filter((e) => e.payoutId !== null);
      const rule: AppliedCommissionRule | null =
        entries[0]?.rule ??
        (() => {
          const found = resolveRule(rules, {
            staffId: appointment.staffId,
            serviceId: line.serviceId,
            categoryId: line.serviceId ? (categoryOf.get(line.serviceId) ?? null) : null,
          });
          return found ? appliedRule(found) : null;
        })();
      const due = rule ? commissionFor(rule, bases[i], line.priceCents) : 0;
      const openAmount = due - settled.reduce((n, e) => n + e.amountCents, 0);
      const openBase = bases[i] - settled.reduce((n, e) => n + e.baseCents, 0);

      if (!rule || openAmount === 0) {
        if (open) await tx.delete(commissionEntries).where(eq(commissionEntries.id, open.id));
        continue;
      }
      if (open) {
        await tx
          .update(commissionEntries)
          .set({ amountCents: openAmount, baseCents: openBase, staffId: appointment.staffId, locationId: appointment.locationId })
          .where(eq(commissionEntries.id, open.id));
        continue;
      }
      await tx.insert(commissionEntries).values({
        businessId,
        staffId: appointment.staffId,
        appointmentServiceId: line.id,
        appointmentId: appointment.id,
        locationId: appointment.locationId,
        // La primera comisión de la línea es del día de la cita; un ajuste, de hoy.
        earnedAt: settled.length > 0 ? now : new Date(appointment.startsAt),
        baseCents: openBase,
        amountCents: openAmount,
        rule,
        status: "pending",
      });
    }
  });
}

// ── Lectura ─────────────────────────────────────────────────────────────────

/** Estado para filtrar: abierto (sin liquidar), en una liquidación sin pagar, o pagado. */
export const ENTRY_FILTER_STATUSES = ["open", "in_payout", "paid"] as const;
export type EntryFilterStatus = (typeof ENTRY_FILTER_STATUSES)[number];

export interface ListEntriesFilter {
  /** Ganados en [from, to). */
  from: Date;
  to: Date;
  staffId?: string | null;
  /** null/ausente = todas las sucursales. */
  locationIds?: readonly string[] | null;
  status?: EntryFilterStatus | null;
  payoutId?: string | null;
  limit?: number;
}

function entryConditions(businessId: string, filter: Omit<ListEntriesFilter, "limit">): SQL[] | null {
  const conditions: SQL[] = [eq(commissionEntries.businessId, businessId), gte(commissionEntries.earnedAt, filter.from), lt(commissionEntries.earnedAt, filter.to)];
  if (filter.locationIds) {
    if (filter.locationIds.length === 0) return null;
    conditions.push(inArray(commissionEntries.locationId, [...filter.locationIds]));
  }
  if (filter.staffId) conditions.push(eq(commissionEntries.staffId, filter.staffId));
  if (filter.payoutId) conditions.push(eq(commissionEntries.payoutId, filter.payoutId));
  if (filter.status === "open") conditions.push(isNull(commissionEntries.payoutId));
  if (filter.status === "in_payout") conditions.push(isNotNull(commissionEntries.payoutId), eq(commissionEntries.status, "pending"));
  if (filter.status === "paid") conditions.push(eq(commissionEntries.status, "paid"));
  return conditions;
}

/** Vistas de un lote de movimientos (profesional, cita, servicio y cliente). */
export async function toEntryViews(executor: Executor, businessId: string, rows: readonly CommissionEntry[]): Promise<CommissionEntryView[]> {
  if (rows.length === 0) return [];
  const staff = new Map((await listStaff(executor, businessId)).map((s) => [s.id, s]));
  const appointments = new Map((await getAppointmentsByIds(executor, businessId, [...new Set(rows.map((r) => r.appointmentId))])).map((a) => [a.id, a]));
  return rows.map((r) => {
    const s = staff.get(r.staffId);
    const a = appointments.get(r.appointmentId);
    const line = a?.services.find((l) => l.id === r.appointmentServiceId);
    return {
      id: r.id,
      staffId: r.staffId,
      staff: s ? { id: s.id, name: s.name, color: s.color } : null,
      appointmentId: r.appointmentId,
      appointmentServiceId: r.appointmentServiceId,
      locationId: r.locationId,
      earnedAt: r.earnedAt.toISOString(),
      appointmentStartsAt: a?.startsAt ?? null,
      serviceName: line?.name ?? null,
      clientName: a?.client?.name ?? null,
      baseCents: r.baseCents,
      amountCents: r.amountCents,
      rule: r.rule,
      status: r.status as CommissionEntryStatus,
      payoutId: r.payoutId,
      adjustment: a ? r.earnedAt.getTime() !== new Date(a.startsAt).getTime() : false,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    };
  });
}

export interface EntryList {
  items: CommissionEntryView[];
  /** Suma de lo filtrado (no solo de la página). */
  totalCents: number;
  count: number;
  truncated: boolean;
}

/** Movimientos de comisión de un período, del más nuevo al más viejo. */
export async function listCommissionEntries(executor: Executor, businessId: string, filter: ListEntriesFilter): Promise<EntryList> {
  const conditions = entryConditions(businessId, filter);
  if (!conditions) return { items: [], totalCents: 0, count: 0, truncated: false };
  const limit = Math.min(Math.max(filter.limit ?? 500, 1), 2000);
  const { rows, sums } = await withTenant(executor, businessId, async (tx) => ({
    rows: await tx
      .select()
      .from(commissionEntries)
      .where(and(...conditions))
      .orderBy(desc(commissionEntries.earnedAt), desc(commissionEntries.createdAt))
      .limit(limit + 1),
    sums: await tx
      .select({ total: sql<string>`coalesce(sum(${commissionEntries.amountCents}), 0)`, n: sql<string>`count(*)` })
      .from(commissionEntries)
      .where(and(...conditions)),
  }));
  return {
    items: await toEntryViews(executor, businessId, rows.slice(0, limit)),
    totalCents: Number(sums[0]?.total ?? 0),
    count: Number(sums[0]?.n ?? 0),
    truncated: rows.length > limit,
  };
}

export interface CommissionSummaryRow {
  staffId: string;
  name: string;
  color: string | null;
  count: number;
  /** Lo cobrado sobre lo que se calculó. */
  baseCents: number;
  amountCents: number;
  /** Sin liquidar todavía. */
  openCents: number;
  /** En una liquidación sin pagar. */
  inPayoutCents: number;
  paidCents: number;
}

export interface CommissionSummary {
  rows: CommissionSummaryRow[];
  totals: Omit<CommissionSummaryRow, "staffId" | "name" | "color">;
}

/** Resumen por profesional de un período (lo ganado, sin liquidar, en liquidación y pagado). */
export async function getCommissionSummary(
  executor: Executor,
  businessId: string,
  filter: { from: Date; to: Date; staffId?: string | null; locationIds?: readonly string[] | null },
): Promise<CommissionSummary> {
  const conditions = entryConditions(businessId, filter);
  const zero = { count: 0, baseCents: 0, amountCents: 0, openCents: 0, inPayoutCents: 0, paidCents: 0 };
  if (!conditions) return { rows: [], totals: zero };
  const grouped = await withTenant(executor, businessId, (tx) =>
    tx
      .select({
        staffId: commissionEntries.staffId,
        n: sql<string>`count(*)`,
        base: sql<string>`coalesce(sum(${commissionEntries.baseCents}), 0)`,
        amount: sql<string>`coalesce(sum(${commissionEntries.amountCents}), 0)`,
        open: sql<string>`coalesce(sum(case when ${commissionEntries.payoutId} is null then ${commissionEntries.amountCents} else 0 end), 0)`,
        inPayout: sql<string>`coalesce(sum(case when ${commissionEntries.payoutId} is not null and ${commissionEntries.status} = 'pending' then ${commissionEntries.amountCents} else 0 end), 0)`,
        paid: sql<string>`coalesce(sum(case when ${commissionEntries.status} = 'paid' then ${commissionEntries.amountCents} else 0 end), 0)`,
      })
      .from(commissionEntries)
      .where(and(...conditions))
      .groupBy(commissionEntries.staffId),
  );
  const staff = new Map((await listStaff(executor, businessId)).map((s) => [s.id, s]));
  const rows = grouped
    .map((g): CommissionSummaryRow => {
      const s = staff.get(g.staffId);
      return {
        staffId: g.staffId,
        name: s?.name ?? "Profesional",
        color: s?.color ?? null,
        count: Number(g.n),
        baseCents: Number(g.base),
        amountCents: Number(g.amount),
        openCents: Number(g.open),
        inPayoutCents: Number(g.inPayout),
        paidCents: Number(g.paid),
      };
    })
    .sort((a, b) => b.amountCents - a.amountCents || a.name.localeCompare(b.name, "es"));
  const totals = rows.reduce(
    (t, r) => ({
      count: t.count + r.count,
      baseCents: t.baseCents + r.baseCents,
      amountCents: t.amountCents + r.amountCents,
      openCents: t.openCents + r.openCents,
      inPayoutCents: t.inPayoutCents + r.inPayoutCents,
      paidCents: t.paidCents + r.paidCents,
    }),
    zero,
  );
  return { rows, totals };
}
