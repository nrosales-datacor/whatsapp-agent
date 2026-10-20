import { useQuery } from "@tanstack/react-query";
import { Navigate, Outlet } from "react-router-dom";
import FullPageStatus from "../../ui/FullPageStatus";
import { ADMIN_ME_QUERY_KEY, fetchAdminMe } from "./adminApi";

/** Guarda del área de superadmin: sin sesión de superadmin → /admin/login. */
export default function RequireAdmin() {
  const query = useQuery({ queryKey: ADMIN_ME_QUERY_KEY, queryFn: fetchAdminMe, staleTime: 60_000 });
  if (query.isPending) return <FullPageStatus message="Cargando…" />;
  if (query.isError) {
    return <FullPageStatus message="No pudimos cargar la sesión." error onRetry={() => void query.refetch()} />;
  }
  if (!query.data) return <Navigate to="/admin/login" replace />;
  return <Outlet />;
}
