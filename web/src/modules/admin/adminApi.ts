import { api, isApiError } from "../../lib/api";
import type { AdminBusiness, AdminLoginInput, AdminLoginResult, AdminMe, CreateBusinessInput } from "../../lib/contract";

// Endpoints del superadmin (/api/panel/admin/*). Sesión propia, separada de la del panel.

export const ADMIN_ME_QUERY_KEY = ["adminMe"] as const;
export const ADMIN_BUSINESSES_QUERY_KEY = ["admin", "businesses"] as const;

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
