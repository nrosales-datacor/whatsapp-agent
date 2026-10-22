import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import type { AdminBusiness } from "../../lib/contract";
import { BILLING_STATUS_LABELS, BUSINESS_STATUS_LABELS } from "../../lib/plans";
import EmptyState from "../../ui/EmptyState";
import ErrorState from "../../ui/ErrorState";
import { ADMIN_BUSINESSES_QUERY_KEY, listBusinesses } from "./adminApi";
import AdminShell from "./AdminShell";
import CreateBusinessForm, { INDUSTRY_OPTIONS } from "./CreateBusinessForm";

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
        <Link className="link business-row-manage" to={`/admin/businesses/${business.id}`} aria-label={`Gestionar plan de ${business.name}`}>
          Gestionar
        </Link>
      </div>
      <div className="business-row-meta">
        <span className="badge">{business.planLabel}</span>
        {business.status !== "active" && (
          <span className="badge badge-warning">{BUSINESS_STATUS_LABELS[business.status] ?? business.status}</span>
        )}
        <span>Cobro: {BILLING_STATUS_LABELS[business.billingStatus] ?? business.billingStatus}</span>
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
  const businesses = useQuery({ queryKey: ADMIN_BUSINESSES_QUERY_KEY, queryFn: listBusinesses });

  return (
    <AdminShell title="Superadmin">
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
    </AdminShell>
  );
}
