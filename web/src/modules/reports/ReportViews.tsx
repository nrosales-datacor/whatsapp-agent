import { useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { capitalize, terminologyOf } from "../../app/navigation";
import { useSession } from "../../app/session";
import { errorMessage } from "../../lib/api";
import { formatCents } from "../../lib/money";
import EmptyState from "../../ui/EmptyState";
import ErrorState from "../../ui/ErrorState";
import { CLIENT_STATUSES } from "../clients/clientsApi";
import { StatusBadge } from "../clients/StatusBadge";
import "../clients/clients.css";
import { DayBarChart, Meter, RankingChart } from "./charts";
import { compactCents, deltaText, formatInt, formatMinutes, formatRate, rangeLabel } from "./format";
import { useReportRange } from "./ReportsPage";
import { useReport, type ReportById, type ReportId } from "./reportsApi";

// ─────────────────────────────────────────────────────────────────────────────
// Las cinco pestañas de Reportes. Cada una: indicadores arriba, un gráfico (SVG propio con
// su tabla equivalente) y la tabla completa. Montos en la moneda del negocio.
// ─────────────────────────────────────────────────────────────────────────────

/** Carga, error y vacío comunes; `render` recibe el reporte listo. */
function ReportFrame<K extends ReportId>({ id, what, render }: { id: K; what: string; render: (report: ReportById[K]) => ReactNode }) {
  const { range, valid } = useReportRange();
  const query = useReport(id, range, valid);
  if (!valid) return null;
  if (query.isPending) {
    return (
      <div className="clients-loading" role="status">
        <div className="spinner" aria-hidden="true" />
        <span>Cargando {what}…</span>
      </div>
    );
  }
  if (query.isError) return <ErrorState message={errorMessage(query.error, `No pudimos cargar ${what}.`)} onRetry={() => void query.refetch()} />;
  return <div className={"stack rp-body" + (query.isFetching ? " rp-refreshing" : "")}>{render(query.data)}</div>;
}

function Kpi({ label, value, hint, strong = false }: { label: string; value: string; hint?: string | null; strong?: boolean }) {
  return (
    <div className={"card sales-kpi" + (strong ? " sales-kpi-strong" : "")}>
      <span className="sales-kpi-label">{label}</span>
      <span className="sales-kpi-value tnum">{value}</span>
      {hint && <span className="muted rp-kpi-hint">{hint}</span>}
    </div>
  );
}

function Section({ id, title, children, aside }: { id: string; title: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className="card rp-section" aria-labelledby={id}>
      <div className="sales-section-head">
        <h2 id={id} className="card-title">
          {title}
        </h2>
        {aside}
      </div>
      {children}
    </section>
  );
}

// ── Ventas ──────────────────────────────────────────────────────────────────

export function SalesReportView() {
  const me = useSession();
  const t = terminologyOf(me);
  const currency = me.business.currency;
  const money = (cents: number) => formatCents(cents, currency);
  return (
    <ReportFrame
      id="sales"
      what="el reporte de ventas"
      render={(r) => {
        const empty = r.totals.count === 0;
        return (
          <>
            <div className="sales-kpis" aria-label="Indicadores de ventas">
              <Kpi label="Neto cobrado" value={money(r.totals.netCents)} hint={deltaText(r.totals.netCents, r.previous.netCents)} strong />
              <Kpi label="Cobrado (señas + cobros)" value={money(r.totals.collectedCents)} hint={`${formatInt(r.totals.count)} movimientos`} />
              <Kpi label="Señas" value={money(r.totals.depositsCents)} />
              <Kpi label="Devoluciones" value={money(r.totals.refundsCents)} />
              <Kpi
                label="Ticket promedio"
                value={r.totals.averageTicketCents === null ? "—" : money(r.totals.averageTicketCents)}
                hint={`${formatInt(r.totals.tickets)} ${r.totals.tickets === 1 ? "venta" : "ventas"}`}
              />
            </div>
            {empty ? (
              <EmptyState icon="receipt" title="Sin cobros en el período" help="Cuando registres cobros y señas en Ventas, los ingresos aparecen acá." />
            ) : (
              <>
                <Section id="rp-sales-day" title="Ingresos por día">
                  <DayBarChart
                    data={r.byDay.map((d) => ({ date: d.date, values: [d.netCents] }))}
                    series={[{ name: "Neto cobrado", tone: "main" }]}
                    label={`Neto cobrado por día, ${rangeLabel(r.range.from, r.range.to)}: ${money(r.totals.netCents)} en total`}
                    format={money}
                    axisFormat={(v) => compactCents(v, currency)}
                  />
                </Section>
                <div className="rp-grid-2">
                  <Section id="rp-sales-method" title="Por método de pago">
                    <RankingChart
                      items={r.byMethod.map((g) => ({ key: g.key ?? g.label, label: g.label, value: Math.max(0, g.netCents), display: money(g.netCents) }))}
                      label={`Neto cobrado por método de pago: ${r.byMethod.map((g) => `${g.label} ${money(g.netCents)}`).join(", ")}`}
                      labelHeader="Método"
                      valueHeader="Neto"
                    />
                  </Section>
                  <Section id="rp-sales-location" title={`Por ${t.location}`}>
                    <table className="sales-table" aria-label={`Neto por ${t.location}`}>
                      <thead>
                        <tr>
                          <th scope="col">{capitalize(t.location)}</th>
                          <th scope="col" className="sales-col-num">
                            Cobrado
                          </th>
                          <th scope="col" className="sales-col-num">
                            Devoluciones
                          </th>
                          <th scope="col" className="sales-col-num">
                            Neto
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {r.byLocation.map((g) => (
                          <tr key={g.key ?? g.label}>
                            <th scope="row">{g.label}</th>
                            <td className="sales-col-num tnum">{money(g.collectedCents)}</td>
                            <td className="sales-col-num tnum">{money(g.refundsCents)}</td>
                            <td className="sales-col-num tnum sales-strong">{money(g.netCents)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </Section>
                </div>
              </>
            )}
          </>
        );
      }}
    />
  );
}

// ── Servicios ───────────────────────────────────────────────────────────────

export function ServicesReportView() {
  const me = useSession();
  const t = terminologyOf(me);
  const currency = me.business.currency;
  const money = (cents: number) => formatCents(cents, currency);
  const [sortBy, setSortBy] = useState<"quantity" | "revenue">("quantity");
  return (
    <ReportFrame
      id="services"
      what="el reporte de servicios"
      render={(r) => {
        if (r.items.length === 0) {
          return <EmptyState icon="chart" title="Sin servicios en el período" help={`Cuando haya ${t.appointments} en estas fechas, vas a ver acá los servicios más vendidos.`} />;
        }
        const items = [...r.items].sort((a, b) =>
          sortBy === "revenue" ? b.collectedNetCents - a.collectedNetCents || b.completed - a.completed : b.completed - a.completed || b.collectedNetCents - a.collectedNetCents,
        );
        return (
          <>
            <div className="sales-kpis" aria-label="Indicadores de servicios">
              <Kpi label="Servicios realizados" value={formatInt(r.totals.completed)} hint={`${formatInt(r.totals.scheduled)} agendados`} strong />
              <Kpi label="Valor realizado" value={money(r.totals.completedValueCents)} hint="Precios de las citas completadas" />
              <Kpi label="Cobrado neto" value={money(r.totals.collectedNetCents)} hint={r.looseCollectedNetCents ? `+ ${money(r.looseCollectedNetCents)} sin cita` : null} />
            </div>
            <Section
              id="rp-services-top"
              title="Más vendidos"
              aside={
                <div className="rp-switch" role="group" aria-label="Ordenar por">
                  <button type="button" className={"rp-switch-btn" + (sortBy === "quantity" ? " active" : "")} aria-pressed={sortBy === "quantity"} onClick={() => setSortBy("quantity")}>
                    Por cantidad
                  </button>
                  <button type="button" className={"rp-switch-btn" + (sortBy === "revenue" ? " active" : "")} aria-pressed={sortBy === "revenue"} onClick={() => setSortBy("revenue")}>
                    Por ingresos
                  </button>
                </div>
              }
            >
              <RankingChart
                items={items.map((i) => ({
                  key: i.serviceId ?? i.name,
                  label: i.name,
                  value: sortBy === "revenue" ? Math.max(0, i.collectedNetCents) : i.completed,
                  display: sortBy === "revenue" ? money(i.collectedNetCents) : `${formatInt(i.completed)} realizados`,
                }))}
                label={`Servicios más vendidos ${sortBy === "revenue" ? "por ingresos" : "por cantidad"}: ${items
                  .slice(0, 5)
                  .map((i) => i.name)
                  .join(", ")}`}
                labelHeader="Servicio"
                valueHeader={sortBy === "revenue" ? "Cobrado neto" : "Realizados"}
              />
            </Section>
            <div className="card sales-table-card">
              <table className="sales-table" aria-label="Servicios del período">
                <thead>
                  <tr>
                    <th scope="col">Servicio</th>
                    <th scope="col" className="sales-col-num">
                      Agendados
                    </th>
                    <th scope="col" className="sales-col-num">
                      Realizados
                    </th>
                    <th scope="col" className="sales-col-num">
                      Valor realizado
                    </th>
                    <th scope="col" className="sales-col-num">
                      Cobrado neto
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((i) => (
                    <tr key={i.serviceId ?? `name:${i.name}`}>
                      <th scope="row">
                        {i.name}
                        {!i.serviceId && <span className="sales-row-note">Ya no está en el catálogo</span>}
                      </th>
                      <td className="sales-col-num tnum">{formatInt(i.scheduled)}</td>
                      <td className="sales-col-num tnum">{formatInt(i.completed)}</td>
                      <td className="sales-col-num tnum">{money(i.completedValueCents)}</td>
                      <td className="sales-col-num tnum sales-strong">{money(i.collectedNetCents)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        );
      }}
    />
  );
}

// ── Profesionales ───────────────────────────────────────────────────────────

export function StaffReportView() {
  const me = useSession();
  const t = terminologyOf(me);
  const currency = me.business.currency;
  const money = (cents: number) => formatCents(cents, currency);
  const showCommissions = me.modules.includes("commissions");
  return (
    <ReportFrame
      id="staff"
      what={`el reporte de ${t.staff}`}
      render={(r) => {
        if (r.items.length === 0) {
          return <EmptyState icon="users" title={`Sin ${t.staff}`} help={`Cargá a tu equipo en Configuración › Equipo para ver su ocupación y sus números.`} />;
        }
        return (
          <>
            <div className="sales-kpis" aria-label={`Indicadores de ${t.staff}`}>
              <Kpi label="Ocupación" value={formatRate(r.totals.occupancyRate)} hint={`${formatMinutes(r.totals.bookedMinutes)} de ${formatMinutes(r.totals.availableMinutes)}`} strong />
              <Kpi label={capitalize(t.appointments)} value={formatInt(r.totals.appointments)} hint={`${formatInt(r.totals.completed)} completadas`} />
              <Kpi label="No asistió" value={formatRate(r.totals.noShowRate)} hint={`${formatInt(r.totals.noShow)} de ${formatInt(r.totals.completed + r.totals.noShow)}`} />
              <Kpi label="Cobrado neto" value={money(r.totals.collectedNetCents)} />
              {showCommissions && <Kpi label="Comisiones" value={money(r.totals.commissionCents)} />}
            </div>
            <Section id="rp-staff-occupancy" title="Ocupación">
              <RankingChart
                items={[...r.items]
                  .filter((i) => i.availableMinutes > 0 || i.bookedMinutes > 0)
                  .sort((a, b) => (b.occupancyRate ?? 0) - (a.occupancyRate ?? 0))
                  .map((i) => ({ key: i.staffId, label: i.name, value: Math.min(1.5, i.occupancyRate ?? 0), display: formatRate(i.occupancyRate) }))}
                label={`Ocupación por ${t.staffMember}: ${r.items.map((i) => `${i.name} ${formatRate(i.occupancyRate)}`).join(", ")}`}
                labelHeader={capitalize(t.staffMember)}
                valueHeader="Ocupación"
              />
            </Section>
            <div className="card sales-table-card">
              <table className="sales-table" aria-label={`${capitalize(t.staff)} del período`}>
                <thead>
                  <tr>
                    <th scope="col">{capitalize(t.staffMember)}</th>
                    <th scope="col" className="sales-col-num">
                      {capitalize(t.appointments)}
                    </th>
                    <th scope="col" className="sales-col-num">
                      Completadas
                    </th>
                    <th scope="col" className="sales-col-num">
                      No-show
                    </th>
                    <th scope="col" className="sales-col-num">
                      Cobrado neto
                    </th>
                    <th scope="col">Ocupación</th>
                    {showCommissions && (
                      <th scope="col" className="sales-col-num">
                        Comisiones
                      </th>
                    )}
                  </tr>
                </thead>
                <tbody>
                  {r.items.map((i) => (
                    <tr key={i.staffId}>
                      <th scope="row" className="sales-nowrap">
                        <span className="staff-dot" style={{ background: i.color ?? "var(--accent)" }} aria-hidden="true" />
                        {i.name}
                        {!i.active && <span className="sales-row-note">Inactivo</span>}
                      </th>
                      <td className="sales-col-num tnum">{formatInt(i.appointments)}</td>
                      <td className="sales-col-num tnum">{formatInt(i.completed)}</td>
                      <td className="sales-col-num tnum">{formatRate(i.noShowRate)}</td>
                      <td className="sales-col-num tnum sales-strong">{money(i.collectedNetCents)}</td>
                      <td>
                        <Meter value={i.occupancyRate} label={`Ocupación de ${i.name}`} />
                        <span className="sales-row-note tnum">
                          {formatMinutes(i.bookedMinutes)} de {formatMinutes(i.availableMinutes)}
                        </span>
                      </td>
                      {showCommissions && <td className="sales-col-num tnum">{money(i.commissionCents)}</td>}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        );
      }}
    />
  );
}

// ── Clientes ────────────────────────────────────────────────────────────────

export function ClientsReportView() {
  const me = useSession();
  const t = terminologyOf(me);
  return (
    <ReportFrame
      id="clients"
      what={`el reporte de ${t.clients}`}
      render={(r) => (
        <>
          <div className="sales-kpis" aria-label={`Indicadores de ${t.clients}`}>
            <Kpi label={`${capitalize(t.clients)} atendidos`} value={formatInt(r.served)} hint={`${formatInt(r.visits)} visitas`} strong />
            <Kpi label="Nuevos" value={formatInt(r.newClients)} hint="Primera visita en el período" />
            <Kpi label="Recurrentes" value={formatInt(r.returningClients)} hint="Ya habían venido antes" />
            <Kpi
              label="Retención"
              value={formatRate(r.retention.rate)}
              hint={`${formatInt(r.retention.retained)} de ${formatInt(r.retention.previousServed)} del período anterior volvieron`}
            />
            <Kpi label="Altas" value={formatInt(r.registered)} hint={`${capitalize(t.clients)} nuevos en la base`} />
          </div>
          {r.served === 0 ? (
            <EmptyState icon="users" title={`Sin ${t.clients} atendidos`} help={`Cuando completes ${t.appointments} en estas fechas, vas a ver acá a los nuevos y a los que vuelven.`} />
          ) : (
            <Section id="rp-clients-day" title="Nuevos y recurrentes por día">
              <DayBarChart
                data={r.byDay.map((d) => ({ date: d.date, values: [d.newClients, d.returningClients] }))}
                series={[
                  { name: "Nuevos", tone: "main" },
                  { name: "Recurrentes", tone: "context" },
                ]}
                label={`${capitalize(t.clients)} nuevos y recurrentes por día, ${rangeLabel(r.range.from, r.range.to)}: ${r.newClients} nuevos y ${r.returningClients} recurrentes`}
                format={formatInt}
              />
            </Section>
          )}
          {/* Cartera por estado del CRM, hoy: los mismos números que los chips de Clientes (adonde lleva cada uno). */}
          <Section id="rp-clients-status" title={`${capitalize(t.clients)} por estado hoy`} aside={<span className="muted tnum">{formatInt(r.byStatus.total)}</span>}>
            <ul className="rp-status" aria-label={`${capitalize(t.clients)} por estado`}>
              {CLIENT_STATUSES.map((status) => (
                <li key={status}>
                  <Link className="rp-status-row" to={`/clients?status=${status}`}>
                    <StatusBadge status={status} />
                    <span className="tnum rp-status-count">{formatInt(r.byStatus[status])}</span>
                  </Link>
                </li>
              ))}
            </ul>
            <p className="muted ho-note">Con las reglas de {t.clients} del negocio, al día de hoy (no depende de las fechas elegidas).</p>
          </Section>
        </>
      )}
    />
  );
}

// ── Canales ─────────────────────────────────────────────────────────────────

export function ChannelsReportView() {
  const me = useSession();
  const t = terminologyOf(me);
  const currency = me.business.currency;
  const money = (cents: number) => formatCents(cents, currency);
  return (
    <ReportFrame
      id="channels"
      what="el reporte de canales"
      render={(r) => (
        <>
          <Section id="rp-channels" title={`${capitalize(t.appointments)} por canal`}>
            <RankingChart
              items={r.items.map((i) => ({ key: i.channel, label: i.label, value: i.appointments, display: formatInt(i.appointments) }))}
              label={`${capitalize(t.appointments)} por canal: ${r.items.map((i) => `${i.label} ${i.appointments}`).join(", ")}`}
              labelHeader="Canal"
              valueHeader={capitalize(t.appointments)}
            />
          </Section>
          <div className="card sales-table-card">
            <table className="sales-table" aria-label="Canales del período">
              <thead>
                <tr>
                  <th scope="col">Canal</th>
                  <th scope="col" className="sales-col-num">
                    {capitalize(t.appointments)}
                  </th>
                  <th scope="col" className="sales-col-num">
                    Completadas
                  </th>
                  <th scope="col" className="sales-col-num">
                    Canceladas
                  </th>
                  <th scope="col" className="sales-col-num">
                    No asistió
                  </th>
                  <th scope="col" className="sales-col-num">
                    Cobrado neto
                  </th>
                </tr>
              </thead>
              <tbody>
                {r.items.map((i) => (
                  <tr key={i.channel}>
                    <th scope="row">{i.label}</th>
                    <td className="sales-col-num tnum">{formatInt(i.appointments)}</td>
                    <td className="sales-col-num tnum">{formatInt(i.completed)}</td>
                    <td className="sales-col-num tnum">{formatInt(i.cancelled)}</td>
                    <td className="sales-col-num tnum">{formatInt(i.noShow)}</td>
                    <td className="sales-col-num tnum sales-strong">{money(i.collectedNetCents)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <th scope="row">Total</th>
                  <td className="sales-col-num tnum">{formatInt(r.totals.appointments)}</td>
                  <td className="sales-col-num tnum">{formatInt(r.totals.completed)}</td>
                  <td className="sales-col-num tnum">{formatInt(r.totals.cancelled)}</td>
                  <td className="sales-col-num tnum">{formatInt(r.totals.noShow)}</td>
                  <td className="sales-col-num tnum">{money(r.totals.collectedNetCents)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
          {r.looseCollectedNetCents !== 0 && <p className="muted">Además, {money(r.looseCollectedNetCents)} en cobros sin cita (no tienen canal).</p>}
        </>
      )}
    />
  );
}
