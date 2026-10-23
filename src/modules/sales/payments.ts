import { and, desc, eq, gte, inArray, lt, sql, type SQL } from "drizzle-orm";
import { formatAmount } from "../../platform/money/currency";
import { isTenantId, withTenant, type Executor, type Tx } from "../../platform/db/scope";
import { HttpError, ValidationError } from "../../platform/http/errors";
import { log } from "../../platform/observability/log";
import { getBusinessContext, listLocations } from "../business";
import { getClient, getClientsByIds, refreshClientStats } from "../clients";
import { getAppointment, listAppointments, localDayBounds, type AppointmentView } from "../scheduling";
import { listPaymentMethods, type PaymentMethodView } from "./paymentMethods";
import { payments, type Payment, type PaymentKind } from "./schema";

// ─────────────────────────────────────────────────────────────────────────────
// Pagos: registrar cobros y señas, devolverlos, y leer saldos, pendientes y caja
// (PLAN-GESTION.md §4). Solo se REGISTRA lo cobrado: sin cobro en línea ni factura.
//
//   • Saldo de una cita = total − (señas + cobros − devoluciones). Nunca se cobra más que el
//     saldo: una seña o un cobro de más en una cita responde 409 `amount_exceeds_balance`.
//     Lo único sin tope es el cobro SUELTO a un cliente (sin cita: p. ej. una seña explícita
//     antes de agendar), porque no hay saldo contra el cual medirlo.
//   • Seña = antes de la cita (pendiente o confirmada). Completada la cita, lo que entra es
//     un cobro. Cancelada o no-show: no se cobra (una seña ya cobrada se puede devolver).
//   • Devolución: siempre de UN pago (`refund_of_id`), parcial o total, con motivo, y nunca
//     más de lo que queda por devolver de ese pago (409 `amount_exceeds_refundable`).
//   • Montos en céntimos de la moneda del negocio. Si el cuerpo trae `currency`, tiene que
//     ser esa (no hay conversión).
//   • Cada pago o devolución recalcula en la MISMA transacción el gasto total del cliente
//     (`refreshClientStats` con el valor absoluto desde sus pagos) y, si es de una cita,
//     corre el gancho `onPaymentsChanged` (las comisiones, inyectadas por la composición:
//     sales no conoce a commissions).
//   • Concurrencia: los cobros y devoluciones de una misma cita se serializan con un lock
//     de transacción por cita (dos cajas cobrando el mismo saldo: uno gana, el otro ve el
//     saldo nuevo); la devolución bloquea además la fila del pago que devuelve.
//
// Permisos (rol, sucursal) los aplica la ruta: estas funciones son del negocio.
// ─────────────────────────────────────────────────────────────────────────────

/** Efecto interno de un cobro o devolución de una cita, en su transacción (comisiones). */
export type PaymentsChangedHook = (tx: Tx, businessId: string, appointmentId: string) => Promise<void>;

/**
 * Aviso de una seña o un cobro recién registrado (ya confirmado en la base): métricas de
 * uso que inyecta la composición. Un error del gancho se registra y no afecta el pago.
 */
export type PaymentRecordedHook = (executor: Executor, businessId: string, payment: PaymentView) => Promise<void> | void;

async function notifyRecorded(executor: Executor, businessId: string, payment: PaymentView, hook: PaymentRecordedHook | undefined): Promise<void> {
  if (!hook) return;
  try {
    await hook(executor, businessId, payment);
  } catch (error) {
    log.warn("payment_recorded_hook_failed", { businessId, error: error instanceof Error ? error.message : String(error) });
  }
}

/** Tope de un monto en céntimos (mil millones de unidades), igual que los precios del catálogo. */
export const MAX_AMOUNT_CENTS = 100_000_000_000;

/** Cuánto se puede adelantar `paidAt` respecto del reloj (relojes de dispositivos desfasados). */
const FUTURE_TOLERANCE_MS = 5 * 60_000;

export interface PaymentView {
  id: string;
  kind: PaymentKind;
  amountCents: number;
  /** Cuándo se cobró (ISO). Manda en la caja y los reportes. */
  paidAt: string;
  method: { id: string; name: string } | null;
  locationId: string;
  location: { id: string; name: string } | null;
  clientId: string;
  client: { id: string; name: string } | null;
  appointmentId: string | null;
  /** En una devolución, el pago que devuelve. */
  refundOfId: string | null;
  /** En una seña o cobro: cuánto se devolvió ya de él. */
  refundedCents: number;
  /** Nota del cobro; en una devolución, el motivo. */
  note: string | null;
  recordedBy: string | null;
  createdAt: string;
}

export interface AppointmentBalance {
  appointmentId: string;
  status: string;
  currency: string;
  totalCents: number;
  depositsCents: number;
  paymentsCents: number;
  refundsCents: number;
  /** Lo cobrado neto: señas + cobros − devoluciones. */
  paidCents: number;
  /** Lo que falta: total − cobrado (0 si ya está pagada). */
  balanceCents: number;
  /** Movimientos de la cita, del más nuevo al más viejo. */
  payments: PaymentView[];
}

export interface CollectedSums {
  depositsCents: number;
  paymentsCents: number;
  refundsCents: number;
}

const ZERO: CollectedSums = { depositsCents: 0, paymentsCents: 0, refundsCents: 0 };

/** Neto cobrado de unas sumas (puede ser 0, nunca negativo en la práctica). */
export const netOf = (s: CollectedSums): number => s.depositsCents + s.paymentsCents - s.refundsCents;

// ── Errores ─────────────────────────────────────────────────────────────────

const appointmentNotFound = () => new HttpError(404, "No encontramos esa cita.", "not_found");
const paymentNotFound = () => new HttpError(404, "No encontramos ese pago.", "not_found");

async function currencyOf(executor: Executor, businessId: string): Promise<string> {
  const ctx = await getBusinessContext(executor, businessId);
  if (!ctx) throw new HttpError(404, "Negocio no encontrado.", "not_found");
  return ctx.business.currency;
}

function assertCurrency(requested: string | null | undefined, businessCurrency: string): void {
  if (requested && requested.trim().toUpperCase() !== businessCurrency.toUpperCase()) {
    throw new ValidationError({ "body.currency": `Los montos van en la moneda del negocio (${businessCurrency}).` });
  }
}

function assertPaidAt(paidAt: Date | null | undefined, now: Date): void {
  if (paidAt && paidAt.getTime() > now.getTime() + FUTURE_TOLERANCE_MS) {
    throw new ValidationError({ "body.paidAt": "La fecha del cobro no puede ser futura." });
  }
}

function assertAmount(amountCents: number): void {
  if (!Number.isSafeInteger(amountCents) || amountCents <= 0 || amountCents > MAX_AMOUNT_CENTS) {
    throw new ValidationError({ "body.amountCents": "El monto tiene que ser mayor que cero." });
  }
}

async function activeMethod(executor: Executor, businessId: string, methodId: string, options: { allowInactive?: boolean } = {}): Promise<PaymentMethodView> {
  const method = (await listPaymentMethods(executor, businessId)).find((m) => m.id === methodId.toLowerCase());
  if (!method || (!method.active && !options.allowInactive)) {
    throw new ValidationError({ "body.methodId": "Ese método de pago no existe o está desactivado." });
  }
  return method;
}

// ── Lectura ─────────────────────────────────────────────────────────────────

/** Lock de transacción por cita: serializa sus cobros, devoluciones y el recálculo de comisiones. */
async function lockAppointment(tx: Tx, appointmentId: string): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`sales:appointment:${appointmentId}`}, 0))`);
}

/** Sumas por cita (señas, cobros, devoluciones) de varias citas a la vez. */
export async function getCollectedByAppointment(
  executor: Executor,
  businessId: string,
  appointmentIds: readonly string[],
): Promise<Map<string, CollectedSums>> {
  const ids = [...new Set(appointmentIds.filter(isTenantId).map((id) => id.toLowerCase()))];
  const out = new Map<string, CollectedSums>();
  if (ids.length === 0) return out;
  const rows = await withTenant(executor, businessId, (tx) =>
    tx
      .select({ appointmentId: payments.appointmentId, kind: payments.kind, total: sql<string>`coalesce(sum(${payments.amountCents}), 0)` })
      .from(payments)
      .where(and(eq(payments.businessId, businessId), inArray(payments.appointmentId, ids)))
      .groupBy(payments.appointmentId, payments.kind),
  );
  for (const r of rows) {
    if (!r.appointmentId) continue;
    const sums = out.get(r.appointmentId) ?? { ...ZERO };
    const n = Number(r.total);
    if (r.kind === "deposit") sums.depositsCents += n;
    else if (r.kind === "payment") sums.paymentsCents += n;
    else sums.refundsCents += n;
    out.set(r.appointmentId, sums);
  }
  return out;
}

/** Lo cobrado neto de una cita (señas + cobros − devoluciones). API pública: comisiones. */
export async function getAppointmentCollected(executor: Executor, businessId: string, appointmentId: string): Promise<number> {
  const sums = (await getCollectedByAppointment(executor, businessId, [appointmentId])).get(appointmentId.toLowerCase());
  return sums ? netOf(sums) : 0;
}

/** Lo ya devuelto de cada pago (por id del pago original). */
async function refundedByPayment(tx: Tx, businessId: string, paymentIds: readonly string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (paymentIds.length === 0) return out;
  const rows = await tx
    .select({ id: payments.refundOfId, total: sql<string>`coalesce(sum(${payments.amountCents}), 0)` })
    .from(payments)
    .where(and(eq(payments.businessId, businessId), inArray(payments.refundOfId, [...paymentIds])))
    .groupBy(payments.refundOfId);
  for (const r of rows) if (r.id) out.set(r.id, Number(r.total));
  return out;
}

/** Vistas de un lote de pagos, en su orden (método, sucursal, cliente y lo devuelto). */
async function toViews(executor: Executor, businessId: string, rows: readonly Payment[]): Promise<PaymentView[]> {
  if (rows.length === 0) return [];
  const methods = new Map((await listPaymentMethods(executor, businessId)).map((m) => [m.id, m]));
  const locations = new Map((await listLocations(executor, businessId)).map((l) => [l.id, l]));
  const clients = new Map((await getClientsByIds(executor, businessId, rows.map((r) => r.clientId))).map((c) => [c.id, c]));
  const refundable = rows.filter((r) => r.kind !== "refund").map((r) => r.id);
  const refunded = await withTenant(executor, businessId, (tx) => refundedByPayment(tx, businessId, refundable));
  return rows.map((r) => {
    const m = methods.get(r.paymentMethodId);
    const l = locations.get(r.locationId);
    const c = clients.get(r.clientId);
    return {
      id: r.id,
      kind: r.kind as PaymentKind,
      amountCents: r.amountCents,
      paidAt: r.paidAt.toISOString(),
      method: m ? { id: m.id, name: m.name } : null,
      locationId: r.locationId,
      location: l ? { id: l.id, name: l.name } : null,
      clientId: r.clientId,
      client: c ? { id: c.id, name: c.name } : null,
      appointmentId: r.appointmentId,
      refundOfId: r.refundOfId,
      refundedCents: refunded.get(r.id) ?? 0,
      note: r.note,
      recordedBy: r.recordedBy,
      createdAt: r.createdAt.toISOString(),
    };
  });
}

/** Un pago del negocio (fila cruda), o null. */
async function getPaymentRow(executor: Executor, businessId: string, paymentId: string): Promise<Payment | null> {
  if (!isTenantId(paymentId)) return null;
  const [row] = await withTenant(executor, businessId, (tx) =>
    tx
      .select()
      .from(payments)
      .where(and(eq(payments.businessId, businessId), eq(payments.id, paymentId)))
      .limit(1),
  );
  return row ?? null;
}

/** Un pago del negocio, o null. */
export async function getPayment(executor: Executor, businessId: string, paymentId: string): Promise<PaymentView | null> {
  const row = await getPaymentRow(executor, businessId, paymentId);
  return row ? ((await toViews(executor, businessId, [row]))[0] ?? null) : null;
}

/** Saldo de una cita a partir de su vista y sus pagos. */
async function balanceOf(executor: Executor, businessId: string, appointment: AppointmentView, currency: string): Promise<AppointmentBalance> {
  const rows = await withTenant(executor, businessId, (tx) =>
    tx
      .select()
      .from(payments)
      .where(and(eq(payments.businessId, businessId), eq(payments.appointmentId, appointment.id)))
      .orderBy(desc(payments.paidAt), desc(payments.createdAt)),
  );
  const sums = { ...ZERO };
  for (const r of rows) {
    if (r.kind === "deposit") sums.depositsCents += r.amountCents;
    else if (r.kind === "payment") sums.paymentsCents += r.amountCents;
    else sums.refundsCents += r.amountCents;
  }
  const paid = netOf(sums);
  return {
    appointmentId: appointment.id,
    status: appointment.status,
    currency,
    totalCents: appointment.totalCents,
    ...sums,
    paidCents: paid,
    balanceCents: Math.max(0, appointment.totalCents - paid),
    payments: await toViews(executor, businessId, rows),
  };
}

/** Saldo de una cita (`GET /appointments/:id/balance`). 404 si no existe. */
export async function getAppointmentBalance(executor: Executor, businessId: string, appointmentId: string): Promise<AppointmentBalance> {
  const appointment = await getAppointment(executor, businessId, appointmentId);
  if (!appointment) throw appointmentNotFound();
  return balanceOf(executor, businessId, appointment, await currencyOf(executor, businessId));
}

// ── Gasto del cliente ───────────────────────────────────────────────────────

/** Gasto total del cliente (pagos − devoluciones) en su caché, con el valor absoluto. */
async function refreshClientSpent(tx: Tx, businessId: string, clientId: string): Promise<void> {
  const [r] = await tx
    .select({
      income: sql<string>`coalesce(sum(case when ${payments.kind} <> 'refund' then ${payments.amountCents} else 0 end), 0)`,
      refunds: sql<string>`coalesce(sum(case when ${payments.kind} = 'refund' then ${payments.amountCents} else 0 end), 0)`,
    })
    .from(payments)
    .where(and(eq(payments.businessId, businessId), eq(payments.clientId, clientId)));
  const total = Math.max(0, Number(r?.income ?? 0) - Number(r?.refunds ?? 0));
  await refreshClientStats(tx, businessId, clientId, { totalSpentCents: total });
}

// ── Cobrar ──────────────────────────────────────────────────────────────────

export interface AppointmentPaymentInput {
  appointmentId: string;
  /** `deposit` = seña (antes de la cita), `payment` = cobro. */
  kind: Exclude<PaymentKind, "refund">;
  amountCents: number;
  methodId: string;
  note?: string | null;
  /** Cuándo se cobró (default: ahora). No puede ser futuro. */
  paidAt?: Date | null;
  /** Si viene, tiene que ser la moneda del negocio. */
  currency?: string | null;
  /** Usuario del panel que lo registra. */
  recordedBy: string | null;
  onPaymentsChanged?: PaymentsChangedHook;
  onRecorded?: PaymentRecordedHook;
  now?: Date;
}

export interface RecordedPayment {
  payment: PaymentView;
  balance: AppointmentBalance;
}

/**
 * Cobra (o registra una seña de) una cita. Errores: 404 si la cita no existe; 409
 * `appointment_closed` (cancelada o no-show), `deposit_not_allowed` (seña de una cita ya
 * completada), `amount_exceeds_balance`; 400 por método, monto, moneda o fecha.
 */
export async function recordAppointmentPayment(executor: Executor, businessId: string, input: AppointmentPaymentInput): Promise<RecordedPayment> {
  const now = input.now ?? new Date();
  assertAmount(input.amountCents);
  assertPaidAt(input.paidAt, now);
  if (!isTenantId(input.appointmentId)) throw appointmentNotFound();
  const currency = await currencyOf(executor, businessId);
  assertCurrency(input.currency, currency);
  const method = await activeMethod(executor, businessId, input.methodId);
  const appointmentId = input.appointmentId.toLowerCase();

  const paymentId = await withTenant(executor, businessId, async (tx) => {
    await lockAppointment(tx, appointmentId);
    const appointment = await getAppointment(tx, businessId, appointmentId);
    if (!appointment) throw appointmentNotFound();
    if (appointment.status === "cancelled" || appointment.status === "no_show") {
      throw new HttpError(
        409,
        `No se puede cobrar una cita ${appointment.status === "cancelled" ? "cancelada" : "marcada como no asistió"}. Si dejó una seña, podés devolverla desde Ventas › Cobros.`,
        "appointment_closed",
      );
    }
    if (input.kind === "deposit" && appointment.status === "completed") {
      throw new HttpError(409, "La cita ya se completó: registrá un pago en vez de una seña.", "deposit_not_allowed");
    }
    const sums = (await getCollectedByAppointment(tx, businessId, [appointmentId])).get(appointmentId) ?? ZERO;
    const balance = Math.max(0, appointment.totalCents - netOf(sums));
    if (input.amountCents > balance) {
      throw new HttpError(
        409,
        balance === 0 ? "Esta cita ya está pagada." : `El monto supera el saldo de la cita (${formatAmount(balance / 100, currency)}).`,
        "amount_exceeds_balance",
      );
    }
    const [row] = await tx
      .insert(payments)
      .values({
        businessId,
        locationId: appointment.locationId,
        clientId: appointment.clientId,
        appointmentId,
        kind: input.kind,
        amountCents: input.amountCents,
        paymentMethodId: method.id,
        recordedBy: input.recordedBy,
        paidAt: input.paidAt ?? now,
        note: input.note?.trim() || null,
      })
      .returning({ id: payments.id });
    await refreshClientSpent(tx, businessId, appointment.clientId);
    if (input.onPaymentsChanged) await input.onPaymentsChanged(tx, businessId, appointmentId);
    return row.id;
  });

  const payment = await getPayment(executor, businessId, paymentId);
  if (!payment) throw paymentNotFound();
  await notifyRecorded(executor, businessId, payment, input.onRecorded);
  return { payment, balance: await getAppointmentBalance(executor, businessId, appointmentId) };
}

export interface ClientPaymentInput {
  clientId: string;
  locationId: string;
  kind: Exclude<PaymentKind, "refund">;
  amountCents: number;
  methodId: string;
  note?: string | null;
  paidAt?: Date | null;
  currency?: string | null;
  recordedBy: string | null;
  onRecorded?: PaymentRecordedHook;
  now?: Date;
}

/**
 * Cobro suelto a un cliente, sin cita (p. ej. una seña antes de agendar o la venta de algo
 * suelto). Sin tope: no hay saldo contra el cual medirlo. Errores 400 por cliente,
 * sucursal, método, monto, moneda o fecha.
 */
export async function recordClientPayment(executor: Executor, businessId: string, input: ClientPaymentInput): Promise<PaymentView> {
  const now = input.now ?? new Date();
  assertAmount(input.amountCents);
  assertPaidAt(input.paidAt, now);
  const currency = await currencyOf(executor, businessId);
  assertCurrency(input.currency, currency);
  const client = await getClient(executor, businessId, input.clientId);
  if (!client) throw new ValidationError({ "body.clientId": "Ese cliente no existe." });
  if (client.anonymized) throw new ValidationError({ "body.clientId": "Los datos de este cliente se eliminaron: no se le pueden registrar cobros." });
  const location = (await listLocations(executor, businessId)).find((l) => l.id === input.locationId.toLowerCase());
  if (!location) throw new ValidationError({ "body.locationId": "Esa sucursal no existe." });
  const method = await activeMethod(executor, businessId, input.methodId);

  const paymentId = await withTenant(executor, businessId, async (tx) => {
    const [row] = await tx
      .insert(payments)
      .values({
        businessId,
        locationId: location.id,
        clientId: client.id,
        appointmentId: null,
        kind: input.kind,
        amountCents: input.amountCents,
        paymentMethodId: method.id,
        recordedBy: input.recordedBy,
        paidAt: input.paidAt ?? now,
        note: input.note?.trim() || null,
      })
      .returning({ id: payments.id });
    await refreshClientSpent(tx, businessId, client.id);
    return row.id;
  });
  const payment = await getPayment(executor, businessId, paymentId);
  if (!payment) throw paymentNotFound();
  await notifyRecorded(executor, businessId, payment, input.onRecorded);
  return payment;
}

// ── Devolver ────────────────────────────────────────────────────────────────

export interface RefundInput {
  paymentId: string;
  amountCents: number;
  /** Motivo (obligatorio): queda como nota de la devolución. */
  reason: string;
  /** Método por el que se devuelve (default: el del pago original). */
  methodId?: string | null;
  recordedBy: string | null;
  onPaymentsChanged?: PaymentsChangedHook;
  now?: Date;
}

export interface RecordedRefund {
  refund: PaymentView;
  /** El pago devuelto, con lo devuelto al día. */
  original: PaymentView;
}

/**
 * Devuelve (en parte o entero) una seña o un cobro. Errores: 404 si el pago no existe; 409
 * `not_refundable` (una devolución no se devuelve) y `amount_exceeds_refundable`; 400 por
 * monto, motivo o método.
 */
export async function refundPayment(executor: Executor, businessId: string, input: RefundInput): Promise<RecordedRefund> {
  const now = input.now ?? new Date();
  assertAmount(input.amountCents);
  const reason = input.reason.trim();
  if (!reason) throw new ValidationError({ "body.reason": "Contanos el motivo de la devolución." });
  const original = await getPaymentRow(executor, businessId, input.paymentId);
  if (!original) throw paymentNotFound();
  if (original.kind === "refund") throw new HttpError(409, "Una devolución no se puede devolver.", "not_refundable");
  const currency = await currencyOf(executor, businessId);
  const methodId = input.methodId ? (await activeMethod(executor, businessId, input.methodId, { allowInactive: true })).id : original.paymentMethodId;

  const refundId = await withTenant(executor, businessId, async (tx) => {
    if (original.appointmentId) await lockAppointment(tx, original.appointmentId);
    const [locked] = await tx
      .select()
      .from(payments)
      .where(and(eq(payments.businessId, businessId), eq(payments.id, original.id)))
      .for("update");
    if (!locked) throw paymentNotFound();
    const refunded = (await refundedByPayment(tx, businessId, [locked.id])).get(locked.id) ?? 0;
    const remaining = locked.amountCents - refunded;
    if (input.amountCents > remaining) {
      throw new HttpError(
        409,
        remaining <= 0 ? "Ese pago ya se devolvió entero." : `De ese pago quedan ${formatAmount(remaining / 100, currency)} por devolver.`,
        "amount_exceeds_refundable",
      );
    }
    const [row] = await tx
      .insert(payments)
      .values({
        businessId,
        locationId: locked.locationId,
        clientId: locked.clientId,
        appointmentId: locked.appointmentId,
        kind: "refund",
        amountCents: input.amountCents,
        paymentMethodId: methodId,
        recordedBy: input.recordedBy,
        paidAt: now,
        refundOfId: locked.id,
        note: reason.slice(0, 500),
      })
      .returning({ id: payments.id });
    await refreshClientSpent(tx, businessId, locked.clientId);
    if (locked.appointmentId && input.onPaymentsChanged) await input.onPaymentsChanged(tx, businessId, locked.appointmentId);
    return row.id;
  });

  const [refund, updated] = await Promise.all([getPayment(executor, businessId, refundId), getPayment(executor, businessId, original.id)]);
  if (!refund || !updated) throw paymentNotFound();
  return { refund, original: updated };
}

// ── Movimientos ─────────────────────────────────────────────────────────────

export interface ListPaymentsFilter {
  /** Cobrados en [from, to). */
  from: Date;
  to: Date;
  /** null/ausente = todas las sucursales. */
  locationIds?: readonly string[] | null;
  methodId?: string | null;
  clientId?: string | null;
  appointmentId?: string | null;
  kind?: PaymentKind | null;
  /** Tope de filas (default 500, máx. 2000). Los totales son de todo el filtro. */
  limit?: number;
}

export interface PaymentTotals extends CollectedSums {
  /** Señas + cobros. */
  collectedCents: number;
  /** Cobrado − devoluciones. */
  netCents: number;
  count: number;
}

export interface PaymentList {
  items: PaymentView[];
  totals: PaymentTotals;
  /** true si hay más movimientos que los devueltos (subí el tope o acotá el filtro). */
  truncated: boolean;
}

function filterConditions(businessId: string, filter: ListPaymentsFilter): SQL[] | null {
  const conditions: SQL[] = [eq(payments.businessId, businessId), gte(payments.paidAt, filter.from), lt(payments.paidAt, filter.to)];
  if (filter.locationIds) {
    if (filter.locationIds.length === 0) return null;
    conditions.push(inArray(payments.locationId, [...filter.locationIds]));
  }
  if (filter.methodId) conditions.push(eq(payments.paymentMethodId, filter.methodId));
  if (filter.clientId) conditions.push(eq(payments.clientId, filter.clientId));
  if (filter.appointmentId) conditions.push(eq(payments.appointmentId, filter.appointmentId));
  if (filter.kind) conditions.push(eq(payments.kind, filter.kind));
  return conditions;
}

function totalsOf(rows: readonly { kind: string; total: string | number; n: string | number }[]): PaymentTotals {
  const sums = { ...ZERO };
  let count = 0;
  for (const r of rows) {
    const amount = Number(r.total);
    count += Number(r.n);
    if (r.kind === "deposit") sums.depositsCents += amount;
    else if (r.kind === "payment") sums.paymentsCents += amount;
    else sums.refundsCents += amount;
  }
  const collected = sums.depositsCents + sums.paymentsCents;
  return { ...sums, collectedCents: collected, netCents: collected - sums.refundsCents, count };
}

/** Movimientos (cobros, señas y devoluciones) de un rango, del más nuevo al más viejo. */
export async function listPayments(executor: Executor, businessId: string, filter: ListPaymentsFilter): Promise<PaymentList> {
  const conditions = filterConditions(businessId, filter);
  if (!conditions) return { items: [], totals: totalsOf([]), truncated: false };
  const limit = Math.min(Math.max(filter.limit ?? 500, 1), 2000);
  const { rows, sums } = await withTenant(executor, businessId, async (tx) => ({
    rows: await tx
      .select()
      .from(payments)
      .where(and(...conditions))
      .orderBy(desc(payments.paidAt), desc(payments.createdAt))
      .limit(limit + 1),
    sums: await tx
      .select({ kind: payments.kind, total: sql<string>`coalesce(sum(${payments.amountCents}), 0)`, n: sql<string>`count(*)` })
      .from(payments)
      .where(and(...conditions))
      .groupBy(payments.kind),
  }));
  return { items: await toViews(executor, businessId, rows.slice(0, limit)), totals: totalsOf(sums), truncated: rows.length > limit };
}

// ── Pendientes ──────────────────────────────────────────────────────────────

export interface PendingItem {
  appointment: AppointmentView;
  paidCents: number;
  balanceCents: number;
}

export interface PendingList {
  items: PendingItem[];
  count: number;
  balanceCents: number;
}

/**
 * Pendientes de cobro: citas COMPLETADAS (que empezaron en [from, to)) con saldo > 0, de la
 * más nueva a la más vieja.
 */
export async function listPendingBalances(
  executor: Executor,
  businessId: string,
  filter: { from: Date; to: Date; locationIds?: readonly string[] | null; staffId?: string | null; clientId?: string | null },
): Promise<PendingList> {
  const completed = await listAppointments(executor, businessId, {
    from: filter.from,
    to: filter.to,
    locationIds: filter.locationIds ?? null,
    staffId: filter.staffId ?? null,
    clientId: filter.clientId ?? null,
    statuses: ["completed"],
    limit: 5000,
  });
  const sums = await getCollectedByAppointment(
    executor,
    businessId,
    completed.map((a) => a.id),
  );
  const items: PendingItem[] = [];
  for (const appointment of completed) {
    const paid = netOf(sums.get(appointment.id) ?? ZERO);
    const balance = appointment.totalCents - paid;
    if (balance > 0) items.push({ appointment, paidCents: paid, balanceCents: balance });
  }
  items.sort((a, b) => b.appointment.startsAt.localeCompare(a.appointment.startsAt));
  return { items, count: items.length, balanceCents: items.reduce((n, i) => n + i.balanceCents, 0) };
}

// ── Resumen del día (caja) ──────────────────────────────────────────────────

export interface MethodSummary extends CollectedSums {
  methodId: string;
  name: string;
  active: boolean;
  /** Señas + cobros − devoluciones. */
  netCents: number;
  count: number;
}

export interface DailySummary {
  date: string;
  timezone: string;
  currency: string;
  /** Sucursal del resumen (null = las que ve la sesión). */
  locationId: string | null;
  /** Todos los métodos activos (aunque estén en cero) más los inactivos con movimientos. */
  byMethod: MethodSummary[];
  totals: PaymentTotals;
}

/** Resumen de caja de un día local por método: cobros, señas, devoluciones y neto. */
export async function getDailySummary(
  executor: Executor,
  businessId: string,
  input: { date: string; timezone: string; locationIds?: readonly string[] | null; locationId?: string | null },
): Promise<DailySummary> {
  const currency = await currencyOf(executor, businessId);
  const { start, end } = localDayBounds(input.date, input.timezone);
  const conditions = filterConditions(businessId, { from: start, to: end, locationIds: input.locationIds });
  const rows = conditions
    ? await withTenant(executor, businessId, (tx) =>
        tx
          .select({
            methodId: payments.paymentMethodId,
            kind: payments.kind,
            total: sql<string>`coalesce(sum(${payments.amountCents}), 0)`,
            n: sql<string>`count(*)`,
          })
          .from(payments)
          .where(and(...conditions))
          .groupBy(payments.paymentMethodId, payments.kind),
      )
    : [];
  const methods = await listPaymentMethods(executor, businessId);
  const byMethod = methods
    .map((m): MethodSummary => {
      const t = totalsOf(rows.filter((r) => r.methodId === m.id));
      return { methodId: m.id, name: m.name, active: m.active, depositsCents: t.depositsCents, paymentsCents: t.paymentsCents, refundsCents: t.refundsCents, netCents: t.netCents, count: t.count };
    })
    .filter((m) => m.active || m.count > 0);
  return { date: input.date, timezone: input.timezone, currency, locationId: input.locationId ?? null, byMethod, totals: totalsOf(rows) };
}
