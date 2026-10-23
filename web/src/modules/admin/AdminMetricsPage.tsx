import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { errorMessage } from "../../lib/api";
import { BUSINESS_STATUS_LABELS } from "../../lib/plans";
import EmptyState from "../../ui/EmptyState";
import ErrorState from "../../ui/ErrorState";
import { DayBarChart } from "../reports/charts";
import { formatInt, rangeLabel } from "../reports/format";
import { adminMetricsQueryKey, getPlatformMetrics, type UsageQuery } from "./adminApi";
import AdminShell from "./AdminShell";
import "../reports/reports.css";
import "../sales/sales.css";

// ─────────────────────────────────────────────────────────────────────────────
// Superadmin › Métricas de producto (I5, `GET /admin/metrics`): activación y uso de cada
// negocio desde `daily_usage` — negocios activos, con actividad, con citas en la última
// semana, con el agente encendido, activados — y la tabla por negocio.
// ─────────────────────────────────────────────────────────────────────────────

const PRESETS = [7, 30, 90] as const;

function todayCR(): string {
  return new Date(Date.now() - 6 * 3_600_000).toISOString().slice(0, 10);
}

function shift(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

function Kpi({ label, value, hint, strong = false }: { label: string; value: string; hint?: string; strong?: boolean }) {
  return (
    <div className={"card sales-kpi" + (strong ? " sales-kpi-strong" : "")}>
      <span className="sales-kpi-label">{label}</span>
      <span className="sales-kpi-value tnum">{value}</span>
      {hint && <span className="muted rp-kpi-hint">{hint}</span>}
    </div>
  );
}

const shortDate = (date: string | null) => (date ? rangeLabel(date, date) : "—");

export default function AdminMetricsPage() {
  const [days, setDays] = useState<(typeof PRESETS)[number]>(30);
  const to = todayCR();
  const q: UsageQuery = { from: shift(to, -(days - 1)), to };
  const query = useQuery({ queryKey: adminMetricsQueryKey(q), queryFn: () => getPlatformMetrics(q), placeholderData: (prev) => prev });

  return (
    <AdminShell title="Métricas · Superadmin">
      <h1 className="page-title">Métricas de producto</h1>
      <div className="am-toolbar">
        <fieldset className="rp-presets">
          <legend className="field-label">Período</legend>
          <div className="rp-presets-options">
            {PRESETS.map((p) => (
              <label key={p} className={"rp-preset" + (days === p ? " active" : "")}>
                <input type="radio" name="admin-period" value={p} checked={days === p} onChange={() => setDays(p)} />
                {p} días
              </label>
            ))}
          </div>
        </fieldset>
      </div>
      {query.isPending ? (
        <p className="muted" role="status">
          Cargando métricas…
        </p>
      ) : query.isError ? (
        <ErrorState message={errorMessage(query.error, "No pudimos cargar las métricas.")} onRetry={() => void query.refetch()} />
      ) : (
        <div className="stack">
          <div className="sales-kpis am-kpis" aria-label="Activación">
            <Kpi label="Negocios" value={formatInt(query.data.totals.businesses)} hint={`${formatInt(query.data.totals.activeBusinesses)} activos · ${formatInt(query.data.totals.pausedBusinesses)} pausados`} />
            <Kpi label="Con actividad" value={formatInt(query.data.totals.withActivity)} hint={rangeLabel(query.data.range.from, query.data.range.to)} strong />
            <Kpi label="Con citas en la última semana" value={formatInt(query.data.totals.withAppointmentsLastWeek)} />
            <Kpi label="Agente encendido" value={formatInt(query.data.totals.withAgentOn)} />
            <Kpi label="Activados" value={formatInt(query.data.totals.activated)} hint="Entraron y crearon una cita" />
          </div>
          <div className="sales-kpis am-kpis" aria-label="Uso del período">
            <Kpi label="Citas creadas" value={formatInt(query.data.totals.appointmentsCreated)} />
            <Kpi label="Pagos registrados" value={formatInt(query.data.totals.paymentsRecorded)} />
            <Kpi label="Usuarios activos" value={formatInt(query.data.totals.activeUsers)} hint="Días-persona" />
            <Kpi label="Logins" value={formatInt(query.data.totals.logins)} />
            <Kpi label="Conversaciones del agente" value={formatInt(query.data.totals.aiConversations)} hint={`${formatInt(query.data.totals.whatsappHandoffs)} pasadas a una persona`} />
          </div>
          <section className="card rp-section" aria-labelledby="am-daily-title">
            <h2 id="am-daily-title" className="card-title">
              Negocios con actividad por día
            </h2>
            <DayBarChart
              data={query.data.daily.map((d) => ({ date: d.date, values: [d.activeBusinesses] }))}
              series={[{ name: "Negocios con actividad", tone: "main" }]}
              label={`Negocios con actividad por día, ${rangeLabel(query.data.range.from, query.data.range.to)}`}
              format={formatInt}
            />
          </section>
          {query.data.businesses.length === 0 ? (
            <EmptyState icon="building" title="Sin negocios" help="Cuando des de alta un negocio, su uso aparece acá." />
          ) : (
            <div className="card am-table-card">
              <table className="sales-table" aria-label="Uso por negocio">
                <thead>
                  <tr>
                    <th scope="col">Negocio</th>
                    <th scope="col">Agente</th>
                    <th scope="col" className="sales-col-num">
                      Citas
                    </th>
                    <th scope="col" className="sales-col-num">
                      Últ. semana
                    </th>
                    <th scope="col" className="sales-col-num">
                      Pagos
                    </th>
                    <th scope="col" className="sales-col-num">
                      Usuarios activos
                    </th>
                    <th scope="col" className="sales-col-num">
                      Logins
                    </th>
                    <th scope="col" className="sales-col-num">
                      Conversaciones
                    </th>
                    <th scope="col">Última actividad</th>
                    <th scope="col">Activado</th>
                  </tr>
                </thead>
                <tbody>
                  {query.data.businesses.map((b) => (
                    <tr key={b.id}>
                      <th scope="row">
                        <Link className="link" to={`/admin/businesses/${b.id}`}>
                          {b.name}
                        </Link>
                        <span className="sales-row-note">
                          {b.planLabel}
                          {b.status !== "active" ? ` · ${BUSINESS_STATUS_LABELS[b.status] ?? b.status}` : ""}
                        </span>
                      </th>
                      <td className={b.agentOn ? "am-badge-on" : "am-badge-off"}>{b.agentOn ? "Encendido" : "Apagado"}</td>
                      <td className="sales-col-num tnum">{formatInt(b.usage.appointmentsCreated)}</td>
                      <td className="sales-col-num tnum">{formatInt(b.appointmentsLastWeek)}</td>
                      <td className="sales-col-num tnum">{formatInt(b.usage.paymentsRecorded)}</td>
                      <td className="sales-col-num tnum">{formatInt(b.usage.activeUsers)}</td>
                      <td className="sales-col-num tnum">{formatInt(b.usage.logins)}</td>
                      <td className="sales-col-num tnum">{formatInt(b.usage.aiConversations)}</td>
                      <td className="sales-nowrap">{shortDate(b.lastActivityOn)}</td>
                      <td>{b.activation.activated ? `Sí (${shortDate(b.activation.firstAppointmentOn)})` : "Todavía no"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </AdminShell>
  );
}
