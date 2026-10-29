import { useLayoutEffect, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { NavLink, useNavigate } from "react-router-dom";
import { documentTitle, PRODUCT_NAME } from "../../lib/branding";
import Icon from "../../ui/Icons";
import { ADMIN_ME_QUERY_KEY, adminLogout, fetchAdminMe } from "./adminApi";

/** Marco de las pantallas del superadmin: barra superior con Negocios · Métricas, el usuario y "Salir". */
export default function AdminShell({ title, children }: { title: string; children: ReactNode }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const adminMe = useQuery({ queryKey: ADMIN_ME_QUERY_KEY, queryFn: fetchAdminMe, staleTime: 60_000 });
  const logout = useMutation({
    mutationFn: adminLogout,
    onSettled: () => {
      qc.removeQueries({ queryKey: ["admin"] });
      qc.setQueryData(ADMIN_ME_QUERY_KEY, null);
      navigate("/admin/login", { replace: true });
    },
  });

  useLayoutEffect(() => {
    document.title = documentTitle(title);
  }, [title]);

  return (
    <div className="admin-shell">
      <header className="admin-topbar">
        <span className="brand-chip" aria-hidden="true">
          SC
        </span>
        <div className="admin-topbar-title">
          <span className="admin-topbar-product">{PRODUCT_NAME}</span>
          <span className="admin-topbar-sub">Superadmin</span>
        </div>
        <nav className="admin-nav" aria-label="Superadmin">
          <NavLink to="/admin" end className={({ isActive }) => "admin-nav-link" + (isActive ? " active" : "")}>
            Negocios
          </NavLink>
          <NavLink to="/admin/metrics" className={({ isActive }) => "admin-nav-link" + (isActive ? " active" : "")}>
            Métricas
          </NavLink>
        </nav>
        {adminMe.data && <span className="admin-topbar-user">{adminMe.data.username}</span>}
        <button type="button" className="btn btn-ghost-inverse" onClick={() => logout.mutate()} disabled={logout.isPending}>
          <Icon id="logout" size={18} />
          <span>Salir</span>
        </button>
      </header>
      <main className="admin-main" id="main">
        {children}
      </main>
    </div>
  );
}
