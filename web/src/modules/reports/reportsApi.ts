import { useQuery } from "@tanstack/react-query";
import { api, apiDownload, getActiveLocationId } from "../../lib/api";
import type { Appointment, AppointmentStatus } from "../scheduling/schedulingApi";

// ─────────────────────────────────────────────────────────────────────────────
// Contrato de Reportes e Inicio completo (I5) y sus llamadas. Escrito a mano, espejo de:
//   src/modules/reports/{reports,home,range,routes}.ts   /reports/*, /reports/<id>.csv, /home/overview
// Si el backend cambia la forma, cambia acá y en ./reportsMock.ts. Montos en céntimos;
// fechas en días locales (AAAA-MM-DD, inclusive) en la zona del negocio.
// ─────────────────────────────────────────────────────────────────────────────

export type ReportId = "sales" | "services" | "staff" | "clients" | "channels";
export type AppointmentChannel = "whatsapp_ai" | "panel" | "phone" | "walk_in" | "web";

export interface RangeView {
  from: string;
  to: string;
  days: number;
  timezone: string;
  locationId: string | null;
  previous: { from: string; to: string };
}

interface ReportBase {
  range: RangeView;
  currency: string;
  generatedAt: string;
}

export interface CollectedGroup {
  key: string | null;
  label: string;
  collectedCents: number;
  refundsCents: number;
  netCents: number;
  count: number;
}

export interface SalesReport extends ReportBase {
  totals: {
    depositsCents: number;
    paymentsCents: number;
    collectedCents: number;
    refundsCents: number;
    netCents: number;
    count: number;
    tickets: number;
    averageTicketCents: number | null;
  };
  previous: { netCents: number };
  byDay: { date: string; collectedCents: number; refundsCents: number; netCents: number; count: number }[];
  byMethod: CollectedGroup[];
  byLocation: CollectedGroup[];
}

export interface ServiceReportItem {
  serviceId: string | null;
  name: string;
  scheduled: number;
  completed: number;
  completedValueCents: number;
  collectedNetCents: number;
}

export interface ServicesReport extends ReportBase {
  items: ServiceReportItem[];
  totals: { scheduled: number; completed: number; completedValueCents: number; collectedNetCents: number };
  looseCollectedNetCents: number;
}

export interface StaffReportItem {
  staffId: string;
  name: string;
  color: string | null;
  active: boolean;
  appointments: number;
  completed: number;
  noShow: number;
  cancelled: number;
  noShowRate: number | null;
  collectedNetCents: number;
  bookedMinutes: number;
  availableMinutes: number;
  occupancyRate: number | null;
  commissionCents: number;
}

export interface StaffReport extends ReportBase {
  items: StaffReportItem[];
  totals: Omit<StaffReportItem, "staffId" | "name" | "color" | "active">;
}

export interface ClientsReport extends ReportBase {
  served: number;
  visits: number;
  newClients: number;
  returningClients: number;
  registered: number;
  retention: { previousServed: number; retained: number; rate: number | null };
  byDay: { date: string; newClients: number; returningClients: number }[];
}

export interface ChannelReportItem {
  channel: AppointmentChannel;
  label: string;
  appointments: number;
  completed: number;
  cancelled: number;
  noShow: number;
  completedValueCents: number;
  collectedNetCents: number;
}

export interface ChannelsReport extends ReportBase {
  items: ChannelReportItem[];
  totals: Omit<ChannelReportItem, "channel" | "label">;
  looseCollectedNetCents: number;
}

export interface ReportById {
  sales: SalesReport;
  services: ServicesReport;
  staff: StaffReport;
  clients: ClientsReport;
  channels: ChannelsReport;
}

export interface AtRiskClient {
  id: string;
  name: string;
  lastVisitAt: string;
  visitCount: number;
}

export interface HomeOverview {
  date: string;
  timezone: string;
  locationId: string | null;
  currency: string;
  generatedAt: string;
  collectedToday: { collectedCents: number; refundsCents: number; netCents: number; count: number };
  newClientsToday: number;
  appointmentsToday: { total: number; byStatus: Record<AppointmentStatus, number> };
  noShowsToday: number;
  alerts: {
    unconfirmed: { today: number; tomorrow: number; items: Appointment[] };
    atRisk: { count: number; items: AtRiskClient[]; provisional: true };
  };
  revenue: { date: string; netCents: number }[];
  conversationsWaiting: number | null;
}

/** Rango pedido (la sucursal viaja en X-Location-Id). */
export interface ReportRange {
  from: string;
  to: string;
}

export const reportKeys = {
  all: ["reports"] as const,
  report: (id: ReportId, range: ReportRange, location: string) => ["reports", id, range.from, range.to, location] as const,
  home: (location: string) => ["reports", "home", location] as const,
};

const query = (range: ReportRange) => new URLSearchParams({ from: range.from, to: range.to }).toString();

export const reportsApi = {
  get: <K extends ReportId>(id: K, range: ReportRange) => api.get<ReportById[K]>(`/reports/${id}?${query(range)}`),
  /** Descarga el CSV del reporte (con la sucursal activa) y lo guarda con el nombre que da el servidor. */
  exportCsv: (id: ReportId, range: ReportRange) => apiDownload(`/reports/${id}.csv?${query(range)}`, `reporte-${id}.csv`),
  home: () => api.get<HomeOverview>("/home/overview"),
};

export function useReport<K extends ReportId>(id: K, range: ReportRange, enabled = true) {
  return useQuery({
    queryKey: reportKeys.report(id, range, getActiveLocationId() ?? "all"),
    queryFn: () => reportsApi.get(id, range),
    enabled: enabled && Boolean(range.from && range.to && range.from <= range.to),
    placeholderData: (previous) => previous,
    staleTime: 30_000,
  });
}

/** Inicio completo (Pro). `enabled` = el plan trae Reportes. */
export function useHomeOverview(enabled: boolean) {
  return useQuery({ queryKey: reportKeys.home(getActiveLocationId() ?? "all"), queryFn: reportsApi.home, enabled, refetchInterval: 60_000 });
}
