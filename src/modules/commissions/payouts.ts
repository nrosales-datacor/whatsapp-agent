import { and, asc, desc, eq, inArray, isNull, lt, ne, sql } from "drizzle-orm";
import { isTenantId, withTenant, type Executor } from "../../platform/db/scope";
import { HttpError, ValidationError } from "../../platform/http/errors";
import { getBusinessContext } from "../business";
import { localDayBounds } from "../scheduling";
import { getStaffMember, listStaff } from "../team";
import { recalculateAppointmentCommissions } from "./entries";
import { commissionEntries, payouts, type Payout } from "./schema";

// ─────────────────────────────────────────────────────────────────────────────
// Liquidaciones: pagarle a un profesional sus comisiones de un período.
//
//   • Crear (`createPayout`): junta los movimientos ABIERTOS del profesional ganados hasta
//     el fin del período (incluye lo atrasado: sigue debiéndose) con monto distinto de 0.
//     Desde ese momento quedan liquidados y no se recalculan más (un cobro o devolución
//     posterior genera un ajuste aparte). Sin nada que liquidar: 409 `nothing_to_pay`; si
//     los ajustes negativos dejan el total en cero o menos: 409 `negative_payout`.
//   • Pagar (`markPayoutPaid`): fija quién y cuándo, y sus movimientos pasan a `paid`.
//   • Anular (`deletePayout`, solo sin pagar): sus movimientos vuelven a estar abiertos y
//     se recalculan.
//   • Período en días locales de la zona del negocio (AAAA-MM-DD, inclusive).
// ─────────────────────────────────────────────────────────────────────────────

export interface PayoutView {
  id: string;
  staffId: string;
  staff: { id: string; name: string; color: string | null } | null;
  periodStart: string;
  periodEnd: string;
  totalCents: number;
  entryCount: number;
  paidAt: string | null;
  paidBy: string | null;
  note: string | null;
  createdAt: string;
}

const notFound = () => new HttpError(404, "Esa liquidación no existe.", "not_found");
const alreadyPaid = () => new HttpError(409, "Esa liquidación ya está pagada.", "already_paid");

async function toViews(executor: Executor, businessId: string, rows: readonly Payout[]): Promise<PayoutView[]> {
  if (rows.length === 0) return [];
  const staff = new Map((await listStaff(executor, businessId)).map((s) => [s.id, s]));
  const counts = await withTenant(executor, businessId, (tx) =>
    tx
      .select({ payoutId: commissionEntries.payoutId, n: sql<string>`count(*)` })
      .from(commissionEntries)
      .where(and(eq(commissionEntries.businessId, businessId), inArray(commissionEntries.payoutId, rows.map((r) => r.id))))
      .groupBy(commissionEntries.payoutId),
  );
  const countBy = new Map(counts.map((c) => [c.payoutId, Number(c.n)]));
  return rows.map((r) => {
    const s = staff.get(r.staffId);
    return {
      id: r.id,
      staffId: r.staffId,
      staff: s ? { id: s.id, name: s.name, color: s.color } : null,
      periodStart: r.periodStart,
      periodEnd: r.periodEnd,
      totalCents: r.totalCents,
      entryCount: countBy.get(r.id) ?? 0,
      paidAt: r.paidAt ? r.paidAt.toISOString() : null,
      paidBy: r.paidBy,
      note: r.note,
      createdAt: r.createdAt.toISOString(),
    };
  });
}

/** Una liquidación del negocio, o null. */
export async function getPayout(executor: Executor, businessId: string, payoutId: string): Promise<PayoutView | null> {
  if (!isTenantId(payoutId)) return null;
  const rows = await withTenant(executor, businessId, (tx) =>
    tx
      .select()
      .from(payouts)
      .where(and(eq(payouts.businessId, businessId), eq(payouts.id, payoutId)))
      .limit(1),
  );
  return (await toViews(executor, businessId, rows))[0] ?? null;
}

/** Liquidaciones, de la más nueva a la más vieja (`staffId`: solo las de un profesional). */
export async function listPayouts(executor: Executor, businessId: string, options: { staffId?: string | null; limit?: number } = {}): Promise<PayoutView[]> {
  const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
  const rows = await withTenant(executor, businessId, (tx) =>
    tx
      .select()
      .from(payouts)
      .where(options.staffId ? and(eq(payouts.businessId, businessId), eq(payouts.staffId, options.staffId)) : eq(payouts.businessId, businessId))
      .orderBy(desc(payouts.createdAt))
      .limit(limit),
  );
  return toViews(executor, businessId, rows);
}

export interface CreatePayoutInput {
  staffId: string;
  /** Días locales (AAAA-MM-DD), inclusive. */
  periodStart: string;
  periodEnd: string;
  note?: string | null;
}

/** Liquida lo abierto de un profesional hasta el fin del período (ver el encabezado). */
export async function createPayout(executor: Executor, businessId: string, input: CreatePayoutInput): Promise<PayoutView> {
  if (input.periodStart > input.periodEnd) throw new ValidationError({ "body.periodEnd": "El fin del período tiene que ser igual o posterior al inicio." });
  const staff = isTenantId(input.staffId) ? await getStaffMember(executor, businessId, input.staffId) : null;
  if (!staff) throw new ValidationError({ "body.staffId": "Ese profesional no existe." });
  const ctx = await getBusinessContext(executor, businessId);
  if (!ctx) throw new HttpError(404, "Negocio no encontrado.", "not_found");
  const { end } = localDayBounds(input.periodEnd, ctx.business.timezone);

  const id = await withTenant(executor, businessId, async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`commissions:payout:${staff.id}`}, 0))`);
    const open = await tx
      .select({ id: commissionEntries.id, amount: commissionEntries.amountCents })
      .from(commissionEntries)
      .where(
        and(
          eq(commissionEntries.businessId, businessId),
          eq(commissionEntries.staffId, staff.id),
          isNull(commissionEntries.payoutId),
          ne(commissionEntries.amountCents, 0),
          lt(commissionEntries.earnedAt, end),
        ),
      )
      .orderBy(asc(commissionEntries.earnedAt))
      .for("update");
    if (open.length === 0) throw new HttpError(409, "No hay comisiones sin liquidar hasta esa fecha.", "nothing_to_pay");
    const total = open.reduce((n, e) => n + e.amount, 0);
    if (total <= 0) {
      throw new HttpError(409, "Los ajustes por devoluciones dejan el total en cero o menos: esperá a que haya más comisiones.", "negative_payout");
    }
    const [payout] = await tx
      .insert(payouts)
      .values({ businessId, staffId: staff.id, periodStart: input.periodStart, periodEnd: input.periodEnd, totalCents: total, note: input.note?.trim() || null })
      .returning({ id: payouts.id });
    await tx
      .update(commissionEntries)
      .set({ payoutId: payout.id })
      .where(and(eq(commissionEntries.businessId, businessId), inArray(commissionEntries.id, open.map((e) => e.id))));
    return payout.id;
  });
  const view = await getPayout(executor, businessId, id);
  if (!view) throw notFound();
  return view;
}

/** Marca la liquidación como pagada: sus movimientos pasan a `paid`. */
export async function markPayoutPaid(executor: Executor, businessId: string, payoutId: string, input: { paidBy: string | null; now?: Date }): Promise<PayoutView> {
  if (!isTenantId(payoutId)) throw notFound();
  await withTenant(executor, businessId, async (tx) => {
    const [row] = await tx
      .select()
      .from(payouts)
      .where(and(eq(payouts.businessId, businessId), eq(payouts.id, payoutId)))
      .for("update");
    if (!row) throw notFound();
    if (row.paidAt) throw alreadyPaid();
    await tx.update(payouts).set({ paidAt: input.now ?? new Date(), paidBy: input.paidBy }).where(eq(payouts.id, row.id));
    await tx
      .update(commissionEntries)
      .set({ status: "paid" })
      .where(and(eq(commissionEntries.businessId, businessId), eq(commissionEntries.payoutId, row.id)));
  });
  const view = await getPayout(executor, businessId, payoutId);
  if (!view) throw notFound();
  return view;
}

/** Anula una liquidación sin pagar: sus movimientos vuelven a estar abiertos (y se recalculan). */
export async function deletePayout(executor: Executor, businessId: string, payoutId: string): Promise<void> {
  if (!isTenantId(payoutId)) throw notFound();
  await withTenant(executor, businessId, async (tx) => {
    const [row] = await tx
      .select()
      .from(payouts)
      .where(and(eq(payouts.businessId, businessId), eq(payouts.id, payoutId)))
      .for("update");
    if (!row) throw notFound();
    if (row.paidAt) throw new HttpError(409, "Una liquidación pagada no se puede anular.", "already_paid");
    const released = await tx
      .select({ lineId: commissionEntries.appointmentServiceId, appointmentId: commissionEntries.appointmentId })
      .from(commissionEntries)
      .where(and(eq(commissionEntries.businessId, businessId), eq(commissionEntries.payoutId, row.id)));
    const lineIds = [...new Set(released.map((e) => e.lineId))];
    // Un movimiento abierto por línea: el ajuste que se haya abierto mientras tanto se
    // descarta (el recálculo de abajo lo vuelve a sumar en el movimiento liberado).
    if (lineIds.length > 0) {
      await tx
        .delete(commissionEntries)
        .where(and(eq(commissionEntries.businessId, businessId), inArray(commissionEntries.appointmentServiceId, lineIds), isNull(commissionEntries.payoutId)));
    }
    await tx
      .update(commissionEntries)
      .set({ payoutId: null })
      .where(and(eq(commissionEntries.businessId, businessId), eq(commissionEntries.payoutId, row.id)));
    await tx.delete(payouts).where(eq(payouts.id, row.id));
    for (const appointmentId of new Set(released.map((e) => e.appointmentId))) {
      await recalculateAppointmentCommissions(tx, businessId, appointmentId);
    }
  });
}
