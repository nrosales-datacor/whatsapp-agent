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
