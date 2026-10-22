import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { capitalize, terminologyOf } from "../../app/navigation";
import { useSession } from "../../app/session";
import { errorMessage } from "../../lib/api";
import { formatCents } from "../../lib/money";
import EmptyState from "../../ui/EmptyState";
import ErrorState from "../../ui/ErrorState";
import { TextField } from "../../ui/Field";
import type { Appointment } from "../scheduling/schedulingApi";
import { formatWhen, todayIn } from "../scheduling/format";
import ChargeDialog from "./ChargeDialog";
import { shiftDate } from "./format";
import { Kpi } from "./PaymentsPage";
import { salesApi, salesKeys } from "./salesApi";

// Ventas › Pendientes: citas COMPLETADAS con saldo (lo que falta cobrar), de la más nueva a
// la más vieja, con "Cobrar" (el mismo diálogo que la Agenda).

export default function PendingPage() {
  const me = useSession();
  const t = terminologyOf(me);
  const currency = me.business.currency;
  const today = todayIn(me.business.timezone);
  const [from, setFrom] = useState(shiftDate(today, -89));
  const [to, setTo] = useState(today);
  const [charging, setCharging] = useState<Appointment | null>(null);
  const validRange = Boolean(from && to && from <= to);
  const query = useQuery({
    queryKey: salesKeys.pending(from, to),
    queryFn: () => salesApi.pending(from, to),
    enabled: validRange,
    placeholderData: (previous) => previous,
  });
  const items = query.data?.items ?? [];

  return (
    <div className="stack">
      <div className="sales-toolbar">
        <TextField label="Desde" type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} />
        <TextField label="Hasta" type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} />
      </div>
      {query.data && (
        <div className="sales-kpis" aria-label="Total pendiente">
          <Kpi label="Pendiente de cobro" value={formatCents(query.data.balanceCents, currency)} strong />
          <Kpi label={capitalize(t.appointments)} value={String(query.data.count)} />
        </div>
      )}
      {query.isPending && validRange ? (
        <div className="clients-loading" role="status">
          <div className="spinner" aria-hidden="true" />
          <span>Cargando lo pendiente…</span>
        </div>
      ) : query.isError ? (
        <ErrorState message={errorMessage(query.error, "No pudimos cargar lo pendiente.")} onRetry={() => void query.refetch()} />
      ) : items.length === 0 ? (
        <EmptyState icon="check" title="Nada pendiente" help={`Todas las ${t.appointments} completadas de esas fechas están pagadas.`} />
      ) : (
        <ul className="sales-pending" aria-label="Pendientes de cobro">
          {items.map(({ appointment: a, paidCents, balanceCents }) => (
            <li key={a.id} className="card sales-pending-item">
              <div className="sales-pending-main">
                <p className="sales-pending-title">
                  {a.client ? (
                    <Link className="link" to={`/clients/${a.client.id}`}>
                      {a.client.name}
                    </Link>
                  ) : (
                    capitalize(t.client)
                  )}
                </p>
                <p className="muted">
                  {formatWhen(a.startsAt, a.location?.timezone ?? me.business.timezone)} · {a.services.map((l) => l.name).join(" + ")}
                  {a.staff ? ` · ${a.staff.name}` : ""}
                  {me.locations.length > 1 && a.location ? ` · ${a.location.name}` : ""}
                </p>
              </div>
              <dl className="sales-pending-amounts">
                <div>
                  <dt>Total</dt>
                  <dd className="tnum">{formatCents(a.totalCents, currency)}</dd>
                </div>
                <div>
                  <dt>Cobrado</dt>
                  <dd className="tnum">{formatCents(paidCents, currency)}</dd>
                </div>
                <div className="sales-balance-due">
                  <dt>Saldo</dt>
                  <dd className="tnum">{formatCents(balanceCents, currency)}</dd>
                </div>
              </dl>
              <button type="button" className="btn btn-primary" onClick={() => setCharging(a)}>
                Cobrar<span className="visually-hidden"> a {a.client?.name}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {charging && <ChargeDialog appointment={charging} open onClose={() => setCharging(null)} />}
    </div>
  );
}
