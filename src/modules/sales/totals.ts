import { and, eq, gte, inArray, lt, type SQL } from "drizzle-orm";
import { withTenant, type Executor } from "../../platform/db/scope";
import { getBusinessContext, listLocations } from "../business";
import { getAppointmentsByIds, localDate, type AppointmentLineView, type AppointmentView } from "../scheduling";
import { listPaymentMethods } from "./paymentMethods";
import { payments, type PaymentKind } from "./schema";

// ─────────────────────────────────────────────────────────────────────────────
// API pública de ingresos para Reportes e Inicio (I5): totales COBRADOS (no facturados)
// por rango, con filtros y agrupados por método, sucursal, profesional, servicio o día.
//
//   • Cobrado = señas + cobros; neto = cobrado − devoluciones. Una devolución cuenta el
//     día que se hizo (no el del pago que devuelve), igual que en la caja.
//   • Profesional y servicio salen de la cita del pago. Lo cobrado de una cita con varios
//     servicios se reparte entre sus líneas en proporción al precio (el mismo prorrateo que
//     las comisiones). Los pagos sueltos (sin cita) van al grupo `null` ("Sin cita").
//   • Día: el día local en `timeZone` (default: la zona del negocio).
//
// Lee las citas por la API de scheduling (no sus tablas). Pensado para rangos de reportes
// (un mes, un trimestre); el tope de filas protege de un rango desbocado.
// ─────────────────────────────────────────────────────────────────────────────

export type CollectedGroupBy = "method" | "location" | "staff" | "service" | "day";

export interface CollectedTotalsInput {
  /** Cobrados en [from, to). */
  from: Date;
  to: Date;
  /** null/ausente = todas las sucursales. */
  locationIds?: readonly string[] | null;
  methodId?: string | null;
  /** Solo lo cobrado de citas de este profesional. */
  staffId?: string | null;
  /** Solo la parte de lo cobrado que corresponde a este servicio. */
  serviceId?: string | null;
  groupBy?: CollectedGroupBy;
  /** Zona para agrupar por día (default: la del negocio). */
  timeZone?: string;
}

export interface CollectedGroup {
  /** Id del método/sucursal/profesional/servicio, "AAAA-MM-DD" por día, o null (sin cita). */
  key: string | null;
  label: string;
  collectedCents: number;
  refundsCents: number;
  netCents: number;
  count: number;
}

export interface CollectedTotals {
  from: string;
  to: string;
  depositsCents: number;
  paymentsCents: number;
  /** Señas + cobros. */
  collectedCents: number;
  refundsCents: number;
  netCents: number;
  /** Movimientos que entraron en el total. */
  count: number;
  groupBy: CollectedGroupBy | null;
  /** Ordenados por neto, de mayor a menor (por día: cronológico). */
  groups: CollectedGroup[];
}

/** Tope de movimientos que se leen por consulta. */
const MAX_ROWS = 50_000;

/** Reparte `amount` entre las líneas en proporción a su precio (resto mayor: la suma da exacto). */
export function prorateByPrice(amount: number, lines: readonly Pick<AppointmentLineView, "priceCents">[]): number[] {
  const total = lines.reduce((n, l) => n + l.priceCents, 0);
  if (lines.length === 0) return [];
  if (total <= 0) return lines.map((_, i) => (i === 0 ? amount : 0));
  const exact = lines.map((l) => (amount * l.priceCents) / total);
  const out = exact.map((x) => Math.floor(x));
  let rest = amount - out.reduce((n, x) => n + x, 0);
  const order = exact.map((x, i) => ({ i, frac: x - Math.floor(x) })).sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (let k = 0; rest > 0 && k < order.length; k++, rest--) out[order[k].i] += 1;
  return out;
}

interface Portion {
  kind: PaymentKind;
  amount: number;
  key: string | null;
  label: string;
}

/** Totales cobrados del negocio por rango (API pública para Reportes e Inicio). */
export async function getCollectedTotals(executor: Executor, businessId: string, input: CollectedTotalsInput): Promise<CollectedTotals> {
  const conditions: SQL[] = [eq(payments.businessId, businessId), gte(payments.paidAt, input.from), lt(payments.paidAt, input.to)];
  const empty = input.locationIds && input.locationIds.length === 0;
  if (input.locationIds && input.locationIds.length > 0) conditions.push(inArray(payments.locationId, [...input.locationIds]));
  if (input.methodId) conditions.push(eq(payments.paymentMethodId, input.methodId));
  const rows = empty
    ? []
    : await withTenant(executor, businessId, (tx) =>
        tx
          .select({
            kind: payments.kind,
            amount: payments.amountCents,
            paidAt: payments.paidAt,
            methodId: payments.paymentMethodId,
            locationId: payments.locationId,
            appointmentId: payments.appointmentId,
          })
          .from(payments)
          .where(and(...conditions))
          .limit(MAX_ROWS),
      );

  const needsAppointments = Boolean(input.staffId || input.serviceId || input.groupBy === "staff" || input.groupBy === "service");
  const appointments = new Map<string, AppointmentView>();
  if (needsAppointments) {
    const ids = [...new Set(rows.map((r) => r.appointmentId).filter((id): id is string => Boolean(id)))];
    for (let i = 0; i < ids.length; i += 500) {
      for (const a of await getAppointmentsByIds(executor, businessId, ids.slice(i, i + 500))) appointments.set(a.id, a);
    }
  }
  const timeZone = input.timeZone ?? (await getBusinessContext(executor, businessId))?.business.timezone ?? "America/Costa_Rica";
  const methodName = new Map((await listPaymentMethods(executor, businessId)).map((m) => [m.id, m.name]));
  const locationName = new Map((await listLocations(executor, businessId)).map((l) => [l.id, l.name]));

  // Cada movimiento se parte en porciones (una por línea si hace falta saber el servicio).
  const portions: Portion[] = [];
  let counted = 0;
  for (const r of rows) {
    const before = portions.length;
    pushPortions(r);
    if (portions.length > before) counted++;
  }

  function pushPortions(r: (typeof rows)[number]): void {
    const kind = r.kind as PaymentKind;
    const appointment = r.appointmentId ? appointments.get(r.appointmentId) : undefined;
    if (input.staffId && appointment?.staffId !== input.staffId) return;
    if (input.serviceId || input.groupBy === "service") {
      if (!appointment) {
        if (!input.serviceId) portions.push({ kind, amount: r.amount, key: null, label: "Sin cita" });
        return;
      }
      const shares = prorateByPrice(r.amount, appointment.services);
      appointment.services.forEach((line, i) => {
        if (input.serviceId && line.serviceId !== input.serviceId) return;
        if (shares[i] > 0) portions.push({ kind, amount: shares[i], key: line.serviceId, label: line.name });
      });
      return;
    }
    let key: string | null = null;
    let label = "";
    switch (input.groupBy) {
      case "method":
        key = r.methodId;
        label = methodName.get(r.methodId) ?? "Método eliminado";
        break;
      case "location":
        key = r.locationId;
        label = locationName.get(r.locationId) ?? "Sucursal";
        break;
      case "staff":
        key = appointment?.staffId ?? null;
        label = appointment ? (appointment.staff?.name ?? "Profesional") : "Sin cita";
        break;
      case "day":
        key = localDate(r.paidAt, timeZone);
        label = key;
        break;
    }
    portions.push({ kind, amount: r.amount, key, label });
  }

  const sums = { depositsCents: 0, paymentsCents: 0, refundsCents: 0 };
  const groups = new Map<string, CollectedGroup>();
  for (const p of portions) {
    if (p.kind === "deposit") sums.depositsCents += p.amount;
    else if (p.kind === "payment") sums.paymentsCents += p.amount;
    else sums.refundsCents += p.amount;
    if (!input.groupBy) continue;
    const id = p.key ?? "\u0000none";
    const g = groups.get(id) ?? { key: p.key, label: p.label, collectedCents: 0, refundsCents: 0, netCents: 0, count: 0 };
    if (p.kind === "refund") g.refundsCents += p.amount;
    else g.collectedCents += p.amount;
    g.netCents = g.collectedCents - g.refundsCents;
    g.count += 1;
    groups.set(id, g);
  }
  const list = [...groups.values()];
  if (input.groupBy === "day") list.sort((a, b) => String(a.key).localeCompare(String(b.key)));
  else list.sort((a, b) => b.netCents - a.netCents || a.label.localeCompare(b.label, "es"));
  const collected = sums.depositsCents + sums.paymentsCents;
  return {
    from: input.from.toISOString(),
    to: input.to.toISOString(),
    ...sums,
    collectedCents: collected,
    netCents: collected - sums.refundsCents,
    count: counted,
    groupBy: input.groupBy ?? null,
    groups: list,
  };
}
