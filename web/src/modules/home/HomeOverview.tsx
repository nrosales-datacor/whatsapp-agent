import { Link } from "react-router-dom";
import { capitalize, terminologyOf } from "../../app/navigation";
import { useSession } from "../../app/session";
import { errorMessage } from "../../lib/api";
import { formatCents } from "../../lib/money";
import ErrorState from "../../ui/ErrorState";
import { DayBarChart } from "../reports/charts";
import { compactCents, formatInt } from "../reports/format";
import { useHomeOverview } from "../reports/reportsApi";
import "../reports/reports.css";
import "../sales/sales.css";

// ─────────────────────────────────────────────────────────────────────────────
// Inicio completo (plan Pro, `GET /home/overview`): cobrado hoy, clientes nuevos, citas y
// no-show de hoy, alertas (sin confirmar hoy y mañana, clientes en riesgo) e ingresos de
// los últimos 14 días. Va arriba del Inicio básico, que sigue con sus listas. "En riesgo"
// es el estado del CRM: el mismo número que el chip «En riesgo» de Clientes, adonde lleva.
// ─────────────────────────────────────────────────────────────────────────────

function Kpi({ label, value, hint, strong = false }: { label: string; value: string; hint?: string; strong?: boolean }) {
  return (
    <div className={"card sales-kpi" + (strong ? " sales-kpi-strong" : "")}>
      <span className="sales-kpi-label">{label}</span>
      <span className="sales-kpi-value tnum">{value}</span>
      {hint && <span className="muted rp-kpi-hint">{hint}</span>}
    </div>
  );
}

const daysAgo = (iso: string): number => Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000));

export default function HomeOverview() {
  const me = useSession();
  const t = terminologyOf(me);
  const query = useHomeOverview(true);
  const currency = me.business.currency;
  const money = (cents: number) => formatCents(cents, currency);

  if (query.isPending) {
    return (
      <div className="clients-loading" role="status">
        <div className="spinner" aria-hidden="true" />
        <span>Cargando los números del día…</span>
      </div>
    );
  }
  if (query.isError) {
    return <ErrorState message={errorMessage(query.error, "No pudimos cargar los números del día.")} onRetry={() => void query.refetch()} />;
  }
  const o = query.data;
  const total14 = o.revenue.reduce((n, d) => n + d.netCents, 0);
  const { unconfirmed, atRisk } = o.alerts;
  const by = o.appointmentsToday.byStatus;

  return (
    <section className="ho" aria-label="Indicadores del día">
      <div className="sales-kpis ho-kpis">
        <Kpi label="Cobrado hoy" value={money(o.collectedToday.netCents)} hint={`${formatInt(o.collectedToday.count)} movimientos`} strong />
        <Kpi label={`${capitalize(t.clients)} nuevos hoy`} value={formatInt(o.newClientsToday)} />
        <Kpi
          label={`${capitalize(t.appointments)} de hoy`}
          value={formatInt(o.appointmentsToday.total)}
          hint={`${formatInt(by.completed ?? 0)} completadas · ${formatInt((by.pending ?? 0) + (by.confirmed ?? 0))} por atender`}
        />
        <Kpi label="No asistieron hoy" value={formatInt(o.noShowsToday)} />
      </div>
      <div className="ho-row">
        <section className="card rp-section" aria-labelledby="ho-revenue-title">
          <div className="sales-section-head">
            <h2 id="ho-revenue-title" className="card-title">
              Ingresos de los últimos 14 días
            </h2>
            <span className="muted tnum">{money(total14)}</span>
          </div>
          <DayBarChart
            data={o.revenue.map((d) => ({ date: d.date, values: [d.netCents] }))}
            series={[{ name: "Neto cobrado", tone: "main" }]}
            label={`Neto cobrado por día en los últimos 14 días: ${money(total14)} en total`}
            format={money}
            axisFormat={(v) => compactCents(v, currency)}
            height={200}
          />
        </section>
        <section className="card rp-section" aria-labelledby="ho-alerts-title">
          <h2 id="ho-alerts-title" className="card-title">
            Para atender
          </h2>
          <div className="ho-alerts">
            <Link className="ho-alert" to={`/agenda?date=${o.date}`}>
              <span>Sin confirmar hoy</span>
              <span className={"ho-alert-count tnum" + (unconfirmed.today === 0 ? " zero" : "")}>{formatInt(unconfirmed.today)}</span>
            </Link>
            <Link className="ho-alert" to="/agenda">
              <span>Sin confirmar mañana</span>
              <span className={"ho-alert-count tnum" + (unconfirmed.tomorrow === 0 ? " zero" : "")}>{formatInt(unconfirmed.tomorrow)}</span>
            </Link>
            <Link className="ho-alert" to="/clients?status=at_risk">
              <span>{capitalize(t.clients)} en riesgo</span>
              <span className={"ho-alert-count tnum" + (atRisk.count === 0 ? " zero" : "")}>{formatInt(atRisk.count)}</span>
            </Link>
            {atRisk.items.length > 0 && (
              <ul className="ho-risk" aria-label={`${capitalize(t.clients)} que hace tiempo no vienen`}>
                {atRisk.items.map((c) => (
                  <li key={c.id}>
                    <Link className="link" to={`/clients/${c.id}`}>
                      {c.name}
                    </Link>
                    <span className="muted tnum">{c.lastVisitAt ? `hace ${formatInt(daysAgo(c.lastVisitAt))} días` : "todavía no vino"}</span>
                  </li>
                ))}
              </ul>
            )}
            <p className="muted ho-note">En riesgo: hace rato que no vuelven, según las reglas de {t.clients} del negocio.</p>
          </div>
        </section>
      </div>
    </section>
  );
}
