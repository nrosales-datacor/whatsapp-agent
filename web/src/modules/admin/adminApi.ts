import { api, isApiError } from "../../lib/api";
import type {
  AdminBusiness,
  AdminBusinessDetail,
  AdminLoginInput,
  AdminLoginResult,
  AdminMe,
  CreateBusinessInput,
  PlanChangeInput,
} from "../../lib/contract";

// Endpoints del superadmin (/api/panel/admin/*). Sesión propia, separada de la del panel.

export const ADMIN_ME_QUERY_KEY = ["adminMe"] as const;
export const ADMIN_BUSINESSES_QUERY_KEY = ["admin", "businesses"] as const;
export const adminBusinessQueryKey = (id: string) => ["admin", "business", id] as const;

export async function fetchAdminMe(): Promise<AdminMe | null> {
  try {
    return await api.get<AdminMe>("/admin/me");
  } catch (error) {
    if (isApiError(error) && error.status === 401) return null;
    throw error;
  }
}

export const adminLogin = (input: AdminLoginInput) => api.post<AdminLoginResult>("/admin/login", input);

export const adminLogout = () => api.post<void>("/admin/logout");

export const listBusinesses = () => api.get<AdminBusiness[]>("/admin/businesses");

export const createBusiness = (input: CreateBusinessInput) => api.post<AdminBusiness>("/admin/businesses", input);

// ── Plan, cobro y pausa (I2) ──

const businessPath = (id: string) => `/admin/businesses/${encodeURIComponent(id)}`;

export const getBusinessDetail = (id: string) => api.get<AdminBusinessDetail>(businessPath(id));

/** `extraModules` y `limits` reemplazan lo contratado; lo que no se manda se conserva. */
export const changeBusinessPlan = (id: string, input: PlanChangeInput) => api.patch<AdminBusinessDetail>(`${businessPath(id)}/plan`, input);

export const pauseBusiness = (id: string, reason?: string) => api.post<AdminBusinessDetail>(`${businessPath(id)}/pause`, reason ? { reason } : {});

export const reactivateBusiness = (id: string) => api.post<AdminBusinessDetail>(`${businessPath(id)}/reactivate`);

// ── Métricas de producto (I5): espejo de src/admin/metrics.ts ──

export interface UsageTotals {
  appointmentsCreated: number;
  paymentsRecorded: number;
  /** Días-persona: una persona activa 3 días suma 3. */
  activeUsers: number;
  logins: number;
  aiConversations: number;
  whatsappHandoffs: number;
}

export interface UsageRange {
  from: string;
  to: string;
  days: number;
  timezone: string;
}

export interface Activation {
  firstLoginOn: string | null;
  firstAppointmentOn: string | null;
  firstPaymentOn: string | null;
  firstAiConversationOn: string | null;
  activated: boolean;
}

export interface BusinessUsageRow {
  id: string;
  name: string;
  planLabel: string;
  status: string;
  createdAt: string;
  agentOn: boolean;
  usage: UsageTotals;
  appointmentsLastWeek: number;
  activeDays: number;
  lastActivityOn: string | null;
  activation: Activation;
}

export interface PlatformMetrics {
  range: UsageRange;
  totals: UsageTotals & {
    businesses: number;
    activeBusinesses: number;
    pausedBusinesses: number;
    withActivity: number;
    withAppointmentsLastWeek: number;
    withAgentOn: number;
    activated: number;
  };
  daily: (UsageTotals & { date: string; activeBusinesses: number })[];
  businesses: BusinessUsageRow[];
}

export interface BusinessUsage {
  business: { id: string; name: string; planLabel: string; status: string };
  range: UsageRange;
  totals: UsageTotals;
  daily: (UsageTotals & { date: string })[];
  activation: Activation;
}

export interface UsageQuery {
  from?: string;
  to?: string;
}

const usageQuery = (q: UsageQuery) => {
  const params = new URLSearchParams();
  if (q.from) params.set("from", q.from);
  if (q.to) params.set("to", q.to);
  const s = params.toString();
  return s ? `?${s}` : "";
};

export const adminMetricsQueryKey = (q: UsageQuery) => ["admin", "metrics", q.from ?? "", q.to ?? ""] as const;
export const adminUsageQueryKey = (id: string, q: UsageQuery) => ["admin", "usage", id, q.from ?? "", q.to ?? ""] as const;

export const getPlatformMetrics = (q: UsageQuery = {}) => api.get<PlatformMetrics>(`/admin/metrics${usageQuery(q)}`);

export const getBusinessUsage = (id: string, q: UsageQuery = {}) => api.get<BusinessUsage>(`${businessPath(id)}/usage${usageQuery(q)}`);
