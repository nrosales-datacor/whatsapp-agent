import { useLayoutEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { documentTitle, PRODUCT_NAME } from "../../lib/branding";
import type { AdminBusiness } from "../../lib/contract";
import EmptyState from "../../ui/EmptyState";
import ErrorState from "../../ui/ErrorState";
import Icon from "../../ui/Icons";
import { ADMIN_BUSINESSES_QUERY_KEY, ADMIN_ME_QUERY_KEY, adminLogout, fetchAdminMe, listBusinesses } from "./adminApi";
import CreateBusinessForm, { INDUSTRY_OPTIONS } from "./CreateBusinessForm";

const PLAN_LABELS: Record<string, string> = { basic: "Básico", pro: "Pro" };
const STATUS_LABELS: Record<string, string> = { active: "Activo", paused: "Pausado", closed: "Dado de baja" };

function formatDate(iso: string): string | null {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString("es-CR", { day: "numeric", month: "short", year: "numeric" });
}

function BusinessRow({ business }: { business: AdminBusiness }) {
  const industry = INDUSTRY_OPTIONS.find((o) => o.value === business.industry)?.label ?? business.industry;
  const created = formatDate(business.createdAt);
  const locations = `${business.locationCount} ${business.locationCount === 1 ? "sucursal" : "sucursales"}`;
  return (
    <li className="business-row">
      <div className="business-row-main">
        <span className="business-row-name">{business.name}</span>
        <span className="business-row-slug">{business.slug}</span>
      </div>
      <div className="business-row-meta">
        <span className="badge">{PLAN_LABELS[business.plan] ?? business.plan}</span>
        {business.status !== "active" && (
          <span className="badge badge-warning">{STATUS_LABELS[business.status] ?? business.status}</span>
        )}
        <span>{industry}</span>
        <span>
          {business.country} · {business.currency}
        </span>
        <span className="tnum">{locations}</span>
        {created && <span className="tnum">Alta: {created}</span>}
      </div>
    </li>
  );
}

/** Área de superadmin (/admin): negocios de la plataforma y alta de uno nuevo. */
export default function AdminHomePage() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const adminMe = useQuery({ queryKey: ADMIN_ME_QUERY_KEY, queryFn: fetchAdminMe, staleTime: 60_000 });
  const businesses = useQuery({ queryKey: ADMIN_BUSINESSES_QUERY_KEY, queryFn: listBusinesses });
  const logout = useMutation({
    mutationFn: adminLogout,
    onSettled: () => {
      qc.removeQueries({ queryKey: ["admin"] });
      qc.setQueryData(ADMIN_ME_QUERY_KEY, null);
      navigate("/admin/login", { replace: true });
    },
  });

  useLayoutEffect(() => {
    document.title = documentTitle("Superadmin");
  }, []);

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
        {adminMe.data && <span className="admin-topbar-user">{adminMe.data.username}</span>}
        <button type="button" className="btn btn-ghost-inverse" onClick={() => logout.mutate()} disabled={logout.isPending}>
          <Icon id="logout" size={18} />
          <span>Salir</span>
        </button>
      </header>

      <main className="admin-main" id="main">
        <h1 className="page-title">Negocios</h1>
        <div className="admin-grid">
          <section className="card" aria-labelledby="business-list-title">
            <h2 id="business-list-title" className="card-title">
              Negocios de la plataforma{businesses.data ? ` (${businesses.data.length})` : ""}
            </h2>
            {businesses.isPending ? (
              <p className="muted" role="status">
                Cargando negocios…
              </p>
            ) : businesses.isError ? (
              <ErrorState message="No pudimos cargar los negocios." onRetry={() => void businesses.refetch()} />
            ) : businesses.data.length === 0 ? (
              <EmptyState icon="building" title="Todavía no hay negocios" help="Cuando des de alta el primero, aparece acá." />
            ) : (
              <ul className="business-list">
                {businesses.data.map((b) => (
                  <BusinessRow key={b.id} business={b} />
                ))}
              </ul>
            )}
          </section>
          <CreateBusinessForm />
        </div>
      </main>
    </div>
  );
}
