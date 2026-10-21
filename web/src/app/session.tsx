import { createContext, useContext, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Navigate, Outlet, useLocation, useNavigate } from "react-router-dom";
import { api, isApiError } from "../lib/api";
import { resetBranding } from "../lib/branding";
import type { Me } from "../lib/contract";
import FullPageStatus from "../ui/FullPageStatus";
import { useToast } from "../ui/Toast";
import AccountPausedPage from "./AccountPausedPage";
import { homePathFor } from "./navigation";

// ─────────────────────────────────────────────────────────────────────────────
// Sesión del usuario del panel. Vive en la query ["me"] de TanStack Query:
//   • `GET /auth/me` → Me, o null si no hay sesión (401).
//   • Un 401 `unauthorized` en cualquier otra llamada la pone en null (main.tsx) y la
//     guarda `RequireAuth` manda al login, recordando adónde iba.
//   • Login, aceptar invitación y cambiar de negocio escriben el Me nuevo directo en la
//     query (el backend ya lo devuelve), sin otro viaje.
//   • Negocio pausado por el superadmin: `/auth/me` responde 403 `business_paused` y
//     `RequireAuth` muestra "Cuenta pausada" (main.tsx vuelve a pedir la sesión si el 403
//     llega en cualquier otra llamada).
// ─────────────────────────────────────────────────────────────────────────────

export const ME_QUERY_KEY = ["me"] as const;

export async function fetchMe(): Promise<Me | null> {
  try {
    return await api.get<Me>("/auth/me");
  } catch (error) {
    if (isApiError(error) && error.status === 401) return null;
    throw error;
  }
}

export function useMeQuery() {
  return useQuery({ queryKey: ME_QUERY_KEY, queryFn: fetchMe, staleTime: 60_000 });
}

/** Estado de navegación que llevan las redirecciones al login (adónde volver después). */
export interface LoginRedirectState {
  from?: string;
}

const SessionContext = createContext<Me | null>(null);

/** La sesión actual. Solo dentro de las rutas protegidas por `RequireAuth`. */
export function useSession(): Me {
  const me = useContext(SessionContext);
  if (!me) throw new Error("useSession se usó fuera de RequireAuth");
  return me;
}

/** Guarda de las rutas autenticadas: sin sesión → login; clave temporal → cambio obligatorio. */
export function RequireAuth() {
  const location = useLocation();
  const query = useMeQuery();

  if (query.isPending) return <FullPageStatus message="Cargando tu panel…" />;
  if (isApiError(query.error, "business_paused")) return <AccountPausedPage onRetry={() => void query.refetch()} />;
  if (query.isError) {
    return (
      <FullPageStatus
        message="No pudimos cargar tu sesión."
        error
        onRetry={() => void query.refetch()}
      />
    );
  }
  const me = query.data;
  if (!me) {
    const state: LoginRedirectState = { from: location.pathname + location.search };
    return <Navigate to="/login" replace state={state} />;
  }
  if (me.user.mustChangePassword && location.pathname !== "/change-password") {
    return <Navigate to="/change-password" replace />;
  }
  return (
    <SessionContext.Provider value={me}>
      <Outlet />
    </SessionContext.Provider>
  );
}

/** Para /login y /forgot-password: con sesión abierta no tiene sentido mostrarlas. */
export function PublicOnly({ children }: { children: ReactNode }) {
  const query = useMeQuery();
  const location = useLocation();
  if (query.isPending) return <FullPageStatus message="Cargando…" />;
  if (query.data) {
    const from = (location.state as LoginRedirectState | null)?.from;
    return <Navigate to={from ?? homePathFor(query.data)} replace />;
  }
  return <>{children}</>;
}

/** Deja la sesión nueva (login, invitación aceptada) y descarta lo que hubiera de otra. */
export function useSetSession() {
  const qc = useQueryClient();
  return (me: Me) => {
    qc.removeQueries({ predicate: (q) => q.queryKey[0] !== ME_QUERY_KEY[0] });
    qc.setQueryData(ME_QUERY_KEY, me);
  };
}

export function useLogout() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  return useMutation({
    mutationFn: () => api.post<void>("/auth/logout"),
    // Aunque el backend falle (sin red), la sesión local se cierra igual.
    onSettled: () => {
      qc.clear();
      qc.setQueryData(ME_QUERY_KEY, null);
      resetBranding();
      navigate("/login", { replace: true });
    },
  });
}

export function useSwitchBusiness() {
  const setSession = useSetSession();
  const navigate = useNavigate();
  const { showToast } = useToast();
  return useMutation({
    mutationFn: (businessId: string) => api.post<Me>("/auth/switch-business", { businessId }),
    onSuccess: (me) => {
      setSession(me);
      navigate(homePathFor(me), { replace: true });
      showToast(`Ahora estás en ${me.business.name}.`);
    },
    onError: (error) => {
      showToast(isApiError(error) ? error.message : "No pudimos cambiar de negocio.");
    },
  });
}
