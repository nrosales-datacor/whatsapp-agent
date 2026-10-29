import type { TransportRequest, TransportResponse } from "../../lib/api";
import type { Role } from "../../lib/contract";
import type { ClientStatusCounts } from "../clients/clientsApi";
import type { CommissionEntry, Payment } from "../sales/salesApi";
import { workingWindows } from "../scheduling/agendaLayout";
import type { Appointment, AppointmentStatus } from "../scheduling/schedulingApi";
import type { MockAgendaSetup } from "../settings/settingsMock";
import { isoToZoned } from "../settings/zonedTime";
import type {
  AppointmentChannel,
  AtRiskClient,
  ChannelsReport,
  ClientsReport,
  CollectedGroup,
  HomeOverview,
  RangeView,
  ReportId,
  SalesReport,
  ServicesReport,
  StaffReport,
} from "./reportsApi";

// ─────────────────────────────────────────────────────────────────────────────
// Reportes e Inicio completo en la API simulada (VITE_MOCK_API=1): mismas rutas, sobre,
// códigos y reglas que src/modules/reports (módulo del plan, roles, sucursal, rango) y
// los mismos números calculados sobre las citas de la Agenda simulada y los pagos de
// Ventas simulada. El estado de la cartera (en riesgo del Inicio y desglose por estado del
// reporte de clientes) sale del CRM simulado (clientsMock), con las mismas reglas que la
// lista. Simplificación: las altas de clientes son los clientes con su primera visita en el
// período.
// ─────────────────────────────────────────────────────────────────────────────

export interface MockReportsSession {
  role: Role;
  modules: string[];
  /** Sin valor = todas las sucursales. */
  locationIds?: string[];
  currency: string;
  timezone: string;
  setup: MockAgendaSetup;
  appointments: Appointment[];
  payments: Payment[];
  commissions: CommissionEntry[];
  /** Estado de la cartera según el CRM simulado (`mockClientStatusOverview`). */
  clientStatus: { counts: ClientStatusCounts; atRisk: { count: number; items: AtRiskClient[] } };
}

const REPORT_IDS: readonly ReportId[] = ["sales", "services", "staff", "clients", "channels"];
const CHANNELS: readonly AppointmentChannel[] = ["whatsapp_ai", "panel", "phone", "walk_in", "web"];
const CHANNEL_LABELS: Record<AppointmentChannel, string> = {
  whatsapp_ai: "Agente de WhatsApp",
  panel: "Panel",
  phone: "Teléfono",
  walk_in: "Presencial",
  web: "Web",
};
const STATUSES: readonly AppointmentStatus[] = ["pending", "confirmed", "completed", "cancelled", "no_show"];
const RE_DATE = /^\d{4}-\d{2}-\d{2}$/;

const ok = (data: unknown): TransportResponse => ({ status: 200, payload: { ok: true, data } });
const fail = (status: number, code: string, error: string, fields?: Record<string, string>): TransportResponse => ({
  status,
  payload: { ok: false, error, code, ...(fields ? { fields } : {}) },
});

function addDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

function daysBetween(a: string, b: string): number {
  const ms = (d: string) => Date.UTC(Number(d.slice(0, 4)), Number(d.slice(5, 7)) - 1, Number(d.slice(8, 10)));
  return Math.round((ms(b) - ms(a)) / 86_400_000);
}

function datesOf(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

const weekdayOf = (date: string) => new Date(`${date}T12:00:00Z`).getUTCDay();

/** Reparte un monto entre líneas por precio (resto mayor), igual que el backend. */
function prorate(amount: number, prices: number[]): number[] {
  const total = prices.reduce((n, p) => n + p, 0);
  if (prices.length === 0) return [];
  if (total <= 0) return prices.map((_, i) => (i === 0 ? amount : 0));
  const exact = prices.map((p) => (amount * p) / total);
  const out = exact.map(Math.floor);
  let rest = amount - out.reduce((n, x) => n + x, 0);
  const order = exact.map((x, i) => ({ i, f: x - Math.floor(x) })).sort((a, b) => b.f - a.f || a.i - b.i);
  for (let k = 0; rest > 0 && k < order.length; k++, rest--) out[order[k].i] += 1;
  return out;
}

const signed = (p: Payment) => (p.kind === "refund" ? -p.amountCents : p.amountCents);
const rate = (a: number, b: number) => (b > 0 ? a / b : null);

interface Scope {
  view: RangeView;
  locationIds: string[] | null;
}

function scopeOf(session: MockReportsSession, query: URLSearchParams, header: string | undefined, today: string): Scope | TransportResponse {
  const fields: Record<string, string> = {};
  const fromQ = query.get("from");
  const toQ = query.get("to");
  if (fromQ && !RE_DATE.test(fromQ)) fields["query.from"] = "Fecha inválida (formato AAAA-MM-DD).";
  if (toQ && !RE_DATE.test(toQ)) fields["query.to"] = "Fecha inválida (formato AAAA-MM-DD).";
  if (Object.keys(fields).length) return fail(400, "validation_error", "Datos inválidos: revisá los campos marcados.", fields);
  const to = toQ ?? today;
  const from = fromQ ?? addDays(to, -29);
  if (from > to) return fail(400, "validation_error", "Datos inválidos: revisá los campos marcados.", { "query.to": "El fin tiene que ser igual o posterior al inicio." });
  const days = daysBetween(from, to) + 1;
  if (days > 366) return fail(400, "validation_error", "Datos inválidos: revisá los campos marcados.", { "query.to": "El rango puede ser de a lo sumo 366 días." });
  const requested = query.get("locationId") ?? header ?? null;
  if (requested) {
    if (session.locationIds && !session.locationIds.includes(requested)) return fail(403, "location_forbidden", "No tenés acceso a esta sucursal.");
    if (!session.setup.locations.some((l) => l.id === requested)) return fail(400, "validation_error", "Datos inválidos.", { "query.locationId": "Esa sucursal no existe." });
  }
  return {
    view: { from, to, days, timezone: session.timezone, locationId: requested, previous: { from: addDays(from, -days), to: addDays(from, -1) } },
    locationIds: requested ? [requested] : (session.locationIds ?? null),
  };
}

function data(session: MockReportsSession, scope: Scope, from = scope.view.from, to = scope.view.to) {
  const tz = session.timezone;
  const inLoc = (id: string) => !scope.locationIds || scope.locationIds.includes(id);
  const day = (iso: string) => isoToZoned(iso, tz).date;
  return {
    appointments: session.appointments.filter((a) => inLoc(a.locationId) && day(a.startsAt) >= from && day(a.startsAt) <= to),
    payments: session.payments.filter((p) => inLoc(p.locationId) && day(p.paidAt) >= from && day(p.paidAt) <= to),
    day,
  };
}

function groupPayments(list: Payment[], keyOf: (p: Payment) => { key: string | null; label: string }): CollectedGroup[] {
  const groups = new Map<string, CollectedGroup>();
  for (const p of list) {
    const { key, label } = keyOf(p);
    const id = key ?? `\u0000${label}`;
    const g = groups.get(id) ?? { key, label, collectedCents: 0, refundsCents: 0, netCents: 0, count: 0 };
    if (p.kind === "refund") g.refundsCents += p.amountCents;
    else g.collectedCents += p.amountCents;
    g.netCents = g.collectedCents - g.refundsCents;
    g.count += 1;
    groups.set(id, g);
  }
  return [...groups.values()].sort((a, b) => b.netCents - a.netCents || a.label.localeCompare(b.label, "es"));
}

function base(session: MockReportsSession, scope: Scope) {
  return { range: scope.view, currency: session.currency, generatedAt: new Date().toISOString() };
}

function salesReport(session: MockReportsSession, scope: Scope): SalesReport {
  const { payments, day } = data(session, scope);
  const previous = data(session, scope, scope.view.previous.from, scope.view.previous.to).payments;
  const sum = (kind: Payment["kind"]) => payments.filter((p) => p.kind === kind).reduce((n, p) => n + p.amountCents, 0);
  const deposits = sum("deposit");
  const charges = sum("payment");
  const refunds = sum("refund");
  const tickets = new Set(payments.filter((p) => p.kind !== "refund").map((p) => p.appointmentId ?? p.id)).size;
  const net = deposits + charges - refunds;
  const byDay = new Map(groupPayments(payments, (p) => ({ key: day(p.paidAt), label: day(p.paidAt) })).map((g) => [g.key, g]));
  return {
    ...base(session, scope),
    totals: {
      depositsCents: deposits,
      paymentsCents: charges,
      collectedCents: deposits + charges,
      refundsCents: refunds,
      netCents: net,
      count: payments.length,
      tickets,
      averageTicketCents: tickets > 0 ? Math.round(net / tickets) : null,
    },
    previous: { netCents: previous.reduce((n, p) => n + signed(p), 0) },
    byDay: datesOf(scope.view.from, scope.view.to).map((date) => {
      const g = byDay.get(date);
      return { date, collectedCents: g?.collectedCents ?? 0, refundsCents: g?.refundsCents ?? 0, netCents: g?.netCents ?? 0, count: g?.count ?? 0 };
    }),
    byMethod: groupPayments(payments, (p) => ({ key: p.method?.id ?? null, label: p.method?.name ?? "Método eliminado" })),
    byLocation: groupPayments(payments, (p) => ({ key: p.locationId, label: p.location?.name ?? "Sucursal" })),
  };
}

/** Lo cobrado de cada pago repartido por servicio de su cita. */
function collectedByService(session: MockReportsSession, payments: Payment[]): { byService: Map<string, number>; loose: number } {
  const byService = new Map<string, number>();
  let loose = 0;
  for (const p of payments) {
    const a = p.appointmentId ? session.appointments.find((x) => x.id === p.appointmentId) : undefined;
    if (!a) {
      loose += signed(p);
      continue;
    }
    const shares = prorate(p.amountCents, a.services.map((l) => l.priceCents));
    a.services.forEach((l, i) => {
      const key = l.serviceId ?? `name:${l.name}`;
      byService.set(key, (byService.get(key) ?? 0) + (p.kind === "refund" ? -shares[i] : shares[i]));
    });
  }
  return { byService, loose };
}

function servicesReport(session: MockReportsSession, scope: Scope): ServicesReport {
  const { appointments, payments } = data(session, scope);
  const items = new Map<string, ServicesReport["items"][number]>();
  for (const a of appointments) {
    for (const l of a.services) {
      const key = l.serviceId ?? `name:${l.name}`;
      const item = items.get(key) ?? { serviceId: l.serviceId, name: session.setup.services.find((s) => s.id === l.serviceId)?.name ?? l.name, scheduled: 0, completed: 0, completedValueCents: 0, collectedNetCents: 0 };
      if (a.status !== "cancelled") item.scheduled += 1;
      if (a.status === "completed") {
        item.completed += 1;
        item.completedValueCents += l.priceCents;
      }
      items.set(key, item);
    }
  }
  const { byService, loose } = collectedByService(session, payments);
  for (const [key, cents] of byService) {
    const item = items.get(key);
    if (item) item.collectedNetCents += cents;
  }
  const list = [...items.values()].sort((a, b) => b.completed - a.completed || b.collectedNetCents - a.collectedNetCents || a.name.localeCompare(b.name, "es"));
  return {
    ...base(session, scope),
    items: list,
    totals: list.reduce(
      (t, i) => ({ scheduled: t.scheduled + i.scheduled, completed: t.completed + i.completed, completedValueCents: t.completedValueCents + i.completedValueCents, collectedNetCents: t.collectedNetCents + i.collectedNetCents }),
      { scheduled: 0, completed: 0, completedValueCents: 0, collectedNetCents: 0 },
    ),
    looseCollectedNetCents: loose,
  };
}

function staffReport(session: MockReportsSession, scope: Scope): StaffReport {
  const { appointments, payments, day } = data(session, scope);
  const locations = session.setup.locations.filter((l) => l.active && (!scope.locationIds || scope.locationIds.includes(l.id)));
  const items = session.setup.staff.map((s) => {
    const mine = appointments.filter((a) => a.staffId === s.id);
    const count = (status: AppointmentStatus) => mine.filter((a) => a.status === status).length;
    const booked = mine.filter((a) => a.status !== "cancelled").reduce((n, a) => n + (Date.parse(a.endsAt) - Date.parse(a.startsAt)) / 60_000, 0);
    let available = 0;
    for (const date of datesOf(scope.view.from, scope.view.to)) {
      for (const l of locations) {
        const windows = workingWindows(l.hours, s.hours.filter((h) => h.locationId === l.id), weekdayOf(date));
        available += windows.reduce((n, w) => n + (w.endMin - w.startMin), 0);
      }
    }
    const collected = payments
      .filter((p) => p.appointmentId && session.appointments.find((a) => a.id === p.appointmentId)?.staffId === s.id)
      .reduce((n, p) => n + signed(p), 0);
    const commission = session.commissions
      .filter((e) => e.staffId === s.id && (!scope.locationIds || scope.locationIds.includes(e.locationId)) && day(e.earnedAt) >= scope.view.from && day(e.earnedAt) <= scope.view.to)
      .reduce((n, e) => n + e.amountCents, 0);
    const completed = count("completed");
    const noShow = count("no_show");
    return {
      staffId: s.id,
      name: s.name,
      color: s.color,
      active: s.active,
      appointments: mine.length,
      completed,
      noShow,
      cancelled: count("cancelled"),
      noShowRate: rate(noShow, completed + noShow),
      collectedNetCents: collected,
      bookedMinutes: Math.round(booked),
      availableMinutes: available,
      occupancyRate: rate(Math.round(booked), available),
      commissionCents: commission,
    };
  });
  const shown = items.filter((i) => i.active || i.appointments > 0);
  const sum = shown.reduce(
    (t, i) => ({
      appointments: t.appointments + i.appointments,
      completed: t.completed + i.completed,
      noShow: t.noShow + i.noShow,
      cancelled: t.cancelled + i.cancelled,
      collectedNetCents: t.collectedNetCents + i.collectedNetCents,
      bookedMinutes: t.bookedMinutes + i.bookedMinutes,
      availableMinutes: t.availableMinutes + i.availableMinutes,
      commissionCents: t.commissionCents + i.commissionCents,
    }),
    { appointments: 0, completed: 0, noShow: 0, cancelled: 0, collectedNetCents: 0, bookedMinutes: 0, availableMinutes: 0, commissionCents: 0 },
  );
  return {
    ...base(session, scope),
    items: shown.sort((a, b) => b.collectedNetCents - a.collectedNetCents || b.appointments - a.appointments || a.name.localeCompare(b.name, "es")),
    totals: { ...sum, noShowRate: rate(sum.noShow, sum.completed + sum.noShow), occupancyRate: rate(sum.bookedMinutes, sum.availableMinutes) },
  };
}

function clientsReport(session: MockReportsSession, scope: Scope): ClientsReport {
  const tz = session.timezone;
  const day = (iso: string) => isoToZoned(iso, tz).date;
  const completedAll = session.appointments.filter((a) => a.status === "completed");
  const firstVisit = new Map<string, string>();
  for (const a of completedAll) {
    const d = day(a.startsAt);
    const prev = firstVisit.get(a.clientId);
    if (!prev || d < prev) firstVisit.set(a.clientId, d);
  }
  const visits = data(session, scope).appointments.filter((a) => a.status === "completed");
  const prevVisits = data(session, scope, scope.view.previous.from, scope.view.previous.to).appointments.filter((a) => a.status === "completed");
  const served = new Set(visits.map((a) => a.clientId));
  const newClients = [...served].filter((c) => (firstVisit.get(c) ?? "") >= scope.view.from).length;
  const prevServed = new Set(prevVisits.map((a) => a.clientId));
  const retained = [...prevServed].filter((c) => served.has(c)).length;
  const byDay = datesOf(scope.view.from, scope.view.to).map((date) => {
    const today = new Set(visits.filter((a) => day(a.startsAt) === date).map((a) => a.clientId));
    const fresh = [...today].filter((c) => firstVisit.get(c) === date).length;
    return { date, newClients: fresh, returningClients: today.size - fresh };
  });
  return {
    ...base(session, scope),
    served: served.size,
    visits: visits.length,
    newClients,
    returningClients: served.size - newClients,
    registered: newClients,
    retention: { previousServed: prevServed.size, retained, rate: rate(retained, prevServed.size) },
    byDay,
    byStatus: session.clientStatus.counts,
  };
}

function channelsReport(session: MockReportsSession, scope: Scope): ChannelsReport {
  const { appointments, payments } = data(session, scope);
  let loose = 0;
  const collected = new Map<string, number>();
  for (const p of payments) {
    const a = p.appointmentId ? session.appointments.find((x) => x.id === p.appointmentId) : undefined;
    if (!a) loose += signed(p);
    else collected.set(a.channel, (collected.get(a.channel) ?? 0) + signed(p));
  }
  const items = CHANNELS.map((channel) => {
    const mine = appointments.filter((a) => a.channel === channel);
    const count = (s: AppointmentStatus) => mine.filter((a) => a.status === s).length;
    return {
      channel,
      label: CHANNEL_LABELS[channel],
      appointments: mine.length,
      completed: count("completed"),
      cancelled: count("cancelled"),
      noShow: count("no_show"),
      completedValueCents: mine.filter((a) => a.status === "completed").reduce((n, a) => n + a.totalCents, 0),
      collectedNetCents: collected.get(channel) ?? 0,
    };
  });
  return {
    ...base(session, scope),
    items,
    totals: items.reduce(
      (t, i) => ({
        appointments: t.appointments + i.appointments,
        completed: t.completed + i.completed,
        cancelled: t.cancelled + i.cancelled,
        noShow: t.noShow + i.noShow,
        completedValueCents: t.completedValueCents + i.completedValueCents,
        collectedNetCents: t.collectedNetCents + i.collectedNetCents,
      }),
      { appointments: 0, completed: 0, cancelled: 0, noShow: 0, completedValueCents: 0, collectedNetCents: 0 },
    ),
    looseCollectedNetCents: loose,
  };
}

// ── CSV (mismas columnas y escape que src/modules/reports/csv.ts) ───────────

function cell(value: string | number): string {
  if (typeof value === "number") return String(value);
  let text = value;
  if (/^[=+\-@\t\r]/.test(text) && !/^-?\d+(\.\d+)?$/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

const money = (cents: number) => (cents / 100).toFixed(2);
const pct = (v: number | null) => (v === null ? "" : (Math.round(v * 1000) / 10).toFixed(1));

function toCsv(header: string[], rows: (string | number)[][]): string {
  return `﻿${[header, ...rows].map((r) => r.map(cell).join(",")).join("\r\n")}\r\n`;
}

const CSV_NAMES: Record<ReportId, string> = { sales: "ventas", services: "servicios", staff: "profesionales", clients: "clientes", channels: "canales" };

function csvOf(id: ReportId, report: unknown, currency: string): string {
  const c = currency;
  switch (id) {
    case "sales":
      return toCsv(["Fecha", `Cobrado (${c})`, `Devoluciones (${c})`, `Neto (${c})`, "Movimientos"], (report as SalesReport).byDay.map((d) => [d.date, money(d.collectedCents), money(d.refundsCents), money(d.netCents), d.count]));
    case "services":
      return toCsv(["Servicio", "Agendados", "Realizados", `Valor realizado (${c})`, `Cobrado neto (${c})`], (report as ServicesReport).items.map((i) => [i.name, i.scheduled, i.completed, money(i.completedValueCents), money(i.collectedNetCents)]));
    case "staff":
      return toCsv(
        ["Profesional", "Citas", "Completadas", "No asistió", "Canceladas", "% no-show", `Cobrado neto (${c})`, "Minutos agendados", "Minutos disponibles", "% ocupación", `Comisiones (${c})`],
        (report as StaffReport).items.map((i) => [i.name, i.appointments, i.completed, i.noShow, i.cancelled, pct(i.noShowRate), money(i.collectedNetCents), i.bookedMinutes, i.availableMinutes, pct(i.occupancyRate), money(i.commissionCents)]),
      );
    case "clients":
      return toCsv(["Fecha", "Clientes nuevos", "Clientes recurrentes"], (report as ClientsReport).byDay.map((d) => [d.date, d.newClients, d.returningClients]));
    case "channels":
      return toCsv(
        ["Canal", "Citas", "Completadas", "Canceladas", "No asistió", `Valor completadas (${c})`, `Cobrado neto (${c})`],
        (report as ChannelsReport).items.map((i) => [i.label, i.appointments, i.completed, i.cancelled, i.noShow, money(i.completedValueCents), money(i.collectedNetCents)]),
      );
  }
}

// ── Inicio completo ─────────────────────────────────────────────────────────

function homeOverview(session: MockReportsSession, header: string | undefined): HomeOverview {
  const tz = session.timezone;
  const now = new Date();
  const day = (iso: string) => isoToZoned(iso, tz).date;
  const today = day(now.toISOString());
  const tomorrow = addDays(today, 1);
  const locationIds = header ? [header] : (session.locationIds ?? null);
  const inLoc = (id: string) => !locationIds || locationIds.includes(id);
  const appts = session.appointments.filter((a) => inLoc(a.locationId));
  const pays = session.payments.filter((p) => inLoc(p.locationId));
  const todays = appts.filter((a) => day(a.startsAt) === today);
  const byStatus = Object.fromEntries(STATUSES.map((s) => [s, todays.filter((a) => a.status === s).length])) as Record<AppointmentStatus, number>;
  const paidToday = pays.filter((p) => day(p.paidAt) === today);
  const pending = appts.filter((a) => a.status === "pending" && Date.parse(a.startsAt) >= now.getTime() && day(a.startsAt) <= tomorrow).sort((a, b) => a.startsAt.localeCompare(b.startsAt));
  const firstDay = addDays(today, -13);
  const firstVisit = new Map<string, string>();
  for (const a of session.appointments) if (a.status === "completed" && (!firstVisit.has(a.clientId) || day(a.startsAt) < (firstVisit.get(a.clientId) as string))) firstVisit.set(a.clientId, day(a.startsAt));
  return {
    date: today,
    timezone: tz,
    locationId: header ?? null,
    currency: session.currency,
    generatedAt: now.toISOString(),
    collectedToday: {
      collectedCents: paidToday.filter((p) => p.kind !== "refund").reduce((n, p) => n + p.amountCents, 0),
      refundsCents: paidToday.filter((p) => p.kind === "refund").reduce((n, p) => n + p.amountCents, 0),
      netCents: paidToday.reduce((n, p) => n + signed(p), 0),
      count: paidToday.length,
    },
    newClientsToday: [...firstVisit.values()].filter((d) => d === today).length,
    appointmentsToday: { total: todays.length, byStatus },
    noShowsToday: byStatus.no_show,
    alerts: {
      unconfirmed: { today: pending.filter((a) => day(a.startsAt) === today).length, tomorrow: pending.filter((a) => day(a.startsAt) === tomorrow).length, items: pending.slice(0, 10) },
      atRisk: session.clientStatus.atRisk,
    },
    revenue: datesOf(firstDay, today).map((date) => ({ date, netCents: pays.filter((p) => day(p.paidAt) === date).reduce((n, p) => n + signed(p), 0) })),
    conversationsWaiting: session.modules.includes("whatsapp") ? 2 : null,
  };
}

// ── Rutas ───────────────────────────────────────────────────────────────────

export function isReportsMockPath(path: string): boolean {
  return path.startsWith("/reports/") || path === "/home/overview";
}

const BUILDERS: Record<ReportId, (session: MockReportsSession, scope: Scope) => unknown> = {
  sales: salesReport,
  services: servicesReport,
  staff: staffReport,
  clients: clientsReport,
  channels: channelsReport,
};

/** Rutas de Reportes y del Inicio completo del mock; null si la ruta no es suya. */
export function routeReportsMock(req: TransportRequest, session: MockReportsSession, header: string | undefined): TransportResponse | null {
  const url = new URL(req.path, "http://mock");
  const path = url.pathname;
  if (!isReportsMockPath(path)) return null;
  if (req.method !== "GET") return fail(405, "method_not_allowed", "Método no permitido.");

  if (path === "/home/overview") {
    if (!["owner", "admin", "front_desk"].includes(session.role)) return fail(403, "forbidden_role", "No tenés permiso para esta acción.");
    if (!session.modules.includes("reports")) return fail(403, "module_not_in_plan", "Esta función no está incluida en el plan del negocio.");
    if (header && session.locationIds && !session.locationIds.includes(header)) return fail(403, "location_forbidden", "No tenés acceso a esta sucursal.");
    return ok(homeOverview(session, header));
  }

  const match = /^\/reports\/([a-z]+)(\.csv)?$/.exec(path);
  const id = match?.[1] as ReportId | undefined;
  if (!id || !REPORT_IDS.includes(id)) return fail(404, "not_found", "Recurso no encontrado.");
  if (!["owner", "admin"].includes(session.role)) return fail(403, "forbidden_role", "No tenés permiso para esta acción.");
  if (!session.modules.includes("reports")) return fail(403, "module_not_in_plan", "Esta función no está incluida en el plan del negocio.");
  const today = isoToZoned(new Date().toISOString(), session.timezone).date;
  const scope = scopeOf(session, url.searchParams, header, today);
  if ("status" in scope) return scope;
  const report = BUILDERS[id](session, scope);
  if (match?.[2]) {
    return ok({ content: csvOf(id, report, session.currency), filename: `reporte-${CSV_NAMES[id]}_${scope.view.from}_${scope.view.to}.csv`, contentType: "text/csv;charset=utf-8" });
  }
  return ok(report);
}
