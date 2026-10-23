import type { Executor } from "../../platform/db/scope";
import { getServices } from "../catalog";
import { countClientsByStatus, countRegisteredClients, type ClientStatusCounts } from "../clients";
import { getCommissionSummary } from "../commissions";
import { getCollectedTotals, type CollectedGroup } from "../sales";
import {
  APPOINTMENT_CHANNELS,
  CHANNEL_LABELS,
  getAppointmentBreakdown,
  getBookedMinutesByStaff,
  getClientVisitStats,
  getServiceLineStats,
  type AppointmentChannel,
} from "../scheduling";
import { getStaffAvailableMinutes, listStaff } from "../team";
import { datesOf, type RangeView, type ReportScope } from "./range";

// ─────────────────────────────────────────────────────────────────────────────
// Los cinco reportes del Pro (PLAN-GESTION.md §6: Ventas · Servicios · Profesionales ·
// Clientes · Canales). Este módulo NO tiene tablas ni lee las de nadie: arma cada reporte
// con los agregados SQL que expone el módulo dueño de cada dato (scheduling, sales,
// commissions, clients, team) por su index.ts. Nadie depende de reports.
//
// Montos en céntimos de la moneda del negocio. Cobrado = lo REGISTRADO como pagado
// (señas + cobros − devoluciones), no lo facturado; "valor" = precios copiados en las
// citas completadas.
// ─────────────────────────────────────────────────────────────────────────────

export type ReportId = "sales" | "services" | "staff" | "clients" | "channels";
export const REPORT_IDS: readonly ReportId[] = ["sales", "services", "staff", "clients", "channels"];

interface ReportBase {
  range: RangeView;
  currency: string;
  generatedAt: string;
}

const base = (scope: ReportScope, now: Date): ReportBase => ({
  range: scope.view,
  currency: scope.ctx.business.currency,
  generatedAt: now.toISOString(),
});

/** a / b, o null si b es 0. */
const rate = (a: number, b: number): number | null => (b > 0 ? a / b : null);

// ── Ventas ──────────────────────────────────────────────────────────────────

export interface SalesReport extends ReportBase {
  totals: {
    depositsCents: number;
    paymentsCents: number;
    collectedCents: number;
    refundsCents: number;
    netCents: number;
    /** Movimientos (señas, cobros y devoluciones). */
    count: number;
    /** Citas cobradas + cobros sueltos. */
    tickets: number;
    /** Neto ÷ tickets (null sin tickets). */
    averageTicketCents: number | null;
  };
  /** Neto del período anterior (mismo largo), para comparar. */
  previous: { netCents: number };
  /** Todos los días del rango (los que no tuvieron movimientos, en cero). */
  byDay: { date: string; collectedCents: number; refundsCents: number; netCents: number; count: number }[];
  byMethod: CollectedGroup[];
  byLocation: CollectedGroup[];
}

export async function buildSalesReport(db: Executor, businessId: string, scope: ReportScope, now = new Date()): Promise<SalesReport> {
  const window = { from: scope.start, to: scope.end, locationIds: scope.locationIds, timeZone: scope.view.timezone };
  const byDay = await getCollectedTotals(db, businessId, { ...window, groupBy: "day" });
  const byMethod = await getCollectedTotals(db, businessId, { ...window, groupBy: "method" });
  const byLocation = await getCollectedTotals(db, businessId, { ...window, groupBy: "location" });
  const previous = await getCollectedTotals(db, businessId, { ...window, from: scope.previousStart, to: scope.start });
  const days = new Map(byDay.groups.map((g) => [g.key, g]));
  return {
    ...base(scope, now),
    totals: {
      depositsCents: byDay.depositsCents,
      paymentsCents: byDay.paymentsCents,
      collectedCents: byDay.collectedCents,
      refundsCents: byDay.refundsCents,
      netCents: byDay.netCents,
      count: byDay.count,
      tickets: byDay.tickets,
      averageTicketCents: byDay.tickets > 0 ? Math.round(byDay.netCents / byDay.tickets) : null,
    },
    previous: { netCents: previous.netCents },
    byDay: datesOf(scope.view.from, scope.view.to).map((date) => {
      const g = days.get(date);
      return { date, collectedCents: g?.collectedCents ?? 0, refundsCents: g?.refundsCents ?? 0, netCents: g?.netCents ?? 0, count: g?.count ?? 0 };
    }),
    byMethod: byMethod.groups,
    byLocation: byLocation.groups,
  };
}

// ── Servicios ───────────────────────────────────────────────────────────────

export interface ServiceReportItem {
  /** null = el servicio ya no existe en el catálogo. */
  serviceId: string | null;
  name: string;
  /** Agendados (líneas en citas no canceladas). */
  scheduled: number;
  /** Realizados (líneas en citas completadas): lo "vendido" por cantidad. */
  completed: number;
  /** Valor de lo realizado (precios copiados). */
  completedValueCents: number;
  /** Cobrado neto que le corresponde (prorrateo por precio entre las líneas de cada cita). */
  collectedNetCents: number;
}

export interface ServicesReport extends ReportBase {
  /** Más vendidos primero (por cantidad realizada; desempate: cobrado). */
  items: ServiceReportItem[];
  totals: { scheduled: number; completed: number; completedValueCents: number; collectedNetCents: number };
  /** Cobrado neto sin cita (cobros sueltos): no se atribuye a ningún servicio. */
  looseCollectedNetCents: number;
}

export async function buildServicesReport(db: Executor, businessId: string, scope: ReportScope, now = new Date()): Promise<ServicesReport> {
  const window = { from: scope.start, to: scope.end, locationIds: scope.locationIds };
  const lines = await getServiceLineStats(db, businessId, window);
  const collected = await getCollectedTotals(db, businessId, { ...window, groupBy: "service" });
  const catalog = new Map((await getServices(db, businessId)).map((s) => [s.id, s.name]));
  const keyOf = (serviceId: string | null, name: string) => serviceId ?? `name:${name}`;
  const items = new Map<string, ServiceReportItem>();
  for (const l of lines) {
    items.set(keyOf(l.serviceId, l.name), {
      serviceId: l.serviceId,
      name: (l.serviceId && catalog.get(l.serviceId)) || l.name,
      scheduled: l.scheduled,
      completed: l.completed,
      completedValueCents: l.completedValueCents,
      collectedNetCents: 0,
    });
  }
  let loose = 0;
  for (const g of collected.groups) {
    // Grupo null con la etiqueta "Sin cita" = cobros sueltos; null con otro nombre = servicio borrado.
    if (g.key === null && g.label === "Sin cita") {
      loose += g.netCents;
      continue;
    }
    const k = keyOf(g.key, g.label);
    const item = items.get(k) ?? {
      serviceId: g.key,
      name: (g.key && catalog.get(g.key)) || g.label,
      scheduled: 0,
      completed: 0,
      completedValueCents: 0,
      collectedNetCents: 0,
    };
    item.collectedNetCents += g.netCents;
    items.set(k, item);
  }
  const list = [...items.values()].sort(
    (a, b) => b.completed - a.completed || b.collectedNetCents - a.collectedNetCents || a.name.localeCompare(b.name, "es"),
  );
  return {
    ...base(scope, now),
    items: list,
    totals: list.reduce(
      (t, i) => ({
        scheduled: t.scheduled + i.scheduled,
        completed: t.completed + i.completed,
        completedValueCents: t.completedValueCents + i.completedValueCents,
        collectedNetCents: t.collectedNetCents + i.collectedNetCents,
      }),
      { scheduled: 0, completed: 0, completedValueCents: 0, collectedNetCents: 0 },
    ),
    looseCollectedNetCents: loose,
  };
}

// ── Profesionales ───────────────────────────────────────────────────────────

export interface StaffReportItem {
  staffId: string;
  name: string;
  color: string | null;
  active: boolean;
  /** Citas que empiezan en el rango (todos los estados). */
  appointments: number;
  completed: number;
  noShow: number;
  cancelled: number;
  /** No-show ÷ (completadas + no-show): de las que tenían que ocurrir, cuántas faltaron. */
  noShowRate: number | null;
  collectedNetCents: number;
  /** Lo que ocupan sus citas no canceladas (con buffer y no-show), recortado al rango. */
  bookedMinutes: number;
  /** Horario ∩ horario de la sucursal − ausencias y cierres. */
  availableMinutes: number;
  /** Agendado ÷ disponible (puede pasar de 1 con citas fuera de horario); null sin horario. */
  occupancyRate: number | null;
  /** Comisión ganada en el rango (movimientos por fecha en que se ganaron). */
  commissionCents: number;
}

export interface StaffReport extends ReportBase {
  items: StaffReportItem[];
  totals: Omit<StaffReportItem, "staffId" | "name" | "color" | "active">;
}

export async function buildStaffReport(db: Executor, businessId: string, scope: ReportScope, now = new Date()): Promise<StaffReport> {
  const window = { from: scope.start, to: scope.end, locationIds: scope.locationIds };
  const appointments = await getAppointmentBreakdown(db, businessId, { ...window, groupBy: "staff" });
  const collected = await getCollectedTotals(db, businessId, { ...window, groupBy: "staff" });
  const booked = await getBookedMinutesByStaff(db, businessId, window);
  const locations = scope.ctx.locations
    .filter((l) => l.active && (!scope.locationIds || scope.locationIds.includes(l.id)))
    .map((l) => ({ id: l.id, timezone: l.timezone, hours: l.hours.map((h) => ({ weekday: h.weekday, opensAt: h.opensAt, closesAt: h.closesAt })) }));
  const available = await getStaffAvailableMinutes(db, businessId, { from: scope.start, to: scope.end, locations });
  const commissions = await getCommissionSummary(db, businessId, { from: scope.start, to: scope.end, locationIds: scope.locationIds });
  const staff = await listStaff(db, businessId);

  const byStaff = new Map(appointments.groups.map((g) => [g.key, g]));
  const collectedBy = new Map(collected.groups.filter((g) => g.key).map((g) => [g.key as string, g.netCents]));
  const commissionBy = new Map(commissions.rows.map((r) => [r.staffId, r.amountCents]));
  const items: StaffReportItem[] = [];
  for (const s of staff) {
    const a = byStaff.get(s.id);
    const item: StaffReportItem = {
      staffId: s.id,
      name: s.name,
      color: s.color,
      active: s.active,
      appointments: a?.total ?? 0,
      completed: a?.byStatus.completed ?? 0,
      noShow: a?.byStatus.no_show ?? 0,
      cancelled: a?.byStatus.cancelled ?? 0,
      noShowRate: rate(a?.byStatus.no_show ?? 0, (a?.byStatus.completed ?? 0) + (a?.byStatus.no_show ?? 0)),
      collectedNetCents: collectedBy.get(s.id) ?? 0,
      bookedMinutes: booked.get(s.id) ?? 0,
      availableMinutes: available.get(s.id) ?? 0,
      occupancyRate: rate(booked.get(s.id) ?? 0, available.get(s.id) ?? 0),
      commissionCents: commissionBy.get(s.id) ?? 0,
    };
    const hasData = item.appointments > 0 || item.collectedNetCents !== 0 || item.availableMinutes > 0 || item.commissionCents !== 0;
    if (s.active || hasData) items.push(item);
  }
  const sum = items.reduce(
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
    ...base(scope, now),
    items: items.sort((x, y) => y.collectedNetCents - x.collectedNetCents || y.appointments - x.appointments || x.name.localeCompare(y.name, "es")),
    totals: {
      ...sum,
      noShowRate: rate(sum.noShow, sum.completed + sum.noShow),
      occupancyRate: rate(sum.bookedMinutes, sum.availableMinutes),
    },
  };
}

// ── Clientes ────────────────────────────────────────────────────────────────

export interface ClientsReport extends ReportBase {
  /** Clientes distintos atendidos (con al menos una cita completada). */
  served: number;
  /** Visitas (citas completadas). */
  visits: number;
  /** Primera visita del negocio en el rango. */
  newClients: number;
  /** Atendidos que ya habían venido antes. */
  returningClients: number;
  /** Altas en la base (vengan o no a una cita). Del negocio entero: el cliente no es de una sucursal. */
  registered: number;
  /** Retención simple: de los atendidos en el período anterior, cuántos volvieron en este. */
  retention: { previousServed: number; retained: number; rate: number | null };
  /** Todos los días del rango. */
  byDay: { date: string; newClients: number; returningClients: number }[];
  /**
   * Estado de la cartera HOY (CRM: nuevo, activo, VIP, en riesgo, inactivo con las reglas del
   * negocio): los mismos números que los chips de la lista de clientes. Es una foto del
   * momento: no depende del rango ni de la sucursal (el cliente no es de una sucursal).
   */
  byStatus: ClientStatusCounts;
}

export async function buildClientsReport(db: Executor, businessId: string, scope: ReportScope, now = new Date()): Promise<ClientsReport> {
  const stats = await getClientVisitStats(db, businessId, {
    from: scope.start,
    to: scope.end,
    previousFrom: scope.previousStart,
    locationIds: scope.locationIds,
    timeZone: scope.view.timezone,
  });
  const registered = await countRegisteredClients(db, businessId, { from: scope.start, to: scope.end });
  const byStatus = await countClientsByStatus(db, businessId, {}, { now });
  const days = new Map(stats.byDay.map((d) => [d.date, d]));
  return {
    ...base(scope, now),
    served: stats.served,
    visits: stats.visits,
    newClients: stats.newClients,
    returningClients: stats.returning,
    registered,
    retention: { previousServed: stats.previous.served, retained: stats.previous.retained, rate: stats.retentionRate },
    byDay: datesOf(scope.view.from, scope.view.to).map((date) => ({
      date,
      newClients: days.get(date)?.newClients ?? 0,
      returningClients: days.get(date)?.returningClients ?? 0,
    })),
    byStatus,
  };
}

// ── Canales ─────────────────────────────────────────────────────────────────

export interface ChannelReportItem {
  channel: AppointmentChannel;
  label: string;
  /** Citas que empiezan en el rango (todos los estados). */
  appointments: number;
  completed: number;
  cancelled: number;
  noShow: number;
  completedValueCents: number;
  collectedNetCents: number;
}

export interface ChannelsReport extends ReportBase {
  /** Los cinco canales, siempre (los que no tuvieron nada, en cero). */
  items: ChannelReportItem[];
  totals: Omit<ChannelReportItem, "channel" | "label">;
  /** Cobrado neto sin cita (no tiene canal). */
  looseCollectedNetCents: number;
}

export async function buildChannelsReport(db: Executor, businessId: string, scope: ReportScope, now = new Date()): Promise<ChannelsReport> {
  const window = { from: scope.start, to: scope.end, locationIds: scope.locationIds };
  const appointments = await getAppointmentBreakdown(db, businessId, { ...window, groupBy: "channel" });
  const collected = await getCollectedTotals(db, businessId, { ...window, groupBy: "channel" });
  const byChannel = new Map(appointments.groups.map((g) => [g.key, g]));
  const collectedBy = new Map(collected.groups.map((g) => [g.key, g.netCents]));
  const items = APPOINTMENT_CHANNELS.map((channel): ChannelReportItem => {
    const g = byChannel.get(channel);
    return {
      channel,
      label: CHANNEL_LABELS[channel],
      appointments: g?.total ?? 0,
      completed: g?.byStatus.completed ?? 0,
      cancelled: g?.byStatus.cancelled ?? 0,
      noShow: g?.byStatus.no_show ?? 0,
      completedValueCents: g?.completedValueCents ?? 0,
      collectedNetCents: collectedBy.get(channel) ?? 0,
    };
  });
  return {
    ...base(scope, now),
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
    looseCollectedNetCents: collectedBy.get(null) ?? 0,
  };
}

export type AnyReport = SalesReport | ServicesReport | StaffReport | ClientsReport | ChannelsReport;

export const REPORT_BUILDERS: Record<ReportId, (db: Executor, businessId: string, scope: ReportScope, now?: Date) => Promise<AnyReport>> = {
  sales: buildSalesReport,
  services: buildServicesReport,
  staff: buildStaffReport,
  clients: buildClientsReport,
  channels: buildChannelsReport,
};
