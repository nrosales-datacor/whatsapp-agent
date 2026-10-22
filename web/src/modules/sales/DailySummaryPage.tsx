import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ALL_LOCATIONS, useActiveLocation } from "../../app/location";
import { capitalize, terminologyOf } from "../../app/navigation";
import { useSession } from "../../app/session";
import { errorMessage } from "../../lib/api";
import { formatCents } from "../../lib/money";
import ErrorState from "../../ui/ErrorState";
import { TextField } from "../../ui/Field";
import Icon from "../../ui/Icons";
import { formatLongDate, formatTime, todayIn } from "../scheduling/format";
import { KIND_LABEL } from "./format";
import { Kpi } from "./PaymentsPage";
import { salesApi, salesKeys } from "./salesApi";

// Ventas › Resumen del día (la caja, sin apertura ni cierre): por método de pago, cobros,
// señas, devoluciones y neto, con los movimientos del día. "Imprimir" deja solo el resumen
// en la hoja (estilos @media print de ./sales.css).

export default function DailySummaryPage() {
  const me = useSession();
  const t = terminologyOf(me);
  const currency = me.business.currency;
  const { selected, label } = useActiveLocation();
  const [date, setDate] = useState(todayIn(me.business.timezone));
  const summary = useQuery({ queryKey: salesKeys.summary(date), queryFn: () => salesApi.summary(date), enabled: Boolean(date) });
  const movements = useQuery({
    queryKey: salesKeys.payments({ from: date, to: date }),
    queryFn: () => salesApi.listPayments({ from: date, to: date }),
    enabled: Boolean(date),
  });
  const data = summary.data;

  return (
    <div className="stack sales-print-area">
      <div className="sales-toolbar no-print">
        <TextField label="Día" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        <div className="sales-toolbar-actions">
          <button type="button" className="btn btn-secondary" onClick={() => window.print()} disabled={!data}>
            <Icon id="receipt" size={16} />
            Imprimir
          </button>
        </div>
      </div>

      <header className="sales-print-header">
        <p className="sales-print-business">{me.business.name}</p>
        <h2 className="page-subtitle-heading">Resumen del {date ? formatLongDate(date) : "día"}</h2>
        <p className="muted">{selected === ALL_LOCATIONS ? label : `${capitalize(t.location)}: ${label}`}</p>
      </header>

      {summary.isPending ? (
        <div className="clients-loading" role="status">
          <div className="spinner" aria-hidden="true" />
          <span>Cargando el resumen…</span>
        </div>
      ) : summary.isError || !data ? (
        <ErrorState message={errorMessage(summary.error, "No pudimos cargar el resumen del día.")} onRetry={() => void summary.refetch()} />
      ) : (
        <>
          <div className="sales-kpis" aria-label="Totales del día">
            <Kpi label="Cobrado" value={formatCents(data.totals.collectedCents, currency)} hint={`${data.totals.count} movimientos`} />
            <Kpi label="Señas" value={formatCents(data.totals.depositsCents, currency)} />
            <Kpi label="Devoluciones" value={formatCents(data.totals.refundsCents, currency)} />
            <Kpi label="Neto en caja" value={formatCents(data.totals.netCents, currency)} strong />
          </div>
          <div className="card sales-table-card">
            <table className="sales-table sales-summary-table" aria-label="Resumen por método de pago">
              <thead>
                <tr>
                  <th scope="col">Método</th>
                  <th scope="col" className="sales-col-num">
                    Cobros
                  </th>
                  <th scope="col" className="sales-col-num">
                    Señas
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
                {data.byMethod.map((m) => (
                  <tr key={m.methodId}>
                    <th scope="row">
                      {m.name}
                      {!m.active && <span className="badge badge-muted"> inactivo</span>}
                      <span className="sales-row-note">{m.count === 1 ? "1 movimiento" : `${m.count} movimientos`}</span>
                    </th>
                    <td className="sales-col-num tnum">{formatCents(m.paymentsCents, currency)}</td>
                    <td className="sales-col-num tnum">{formatCents(m.depositsCents, currency)}</td>
                    <td className="sales-col-num tnum">{m.refundsCents ? `−${formatCents(m.refundsCents, currency)}` : formatCents(0, currency)}</td>
                    <td className="sales-col-num tnum sales-strong">{formatCents(m.netCents, currency)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <th scope="row">Total</th>
                  <td className="sales-col-num tnum">{formatCents(data.totals.paymentsCents, currency)}</td>
                  <td className="sales-col-num tnum">{formatCents(data.totals.depositsCents, currency)}</td>
                  <td className="sales-col-num tnum">{data.totals.refundsCents ? `−${formatCents(data.totals.refundsCents, currency)}` : formatCents(0, currency)}</td>
                  <td className="sales-col-num tnum sales-strong">{formatCents(data.totals.netCents, currency)}</td>
                </tr>
              </tfoot>
            </table>
          </div>

          <section className="card" aria-labelledby="day-movements">
            <h3 id="day-movements" className="card-title">
              Movimientos del día
            </h3>
            {movements.isPending ? (
              <p className="muted">Cargando…</p>
            ) : movements.isError ? (
              <p className="field-error">{errorMessage(movements.error)}</p>
            ) : movements.data.items.length === 0 ? (
              <p className="muted">Sin movimientos este día.</p>
            ) : (
              <ul className="sales-day-list">
                {movements.data.items.map((p) => (
                  <li key={p.id}>
                    <span className="tnum">{formatTime(p.paidAt, me.business.timezone)}</span>
                    <span>
                      {KIND_LABEL[p.kind]} · {p.client?.name ?? "—"} · {p.method?.name ?? "—"}
                    </span>
                    <span className="tnum sales-strong">{p.kind === "refund" ? `−${formatCents(p.amountCents, currency)}` : formatCents(p.amountCents, currency)}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </div>
  );
}
