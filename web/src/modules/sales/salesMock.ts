import type { TransportRequest, TransportResponse } from "../../lib/api";
import type { Role } from "../../lib/contract";
import { readStorage, writeStorage } from "../../lib/storage";
import type { Appointment } from "../scheduling/schedulingApi";
import { isoToZoned, zonedToIso } from "../settings/zonedTime";
import { shiftDate } from "./format";
import type {
  AppointmentBalance,
  CommissionEntry,
  CommissionRule,
  CommissionSummaryRow,
  DailySummary,
  MethodSummary,
  Payment,
  PaymentKind,
  PaymentMethod,
  PaymentTotals,
  Payout,
  RuleKind,
  RuleScope,
} from "./salesApi";

// ─────────────────────────────────────────────────────────────────────────────
// Ventas y Comisiones en la API simulada (VITE_MOCK_API=1): mismas rutas, sobre, códigos y
// reglas que src/modules/sales y src/modules/commissions (módulo del plan, roles, sucursal,
// tope del saldo, devoluciones con tope por pago, precedencia de reglas, comisión sobre lo
// cobrado prorrateada por línea, liquidaciones que congelan lo liquidado y ajustes). Las
// citas salen de la Agenda simulada. Estado en sessionStorage; la semilla cobra parte de
// las citas completadas de ejemplo.
//
// Simplificación: los movimientos de comisión abiertos se calculan al pedirlos (el real
// los guarda); lo liquidado sí queda congelado en la liquidación, igual que en el backend.
// ─────────────────────────────────────────────────────────────────────────────

export interface MockSalesSession {
  businessId: string;
  userId: string;
  role: Role;
  /** Sin valor = todas las sucursales. */
  locationIds?: string[];
  staffId: string | null;
  modules: string[];
  currency: string;
  timezone: string;
  locations: { id: string; name: string; timezone: string }[];
  staff: { id: string; name: string; color: string | null }[];
  services: { id: string; name: string; categoryId: string | null }[];
  clients: Array<{ id: string; name: string; anonymized: boolean }>;
  /** Citas del negocio (todas las sucursales), de la Agenda simulada. */
  appointments: Appointment[];
}

type StoredPayment = Omit<Payment, "method" | "location" | "client" | "refundedCents"> & { paymentMethodId: string };

interface FrozenEntry {
  id: string;
  lineId: string;
  appointmentId: string;
  staffId: string;
  locationId: string;
  earnedAt: string;
  baseCents: number;
  amountCents: number;
  rule: CommissionEntry["rule"];
  adjustment: boolean;
}

interface StoredPayout extends Omit<Payout, "staff" | "entryCount"> {
  entries: FrozenEntry[];
}

interface SalesBiz {
  methods: PaymentMethod[];
  payments: StoredPayment[];
  rules: CommissionRule[];
  payouts: StoredPayout[];
}

interface State {
  seq: number;
  businesses: Record<string, SalesBiz>;
}

const STATE_KEY = "selyon.mock.sales";
const DESK: Role[] = ["owner", "admin", "front_desk"];
const MANAGERS: Role[] = ["owner", "admin"];
const DEFAULT_METHODS = ["Efectivo", "SINPE Móvil", "Tarjeta", "Transferencia"];

function loadState(): State {
  try {
    const raw = readStorage(STATE_KEY, "session");
    if (raw) return JSON.parse(raw) as State;
  } catch {
    // estado roto: se arranca de cero
  }
  return { seq: 0, businesses: {} };
}

function saveState(state: State): void {
  writeStorage(STATE_KEY, JSON.stringify(state), "session");
}

function nextId(state: State): string {
  state.seq += 1;
  return `c0000000-0000-4000-8000-${String(state.seq).padStart(12, "0")}`;
}

// ── Respuestas ──────────────────────────────────────────────────────────────

const ok = (data: unknown, status = 200): TransportResponse => ({ status, payload: { ok: true, data } });
const noContent = (): TransportResponse => ({ status: 204, payload: undefined });
const fail = (status: number, code: string, error: string, fields?: Record<string, string>): TransportResponse => ({
  status,
  payload: { ok: false, error, code, ...(fields ? { fields } : {}) },
});
const invalid = (fields: Record<string, string>) => fail(400, "validation_error", "Datos inválidos: revisá los campos marcados.", fields);
const forbiddenRole = () => fail(403, "forbidden_role", "No tenés permiso para esta acción.");
const notInPlan = () => fail(403, "module_not_in_plan", "Esta función no está incluida en el plan del negocio.");
const locationForbidden = () => fail(403, "location_forbidden", "No tenés acceso a esta sucursal.");

type Body = Record<string, unknown>;
const asBody = (body: unknown): Body => (typeof body === "object" && body !== null ? (body as Body) : {});
const text = (b: Body, key: string) => (typeof b[key] === "string" ? (b[key] as string).trim() : "");
const intOf = (b: Body, key: string): number | null => (typeof b[key] === "number" && Number.isInteger(b[key]) ? (b[key] as number) : null);

function money(cents: number, currency: string): string {
  try {
    return new Intl.NumberFormat("es-CR", { style: "currency", currency, maximumFractionDigits: cents % 100 === 0 ? 0 : 2 }).format(cents / 100);
  } catch {
    return String(cents / 100);
  }
}

// ── Cálculos (espejo del backend) ───────────────────────────────────────────

function sums(list: StoredPayment[]) {
  const s = { depositsCents: 0, paymentsCents: 0, refundsCents: 0 };
  for (const p of list) {
    if (p.kind === "deposit") s.depositsCents += p.amountCents;
    else if (p.kind === "payment") s.paymentsCents += p.amountCents;
    else s.refundsCents += p.amountCents;
  }
  return s;
}

function totalsOf(list: StoredPayment[]): PaymentTotals {
  const s = sums(list);
  const collected = s.depositsCents + s.paymentsCents;
  return { ...s, collectedCents: collected, netCents: collected - s.refundsCents, count: list.length };
}

const netOf = (list: StoredPayment[]) => {
  const s = sums(list);
  return s.depositsCents + s.paymentsCents - s.refundsCents;
};

function prorate(amount: number, prices: number[]): number[] {
  const total = prices.reduce((n, p) => n + p, 0);
  if (prices.length === 0) return [];
  if (total <= 0) return prices.map((_, i) => (i === 0 ? amount : 0));
  const exact = prices.map((p) => (amount * p) / total);
  const out = exact.map((x) => Math.floor(x));
  let rest = amount - out.reduce((n, x) => n + x, 0);
  const order = exact.map((x, i) => ({ i, f: x - Math.floor(x) })).sort((a, b) => b.f - a.f || a.i - b.i);
  for (let k = 0; rest > 0 && k < order.length; k++, rest--) out[order[k].i] += 1;
  return out;
}

function commissionFor(rule: { kind: RuleKind; value: number }, base: number, price: number): number {
  if (rule.kind === "percent") return Math.round((base * rule.value) / 10_000);
  if (price <= 0) return rule.value;
  return Math.round((rule.value * Math.min(Math.max(base, 0), price)) / price);
}

const SCOPE_ORDER: Record<RuleScope, number> = { staff_service: 0, service: 1, category: 2, staff: 3, general: 4 };

function scopeOf(r: { staffId: string | null; serviceId: string | null; categoryId: string | null }): RuleScope {
  if (r.staffId && r.serviceId) return "staff_service";
  if (r.serviceId) return "service";
  if (r.categoryId) return "category";
  if (r.staffId) return "staff";
  return "general";
}

function resolveRule(rules: CommissionRule[], staffId: string, serviceId: string | null, categoryId: string | null): CommissionRule | null {
  const active = rules.filter((r) => r.active);
  return (
    (serviceId ? active.find((r) => r.scope === "staff_service" && r.staffId === staffId && r.serviceId === serviceId) : undefined) ??
    (serviceId ? active.find((r) => r.scope === "service" && r.serviceId === serviceId) : undefined) ??
    (categoryId ? active.find((r) => r.scope === "category" && r.categoryId === categoryId) : undefined) ??
    active.find((r) => r.scope === "staff" && r.staffId === staffId) ??
    active.find((r) => r.scope === "general") ??
    null
  );
}

// ── Semilla ─────────────────────────────────────────────────────────────────

function seedBiz(state: State, session: MockSalesSession): SalesBiz {
  const methods: PaymentMethod[] = DEFAULT_METHODS.map((name, position) => ({ id: nextId(state), name, active: true, position }));
  const payments: StoredPayment[] = [];
  const completed = session.appointments.filter((a) => a.status === "completed" && a.totalCents > 0).sort((x, y) => x.startsAt.localeCompare(y.startsAt));
  completed.forEach((a, i) => {
    // Dos de cada tres, pagadas enteras; la tercera, solo con una seña (queda pendiente).
    const deposit = i % 3 === 2;
    const at = deposit ? a.startsAt : a.endsAt;
    payments.push({
      id: nextId(state),
      kind: deposit ? "deposit" : "payment",
      amountCents: deposit ? Math.round(a.totalCents / 2) : a.totalCents,
      paidAt: at,
      createdAt: at,
      paymentMethodId: methods[deposit ? 1 : i % 3].id,
      locationId: a.locationId,
      clientId: a.clientId,
      appointmentId: a.id,
      refundOfId: null,
      note: null,
      recordedBy: null,
    });
  });
  const now = new Date().toISOString();
  const rules: CommissionRule[] = [
    { id: nextId(state), scope: "general", staffId: null, serviceId: null, categoryId: null, kind: "percent", value: 1000, active: true, createdAt: now, updatedAt: now },
  ];
  return { methods, payments, rules, payouts: [] };
}

// ── Vistas ──────────────────────────────────────────────────────────────────

function paymentView(session: MockSalesSession, biz: SalesBiz, p: StoredPayment): Payment {
  const m = biz.methods.find((x) => x.id === p.paymentMethodId);
  const l = session.locations.find((x) => x.id === p.locationId);
  const c = session.clients.find((x) => x.id === p.clientId);
  const refunded = biz.payments.filter((r) => r.refundOfId === p.id).reduce((n, r) => n + r.amountCents, 0);
  const { paymentMethodId: _m, ...rest } = p;
  return {
    ...rest,
    method: m ? { id: m.id, name: m.name } : null,
    location: l ? { id: l.id, name: l.name } : null,
    client: c ? { id: c.id, name: c.anonymized ? "Cliente eliminado" : c.name } : null,
    refundedCents: p.kind === "refund" ? 0 : refunded,
  };
}

function balanceOf(session: MockSalesSession, biz: SalesBiz, a: Appointment): AppointmentBalance {
  const list = biz.payments.filter((p) => p.appointmentId === a.id).sort((x, y) => y.paidAt.localeCompare(x.paidAt));
  const s = sums(list);
  const paid = netOf(list);
  return {
    appointmentId: a.id,
    status: a.status,
    currency: session.currency,
    totalCents: a.totalCents,
    ...s,
    paidCents: paid,
    balanceCents: Math.max(0, a.totalCents - paid),
    payments: list.map((p) => paymentView(session, biz, p)),
  };
}

/** Movimientos de comisión: lo liquidado (congelado) más lo abierto, calculado ahora. */
function commissionEntries(session: MockSalesSession, biz: SalesBiz): CommissionEntry[] {
  const now = new Date().toISOString();
  const frozenByLine = new Map<string, { entry: FrozenEntry; payout: StoredPayout }[]>();
  for (const payout of biz.payouts) for (const entry of payout.entries) frozenByLine.set(entry.lineId, [...(frozenByLine.get(entry.lineId) ?? []), { entry, payout }]);
  const out: CommissionEntry[] = [];
  const view = (a: Appointment | undefined, e: FrozenEntry, status: "pending" | "paid", payoutId: string | null, id: string): CommissionEntry => {
    const s = session.staff.find((x) => x.id === e.staffId);
    const line = a?.services.find((l) => l.id === e.lineId);
    return {
      id,
      staffId: e.staffId,
      staff: s ? { id: s.id, name: s.name, color: s.color } : null,
      appointmentId: e.appointmentId,
      appointmentServiceId: e.lineId,
      locationId: e.locationId,
      earnedAt: e.earnedAt,
      appointmentStartsAt: a?.startsAt ?? null,
      serviceName: line?.name ?? null,
      clientName: a?.client?.name ?? null,
      baseCents: e.baseCents,
      amountCents: e.amountCents,
      rule: e.rule,
      status,
      payoutId,
      adjustment: e.adjustment,
      createdAt: e.earnedAt,
      updatedAt: e.earnedAt,
    };
  };
  for (const [, frozen] of frozenByLine) {
    for (const { entry, payout } of frozen) {
      out.push(view(session.appointments.find((a) => a.id === entry.appointmentId), entry, payout.paidAt ? "paid" : "pending", payout.id, entry.id));
    }
  }
  for (const a of session.appointments.filter((x) => x.status === "completed")) {
    const collected = Math.min(a.totalCents, Math.max(0, netOf(biz.payments.filter((p) => p.appointmentId === a.id))));
    const bases = prorate(
      collected,
      a.services.map((l) => l.priceCents),
    );
    a.services.forEach((line, i) => {
      const frozen = (frozenByLine.get(line.id) ?? []).map((f) => f.entry);
      const category = session.services.find((s) => s.id === line.serviceId)?.categoryId ?? null;
      const found = frozen[0]?.rule ?? (() => {
        const r = resolveRule(biz.rules, a.staffId, line.serviceId, category);
        return r ? { ruleId: r.id, kind: r.kind, value: r.value } : null;
      })();
      if (!found) return;
      const open = commissionFor(found, bases[i], line.priceCents) - frozen.reduce((n, e) => n + e.amountCents, 0);
      if (open === 0) return;
      const entry: FrozenEntry = {
        id: `open-${line.id}`,
        lineId: line.id,
        appointmentId: a.id,
        staffId: a.staffId,
        locationId: a.locationId,
        earnedAt: frozen.length ? now : a.startsAt,
        baseCents: bases[i] - frozen.reduce((n, e) => n + e.baseCents, 0),
        amountCents: open,
        rule: found,
        adjustment: frozen.length > 0,
      };
      out.push(view(a, entry, "pending", null, entry.id));
    });
  }
  return out.sort((x, y) => y.earnedAt.localeCompare(x.earnedAt));
}

function payoutView(session: MockSalesSession, p: StoredPayout): Payout {
  const s = session.staff.find((x) => x.id === p.staffId);
  const { entries, ...rest } = p;
  return { ...rest, staff: s ? { id: s.id, name: s.name, color: s.color } : null, entryCount: entries.length };
}

// ── Rutas ───────────────────────────────────────────────────────────────────

/** ¿La ruta es de Ventas o Comisiones? (para que lib/mockApi.ts la mande acá). */
export function isSalesMockPath(path: string): boolean {
  return (
    path.startsWith("/settings/payment-methods") ||
    path.startsWith("/settings/commission-rules") ||
    path.startsWith("/sales/") ||
    path.startsWith("/commissions/") ||
    /^\/appointments\/[^/]+\/(payments|balance)$/.test(path)
  );
}

/** Rutas de Ventas y Comisiones del mock; null si la ruta no es suya. */
export function routeSalesMock(req: TransportRequest, session: MockSalesSession): TransportResponse | null {
  const url = new URL(req.path, "http://mock");
  const path = url.pathname;
  if (!isSalesMockPath(path)) return null;
  const commissions = path.startsWith("/commissions/") || path.startsWith("/settings/commission-rules");
  if (!session.modules.includes(commissions ? "commissions" : "sales")) return notInPlan();

  const state = loadState();
  const biz = (state.businesses[session.businessId] ??= seedBiz(state, session));
  const save = () => saveState(state);
  const body = asBody(req.body);
  const header = req.headers["X-Location-Id"] ?? null;
  const canSee = (locationId: string) => !session.locationIds || session.locationIds.includes(locationId);
  const isManager = MANAGERS.includes(session.role);
  const isDesk = DESK.includes(session.role);
  const methodsSorted = () => [...biz.methods].sort((a, b) => a.position - b.position);
  const tz = (locationId: string | null) => session.locations.find((l) => l.id === locationId)?.timezone ?? session.timezone;
  const localDay = (iso: string, zone: string) => isoToZoned(iso, zone).date;
  const today = (zone: string) => localDay(new Date().toISOString(), zone);

  /** Sucursales de un listado: query, header o las de la sesión (null = todas). */
  const scope = (): { ids: string[] | null; id: string | null } | TransportResponse => {
    const id = url.searchParams.get("locationId") || header;
    if (id) return canSee(id) ? { ids: [id], id } : locationForbidden();
    return { ids: session.locationIds ?? null, id: null };
  };
  const isResponse = (x: unknown): x is TransportResponse => typeof x === "object" && x !== null && "status" in x && "payload" in x;

  // ── Métodos de pago ──
  if (path === "/settings/payment-methods" && req.method === "GET") return ok(methodsSorted());
  if (path === "/settings/payment-methods" && req.method === "POST") {
    if (!isManager) return forbiddenRole();
    const name = text(body, "name");
    if (!name) return invalid({ "body.name": "Escribí el nombre." });
    if (biz.methods.some((m) => m.name.toLocaleLowerCase("es") === name.toLocaleLowerCase("es"))) return invalid({ "body.name": "Ya hay un método de pago con ese nombre." });
    const method: PaymentMethod = { id: nextId(state), name, active: true, position: biz.methods.length };
    biz.methods.push(method);
    save();
    return ok(method, 201);
  }
  if (path === "/settings/payment-methods/order" && req.method === "PUT") {
    if (!isManager) return forbiddenRole();
    const ids = Array.isArray(body.ids) ? (body.ids as string[]) : [];
    if (ids.length !== biz.methods.length || !biz.methods.every((m) => ids.includes(m.id))) {
      return invalid({ "body.ids": "La lista tiene que traer todos los elementos actuales, una vez cada uno." });
    }
    ids.forEach((id, position) => {
      const m = biz.methods.find((x) => x.id === id);
      if (m) m.position = position;
    });
    save();
    return ok(methodsSorted());
  }
  const methodMatch = /^\/settings\/payment-methods\/([^/]+)$/.exec(path);
  if (methodMatch) {
    if (!isManager) return forbiddenRole();
    const method = biz.methods.find((m) => m.id === methodMatch[1]);
    if (!method) return fail(404, "not_found", "Ese método de pago no existe.");
    if (req.method === "PATCH") {
      const name = body.name === undefined ? undefined : text(body, "name");
      if (name !== undefined && !name) return invalid({ "body.name": "Escribí el nombre." });
      if (name && biz.methods.some((m) => m.id !== method.id && m.name.toLocaleLowerCase("es") === name.toLocaleLowerCase("es"))) {
        return invalid({ "body.name": "Ya hay un método de pago con ese nombre." });
      }
      if (name) method.name = name;
      if (typeof body.active === "boolean") method.active = body.active;
      save();
      return ok(method);
    }
    if (req.method === "DELETE") {
      if (biz.payments.some((p) => p.paymentMethodId === method.id)) {
        method.active = false;
        save();
        return ok({ deleted: false, method });
      }
      biz.methods = biz.methods.filter((m) => m.id !== method.id);
      save();
      return ok({ deleted: true });
    }
  }

  // ── Cobrar desde la cita y saldo ──
  const apptMatch = /^\/appointments\/([^/]+)\/(payments|balance)$/.exec(path);
  if (apptMatch) {
    const appointment = session.appointments.find((a) => a.id === apptMatch[1]);
    if (apptMatch[2] === "payments" && req.method === "POST" && !isDesk) return forbiddenRole();
    if (!appointment) return fail(404, "not_found", "No encontramos esa cita.");
    if (!canSee(appointment.locationId)) return locationForbidden();
    if (session.role === "staff" && appointment.staffId !== session.staffId) return fail(403, "own_appointments_only", "Solo podés ver tus propias citas.");
    if (apptMatch[2] === "balance") return ok(balanceOf(session, biz, appointment));
    const kind = text(body, "kind") || "payment";
    const amount = intOf(body, "amountCents");
    const methodId = text(body, "methodId");
    const fields: Record<string, string> = {};
    if (kind !== "payment" && kind !== "deposit") fields["body.kind"] = "Tipo inválido.";
    if (amount === null || amount <= 0) fields["body.amountCents"] = "El monto tiene que ser mayor que cero.";
    const method = biz.methods.find((m) => m.id === methodId && m.active);
    if (!method) fields["body.methodId"] = "Ese método de pago no existe o está desactivado.";
    if (text(body, "currency") && text(body, "currency").toUpperCase() !== session.currency) fields["body.currency"] = `Los montos van en la moneda del negocio (${session.currency}).`;
    if (Object.keys(fields).length) return invalid(fields);
    if (appointment.status === "cancelled" || appointment.status === "no_show") {
      return fail(409, "appointment_closed", "No se puede cobrar una cita cancelada o marcada como no asistió. Si dejó una seña, podés devolverla desde Ventas › Cobros.");
    }
    if (kind === "deposit" && appointment.status === "completed") return fail(409, "deposit_not_allowed", "La cita ya se completó: registrá un pago en vez de una seña.");
    const due = balanceOf(session, biz, appointment).balanceCents;
    if ((amount as number) > due) {
      return fail(409, "amount_exceeds_balance", due === 0 ? "Esta cita ya está pagada." : `El monto supera el saldo de la cita (${money(due, session.currency)}).`);
    }
    const now = new Date().toISOString();
    const stored: StoredPayment = {
      id: nextId(state),
      kind: kind as PaymentKind,
      amountCents: amount as number,
      paidAt: now,
      paymentMethodId: (method as PaymentMethod).id,
      locationId: appointment.locationId,
      clientId: appointment.clientId,
      appointmentId: appointment.id,
      refundOfId: null,
      note: text(body, "note") || null,
      recordedBy: session.userId,
      createdAt: now,
    };
    biz.payments.push(stored);
    save();
    return ok({ payment: paymentView(session, biz, stored), balance: balanceOf(session, biz, appointment) }, 201);
  }

  // ── Cobros ──
  if (path === "/sales/payments" && req.method === "POST") {
    if (!isDesk) return forbiddenRole();
    const clientId = text(body, "clientId");
    const locationId = text(body, "locationId");
    const kind = text(body, "kind") || "payment";
    const amount = intOf(body, "amountCents");
    const method = biz.methods.find((m) => m.id === text(body, "methodId") && m.active);
    if (locationId && !canSee(locationId)) return locationForbidden();
    const fields: Record<string, string> = {};
    if (!session.clients.some((c) => c.id === clientId && !c.anonymized)) fields["body.clientId"] = "Ese cliente no existe.";
    if (!session.locations.some((l) => l.id === locationId)) fields["body.locationId"] = "Esa sucursal no existe.";
    if (amount === null || amount <= 0) fields["body.amountCents"] = "El monto tiene que ser mayor que cero.";
    if (!method) fields["body.methodId"] = "Ese método de pago no existe o está desactivado.";
    if (kind !== "payment" && kind !== "deposit") fields["body.kind"] = "Tipo inválido.";
    if (Object.keys(fields).length) return invalid(fields);
    const now = new Date().toISOString();
    const stored: StoredPayment = {
      id: nextId(state),
      kind: kind as PaymentKind,
      amountCents: amount as number,
      paidAt: now,
      paymentMethodId: (method as PaymentMethod).id,
      locationId,
      clientId,
      appointmentId: null,
      refundOfId: null,
      note: text(body, "note") || null,
      recordedBy: session.userId,
      createdAt: now,
    };
    biz.payments.push(stored);
    save();
    return ok(paymentView(session, biz, stored), 201);
  }

  if (path === "/sales/payments" && req.method === "GET") {
    if (!isDesk) return forbiddenRole();
    const s = scope();
    if (isResponse(s)) return s;
    const zone = tz(s.id);
    const to = url.searchParams.get("to") || today(zone);
    const from = url.searchParams.get("from") || shiftDate(to, -29);
    if (from > to) return invalid({ "query.to": "El fin tiene que ser igual o posterior al inicio." });
    const methodId = url.searchParams.get("methodId");
    const kind = url.searchParams.get("kind");
    const clientId = url.searchParams.get("clientId");
    const list = biz.payments
      .filter((p) => {
        const day = localDay(p.paidAt, zone);
        return day >= from && day <= to && (!s.ids || s.ids.includes(p.locationId));
      })
      .filter((p) => (!methodId || p.paymentMethodId === methodId) && (!kind || p.kind === kind) && (!clientId || p.clientId === clientId))
      .sort((x, y) => y.paidAt.localeCompare(x.paidAt));
    return ok({ items: list.slice(0, 500).map((p) => paymentView(session, biz, p)), totals: totalsOf(list), truncated: list.length > 500 });
  }

  const refundMatch = /^\/sales\/payments\/([^/]+)\/refund$/.exec(path);
  if (refundMatch && req.method === "POST") {
    if (!isManager) return forbiddenRole();
    const original = biz.payments.find((p) => p.id === refundMatch[1]);
    if (!original) return fail(404, "not_found", "No encontramos ese pago.");
    if (!canSee(original.locationId)) return locationForbidden();
    const amount = intOf(body, "amountCents");
    const reason = text(body, "reason");
    const fields: Record<string, string> = {};
    if (amount === null || amount <= 0) fields["body.amountCents"] = "El monto tiene que ser mayor que cero.";
    if (!reason) fields["body.reason"] = "Contanos el motivo de la devolución.";
    if (Object.keys(fields).length) return invalid(fields);
    if (original.kind === "refund") return fail(409, "not_refundable", "Una devolución no se puede devolver.");
    const remaining = original.amountCents - biz.payments.filter((r) => r.refundOfId === original.id).reduce((n, r) => n + r.amountCents, 0);
    if ((amount as number) > remaining) {
      return fail(409, "amount_exceeds_refundable", remaining <= 0 ? "Ese pago ya se devolvió entero." : `De ese pago quedan ${money(remaining, session.currency)} por devolver.`);
    }
    const now = new Date().toISOString();
    const refund: StoredPayment = {
      ...original,
      id: nextId(state),
      kind: "refund",
      amountCents: amount as number,
      paidAt: now,
      createdAt: now,
      paymentMethodId: text(body, "methodId") || original.paymentMethodId,
      refundOfId: original.id,
      note: reason,
      recordedBy: session.userId,
    };
    biz.payments.push(refund);
    save();
    return ok({ refund: paymentView(session, biz, refund), original: paymentView(session, biz, original) }, 201);
  }

  // ── Pendientes y caja ──
  if (path === "/sales/pending" && req.method === "GET") {
    if (!isDesk) return forbiddenRole();
    const s = scope();
    if (isResponse(s)) return s;
    const zone = tz(s.id);
    const to = url.searchParams.get("to") || today(zone);
    const from = url.searchParams.get("from") || shiftDate(to, -89);
    const items = session.appointments
      .filter((a) => a.status === "completed" && (!s.ids || s.ids.includes(a.locationId)))
      .filter((a) => {
        const day = localDay(a.startsAt, zone);
        return day >= from && day <= to;
      })
      .map((a) => {
        const b = balanceOf(session, biz, a);
        return { appointment: a, paidCents: b.paidCents, balanceCents: a.totalCents - b.paidCents };
      })
      .filter((i) => i.balanceCents > 0)
      .sort((x, y) => y.appointment.startsAt.localeCompare(x.appointment.startsAt));
    return ok({ items, count: items.length, balanceCents: items.reduce((n, i) => n + i.balanceCents, 0) });
  }

  if (path === "/sales/summary" && req.method === "GET") {
    if (!isDesk) return forbiddenRole();
    const s = scope();
    if (isResponse(s)) return s;
    const zone = tz(s.id);
    const date = url.searchParams.get("date") || today(zone);
    const day = biz.payments.filter((p) => localDay(p.paidAt, zone) === date && (!s.ids || s.ids.includes(p.locationId)));
    const byMethod: MethodSummary[] = methodsSorted()
      .map((m) => {
        const t = totalsOf(day.filter((p) => p.paymentMethodId === m.id));
        return { methodId: m.id, name: m.name, active: m.active, depositsCents: t.depositsCents, paymentsCents: t.paymentsCents, refundsCents: t.refundsCents, netCents: t.netCents, count: t.count };
      })
      .filter((m) => m.active || m.count > 0);
    const summary: DailySummary = { date, timezone: zone, currency: session.currency, locationId: s.id, byMethod, totals: totalsOf(day) };
    return ok(summary);
  }

  // ── Reglas de comisión ──
  if (path.startsWith("/settings/commission-rules")) {
    if (!isManager) return forbiddenRole();
    const sorted = () => [...biz.rules].sort((a, b) => SCOPE_ORDER[a.scope] - SCOPE_ORDER[b.scope]);
    const ruleMatch = /^\/settings\/commission-rules\/([^/]+)$/.exec(path);
    const value = intOf(body, "value");
    const kind = text(body, "kind") as RuleKind;
    if (path === "/settings/commission-rules" && req.method === "GET") return ok(sorted());
    if (path === "/settings/commission-rules" && req.method === "POST") {
      const staffId = text(body, "staffId") || null;
      const serviceId = text(body, "serviceId") || null;
      const categoryId = text(body, "categoryId") || null;
      const fields: Record<string, string> = {};
      if (kind !== "percent" && kind !== "fixed") fields["body.kind"] = "Tipo inválido.";
      if (value === null || value < 0) fields["body.value"] = "El valor no puede ser negativo.";
      else if (kind === "percent" && value > 10_000) fields["body.value"] = "El porcentaje va de 0 a 100 % (0 a 10000 puntos básicos).";
      if (serviceId && categoryId) fields["body.categoryId"] = "Elegí un servicio o una categoría, no los dos.";
      if (staffId && categoryId) fields["body.categoryId"] = "Por profesional, la regla puede ser general o de un servicio (no de una categoría).";
      if (staffId && !session.staff.some((s) => s.id === staffId)) fields["body.staffId"] = "Ese profesional no existe.";
      if (serviceId && !session.services.some((s) => s.id === serviceId)) fields["body.serviceId"] = "Ese servicio no existe.";
      if (categoryId && !session.services.some((s) => s.categoryId === categoryId)) fields["body.categoryId"] = "Esa categoría no existe.";
      if (Object.keys(fields).length) return invalid(fields);
      const scopeName = scopeOf({ staffId, serviceId, categoryId });
      if (biz.rules.some((r) => r.staffId === staffId && r.serviceId === serviceId && r.categoryId === categoryId)) {
        return fail(409, "duplicate_rule", "Ya hay una regla para ese alcance: editala en vez de crear otra.");
      }
      const now = new Date().toISOString();
      const rule: CommissionRule = { id: nextId(state), scope: scopeName, staffId, serviceId, categoryId, kind, value: value as number, active: body.active !== false, createdAt: now, updatedAt: now };
      biz.rules.push(rule);
      save();
      return ok(rule, 201);
    }
    if (ruleMatch) {
      const rule = biz.rules.find((r) => r.id === ruleMatch[1]);
      if (!rule) return fail(404, "not_found", "Esa regla de comisión no existe.");
      if (req.method === "PATCH") {
        const nextKind = kind || rule.kind;
        const nextValue = value ?? rule.value;
        if (nextValue < 0 || (nextKind === "percent" && nextValue > 10_000)) return invalid({ "body.value": "El porcentaje va de 0 a 100 % (0 a 10000 puntos básicos)." });
        rule.kind = nextKind;
        rule.value = nextValue;
        if (typeof body.active === "boolean") rule.active = body.active;
        rule.updatedAt = new Date().toISOString();
        save();
        return ok(rule);
      }
      if (req.method === "DELETE") {
        biz.rules = biz.rules.filter((r) => r.id !== rule.id);
        save();
        return noContent();
      }
    }
    return fail(405, "method_not_allowed", "Método no permitido.");
  }

  // ── Comisiones ──
  if (path.startsWith("/commissions/")) {
    const viewer = isManager || session.role === "staff";
    if (!viewer) return forbiddenRole();
    const isStaff = session.role === "staff";
    const requested = url.searchParams.get("staffId");
    if (isStaff && requested && requested !== session.staffId) return fail(403, "own_commissions_only", "Solo podés ver tus propias comisiones.");
    const staffScope = isStaff ? session.staffId : requested;
    const zone = session.timezone;
    const to = url.searchParams.get("to") || today(zone);
    const from = url.searchParams.get("from") || `${to.slice(0, 8)}01`;
    const inRange = (iso: string) => {
      const day = localDay(iso, zone);
      return day >= from && day <= to;
    };
    const visible = (e: CommissionEntry) => (isStaff ? e.staffId === session.staffId : !session.locationIds || session.locationIds.includes(e.locationId));

    if (path === "/commissions/entries" && req.method === "GET") {
      if (isStaff && !session.staffId) return ok({ items: [], totalCents: 0, count: 0, truncated: false });
      const status = url.searchParams.get("status");
      const payoutId = url.searchParams.get("payoutId");
      const items = commissionEntries(session, biz)
        .filter((e) => visible(e) && inRange(e.earnedAt) && (!staffScope || e.staffId === staffScope) && (!payoutId || e.payoutId === payoutId))
        .filter((e) => !status || (status === "open" ? !e.payoutId : status === "paid" ? e.status === "paid" : Boolean(e.payoutId) && e.status === "pending"));
      return ok({ items, totalCents: items.reduce((n, e) => n + e.amountCents, 0), count: items.length, truncated: false });
    }

    if (path === "/commissions/summary" && req.method === "GET") {
      const zero = { count: 0, baseCents: 0, amountCents: 0, openCents: 0, inPayoutCents: 0, paidCents: 0 };
      if (isStaff && !session.staffId) return ok({ rows: [], totals: zero });
      const rows = new Map<string, CommissionSummaryRow>();
      for (const e of commissionEntries(session, biz).filter((x) => visible(x) && inRange(x.earnedAt) && (!staffScope || x.staffId === staffScope))) {
        const s = session.staff.find((x) => x.id === e.staffId);
        const r = rows.get(e.staffId) ?? { staffId: e.staffId, name: s?.name ?? "Profesional", color: s?.color ?? null, ...zero };
        r.count += 1;
        r.baseCents += e.baseCents;
        r.amountCents += e.amountCents;
        if (!e.payoutId) r.openCents += e.amountCents;
        else if (e.status === "pending") r.inPayoutCents += e.amountCents;
        else r.paidCents += e.amountCents;
        rows.set(e.staffId, r);
      }
      const list = [...rows.values()].sort((a, b) => b.amountCents - a.amountCents);
      const totals = list.reduce(
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
      return ok({ rows: list, totals });
    }

    if (path === "/commissions/payouts" && req.method === "GET") {
      if (isStaff && !session.staffId) return ok([]);
      if (!isStaff && session.locationIds) return locationForbidden();
      return ok(
        biz.payouts
          .filter((p) => !staffScope || p.staffId === staffScope)
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
          .map((p) => payoutView(session, p)),
      );
    }

    if (path === "/commissions/payouts" && req.method === "POST") {
      if (!isManager) return forbiddenRole();
      if (session.locationIds) return locationForbidden();
      const staffId = text(body, "staffId");
      const periodStart = text(body, "periodStart");
      const periodEnd = text(body, "periodEnd");
      if (!session.staff.some((s) => s.id === staffId)) return invalid({ "body.staffId": "Ese profesional no existe." });
      if (!periodStart || !periodEnd || periodStart > periodEnd) return invalid({ "body.periodEnd": "El fin del período tiene que ser igual o posterior al inicio." });
      const end = zonedToIso(shiftDate(periodEnd, 1), "00:00", zone);
      const open = commissionEntries(session, biz).filter((e) => e.staffId === staffId && !e.payoutId && e.amountCents !== 0 && e.earnedAt < end);
      if (open.length === 0) return fail(409, "nothing_to_pay", "No hay comisiones sin liquidar hasta esa fecha.");
      const total = open.reduce((n, e) => n + e.amountCents, 0);
      if (total <= 0) return fail(409, "negative_payout", "Los ajustes por devoluciones dejan el total en cero o menos: esperá a que haya más comisiones.");
      const id = nextId(state);
      const payout: StoredPayout = {
        id,
        staffId,
        periodStart,
        periodEnd,
        totalCents: total,
        paidAt: null,
        paidBy: null,
        note: text(body, "note") || null,
        createdAt: new Date().toISOString(),
        entries: open.map((e) => ({
          id: `${id}-${e.appointmentServiceId}`,
          lineId: e.appointmentServiceId,
          appointmentId: e.appointmentId,
          staffId: e.staffId,
          locationId: e.locationId,
          earnedAt: e.earnedAt,
          baseCents: e.baseCents,
          amountCents: e.amountCents,
          rule: e.rule,
          adjustment: e.adjustment,
        })),
      };
      biz.payouts.push(payout);
      save();
      return ok(payoutView(session, payout), 201);
    }

    const payoutMatch = /^\/commissions\/payouts\/([^/]+)(\/paid)?$/.exec(path);
    if (payoutMatch) {
      if (!isManager) return forbiddenRole();
      if (session.locationIds) return locationForbidden();
      const payout = biz.payouts.find((p) => p.id === payoutMatch[1]);
      if (!payout) return fail(404, "not_found", "Esa liquidación no existe.");
      if (payoutMatch[2] && req.method === "POST") {
        if (payout.paidAt) return fail(409, "already_paid", "Esa liquidación ya está pagada.");
        payout.paidAt = new Date().toISOString();
        payout.paidBy = session.userId;
        save();
        return ok(payoutView(session, payout));
      }
      if (!payoutMatch[2] && req.method === "DELETE") {
        if (payout.paidAt) return fail(409, "already_paid", "Una liquidación pagada no se puede anular.");
        biz.payouts = biz.payouts.filter((p) => p.id !== payout.id);
        save();
        return noContent();
      }
    }
  }

  return fail(404, "not_found", "Ruta inexistente en el mock.");
}
