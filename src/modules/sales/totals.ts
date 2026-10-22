import { sql, type SQL } from "drizzle-orm";
import { rowsOf } from "../../platform/db/rows";
import { withTenant, type Executor } from "../../platform/db/scope";
import { getBusinessContext, listLocations } from "../business";
import { attributeAmounts, CHANNEL_LABELS, type AppointmentChannel, type AppointmentLineView, type AttributionKey } from "../scheduling";
import { listStaff } from "../team";
import { listPaymentMethods } from "./paymentMethods";
import { payments, type PaymentKind } from "./schema";

// ─────────────────────────────────────────────────────────────────────────────
// API pública de ingresos para Reportes e Inicio (I5): totales COBRADOS (no facturados)
// por rango, con filtros y agrupados por método, sucursal, profesional, servicio, canal o
// día. TODO en SQL (agregados con los índices de `payments`), nada en memoria.
//
//   • Cobrado = señas + cobros; neto = cobrado − devoluciones. Una devolución cuenta el
//     día que se hizo (no el del pago que devuelve), igual que en la caja.
//   • Profesional, servicio y canal salen de la cita del pago. Lo cobrado de una cita con
//     varios servicios se reparte entre sus líneas en proporción al precio (el mismo
//     prorrateo que las comisiones, `prorateByPrice`). Los pagos sueltos (sin cita) van al
//     grupo `null` ("Sin cita"). Ese cruce lo hace scheduling (`attributeAmounts`) con la
//     subconsulta de montos de acá: cada módulo lee solo sus tablas.
//   • Día: el día local en `timeZone` (default: la zona del negocio).
//   • Tickets: citas distintas con alguna seña o cobro, más cada cobro suelto (para el
//     ticket promedio).
// ─────────────────────────────────────────────────────────────────────────────

export type CollectedGroupBy = "method" | "location" | "staff" | "service" | "channel" | "day";

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
  /** Id del método/sucursal/profesional/servicio, el canal, "AAAA-MM-DD" por día, o null (sin cita). */
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
  /** Citas distintas con seña o cobro + cobros sueltos (base del ticket promedio). */
  tickets: number;
  groupBy: CollectedGroupBy | null;
  /** Ordenados por neto, de mayor a menor (por día: cronológico). */
  groups: CollectedGroup[];
}

const NO_APPOINTMENT = "Sin cita";

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

const num = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));

/** Fila agregada: clave del grupo, tipo de movimiento, monto y cantidad. */
interface KindRow {
  key: string | null;
  /** Nombre que trae el agregado (líneas de un servicio que ya no existe). */
  name: string | null;
  kind: PaymentKind;
  amount: number;
  count: number;
}

/** Condiciones sobre `payments` del rango y los filtros propios de sales. */
function paymentScope(businessId: string, input: CollectedTotalsInput): SQL {
  const parts: SQL[] = [
    sql`${payments.businessId} = ${businessId}::uuid`,
    sql`${payments.paidAt} >= ${input.from.toISOString()}::timestamptz`,
    sql`${payments.paidAt} < ${input.to.toISOString()}::timestamptz`,
  ];
  if (input.locationIds && input.locationIds.length > 0) {
    parts.push(sql`${payments.locationId} IN (${sql.join(input.locationIds.map((id) => sql`${id.toLowerCase()}::uuid`), sql`, `)})`);
  }
  if (input.methodId) parts.push(sql`${payments.paymentMethodId} = ${input.methodId.toLowerCase()}::uuid`);
  return sql.join(parts, sql` AND `);
}

/** Identidad de "ticket": la cita, o el pago suelto; las devoluciones no cuentan. */
const ticketOf = sql`CASE WHEN ${payments.kind} <> 'refund' THEN coalesce(${payments.appointmentId}, ${payments.id})::text END`;

/** Clave propia de sales para agrupar (método, sucursal o día); NULL para el resto. */
function ownKey(groupBy: CollectedGroupBy | undefined, timeZone: string): SQL {
  switch (groupBy) {
    case "method":
      return sql`${payments.paymentMethodId}::text`;
    case "location":
      return sql`${payments.locationId}::text`;
    case "day":
      return sql`to_char(${payments.paidAt} AT TIME ZONE ${timeZone}, 'YYYY-MM-DD')`;
    default:
      return sql`NULL::text`;
  }
}

/** Agregado directo sobre `payments` (sin cruzar con citas): método, sucursal, día o nada. */
async function aggregateOwn(
  executor: Executor,
  businessId: string,
  input: CollectedTotalsInput,
  timeZone: string,
): Promise<{ rows: KindRow[]; count: number; tickets: number }> {
  const scope = paymentScope(businessId, input);
  const key = ownKey(input.groupBy, timeZone);
  return withTenant(executor, businessId, async (tx) => {
    const rows = rowsOf<{ key: string | null; kind: PaymentKind; amount: unknown; n: unknown }>(
      await tx.execute(sql`
        SELECT ${key} AS key, ${payments.kind} AS kind, sum(${payments.amountCents}) AS amount, count(*) AS n
          FROM ${payments}
         WHERE ${scope}
         GROUP BY 1, 2
      `),
    );
    const [overall] = rowsOf<{ n: unknown; tickets: unknown }>(
      await tx.execute(sql`SELECT count(*) AS n, count(DISTINCT ${ticketOf}) AS tickets FROM ${payments} WHERE ${scope}`),
    );
    return {
      rows: rows.map((r) => ({ key: r.key, name: null, kind: r.kind, amount: num(r.amount), count: num(r.n) })),
      count: num(overall?.n),
      tickets: num(overall?.tickets),
    };
  });
}

/**
 * Cruce con las citas (profesional, servicio o canal, o un filtro por profesional o
 * servicio): lo hace scheduling con nuestra subconsulta. Método, sucursal o día viajan
 * como `group_key` cuando además hay filtro.
 */
async function aggregateByAppointment(
  executor: Executor,
  businessId: string,
  input: CollectedTotalsInput,
  timeZone: string,
): Promise<{ rows: KindRow[]; count: number; tickets: number }> {
  const amounts = sql`
    SELECT ${payments.id} AS movement_id, ${payments.appointmentId} AS appointment_id, ${payments.kind} AS kind,
           ${payments.amountCents} AS amount, ${ticketOf} AS ticket, ${ownKey(input.groupBy, timeZone)} AS group_key
      FROM ${payments}
     WHERE ${paymentScope(businessId, input)}`;
  const groupBy: AttributionKey | null =
    input.groupBy === "staff" || input.groupBy === "service" || input.groupBy === "channel"
      ? input.groupBy
      : input.groupBy
        ? "source"
        : null;
  const result = await attributeAmounts(executor, businessId, {
    amounts,
    splitByService: Boolean(input.serviceId) || input.groupBy === "service",
    groupBy,
    staffId: input.staffId ?? null,
    serviceId: input.serviceId ?? null,
  });
  return {
    rows: result.groups.map((g) => ({ key: g.key, name: g.name, kind: g.kind as PaymentKind, amount: g.amountCents, count: g.portions })),
    count: result.movements,
    tickets: result.tickets,
  };
}

/** Nombres de los grupos (solo se leen los catálogos que hacen falta). */
async function labeler(executor: Executor, businessId: string, groupBy: CollectedGroupBy | undefined): Promise<(row: KindRow) => string> {
  switch (groupBy) {
    case "method": {
      const names = new Map((await listPaymentMethods(executor, businessId)).map((m) => [m.id, m.name]));
      return (r) => (r.key ? (names.get(r.key) ?? "Método eliminado") : "");
    }
    case "location": {
      const names = new Map((await listLocations(executor, businessId)).map((l) => [l.id, l.name]));
      return (r) => (r.key ? (names.get(r.key) ?? "Sucursal") : "");
    }
    case "staff": {
      const names = new Map((await listStaff(executor, businessId)).map((s) => [s.id, s.name]));
      return (r) => (r.key ? (names.get(r.key) ?? "Profesional") : NO_APPOINTMENT);
    }
    case "channel":
      return (r) => (r.key ? (CHANNEL_LABELS[r.key as AppointmentChannel] ?? r.key) : NO_APPOINTMENT);
    case "service":
      // El nombre copiado en la línea (el servicio pudo cambiar de nombre o borrarse).
      return (r) => r.name ?? (r.key ? "Servicio" : NO_APPOINTMENT);
    case "day":
      return (r) => r.key ?? "";
    default:
      return () => "";
  }
}

/** Totales cobrados del negocio por rango (API pública para Reportes e Inicio). */
export async function getCollectedTotals(executor: Executor, businessId: string, input: CollectedTotalsInput): Promise<CollectedTotals> {
  const groupBy = input.groupBy ?? null;
  const empty = Boolean(input.locationIds && input.locationIds.length === 0);
  const viaAppointments = Boolean(input.staffId || input.serviceId || groupBy === "staff" || groupBy === "service" || groupBy === "channel");
  const timeZone =
    input.timeZone ?? (groupBy === "day" ? ((await getBusinessContext(executor, businessId))?.business.timezone ?? "America/Costa_Rica") : "UTC");
  const { rows, count, tickets } = empty
    ? { rows: [], count: 0, tickets: 0 }
    : viaAppointments
      ? await aggregateByAppointment(executor, businessId, input, timeZone)
      : await aggregateOwn(executor, businessId, input, timeZone);

  const labelOf = rows.length > 0 && groupBy ? await labeler(executor, businessId, input.groupBy) : () => "";
  const sums = { depositsCents: 0, paymentsCents: 0, refundsCents: 0 };
  const groups = new Map<string, CollectedGroup>();
  for (const r of rows) {
    if (r.kind === "deposit") sums.depositsCents += r.amount;
    else if (r.kind === "payment") sums.paymentsCents += r.amount;
    else sums.refundsCents += r.amount;
    if (!groupBy) continue;
    const label = labelOf(r);
    const id = r.key ?? `\u0000${label}`;
    const g = groups.get(id) ?? { key: r.key, label, collectedCents: 0, refundsCents: 0, netCents: 0, count: 0 };
    if (r.kind === "refund") g.refundsCents += r.amount;
    else g.collectedCents += r.amount;
    g.netCents = g.collectedCents - g.refundsCents;
    g.count += r.count;
    groups.set(id, g);
  }
  const list = [...groups.values()];
  if (groupBy === "day") list.sort((a, b) => String(a.key).localeCompare(String(b.key)));
  else list.sort((a, b) => b.netCents - a.netCents || a.label.localeCompare(b.label, "es"));
  const collected = sums.depositsCents + sums.paymentsCents;
  return {
    from: input.from.toISOString(),
    to: input.to.toISOString(),
    ...sums,
    collectedCents: collected,
    netCents: collected - sums.refundsCents,
    count,
    tickets,
    groupBy,
    groups: list,
  };
}
