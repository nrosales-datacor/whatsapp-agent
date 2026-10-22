import { useEffect, useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useMutation, useQuery } from "@tanstack/react-query";
import { ALL_LOCATIONS, useActiveLocation } from "../../app/location";
import { capitalize, terminologyOf } from "../../app/navigation";
import { useSession } from "../../app/session";
import { errorMessage, isApiError } from "../../lib/api";
import { centsToInput, currencySymbol, formatCents, parseAmountToCents } from "../../lib/money";
import Dialog from "../../ui/Dialog";
import EmptyState from "../../ui/EmptyState";
import ErrorState from "../../ui/ErrorState";
import { FormError, SelectField, TextField } from "../../ui/Field";
import Icon from "../../ui/Icons";
import { useToast } from "../../ui/Toast";
import { formatWhen, todayIn } from "../scheduling/format";
import { KIND_LABEL, shiftDate } from "./format";
import NewPaymentDialog from "./NewPaymentDialog";
import { salesApi, salesKeys, usePaymentMethods, useSalesInvalidation, type Payment, type PaymentFilters, type PaymentKind } from "./salesApi";

// Ventas › Cobros: movimientos (cobros, señas y devoluciones) con filtros por fecha, método
// y tipo, sus totales, "Nuevo cobro" (suelto, sin cita) y devolver un pago (dueño y admin).

const KIND_OPTIONS: { value: "" | PaymentKind; label: string }[] = [
  { value: "", label: "Todos" },
  { value: "payment", label: "Cobros" },
  { value: "deposit", label: "Señas" },
  { value: "refund", label: "Devoluciones" },
];

export default function PaymentsPage() {
  const me = useSession();
  const t = terminologyOf(me);
  const currency = me.business.currency;
  const { selected } = useActiveLocation();
  const [params, setParams] = useSearchParams();
  const today = todayIn(me.business.timezone);
  const [from, setFrom] = useState(shiftDate(today, -6));
  const [to, setTo] = useState(today);
  const [methodId, setMethodId] = useState("");
  const [kind, setKind] = useState<"" | PaymentKind>("");
  const [refunding, setRefunding] = useState<Payment | null>(null);
  const creating = params.get("new") === "1";
  const canRefund = me.role === "owner" || me.role === "admin";
  const methods = usePaymentMethods();

  const filters: PaymentFilters = { from, to, methodId: methodId || undefined, kind: kind || undefined };
  const validRange = Boolean(from && to && from <= to);
  const query = useQuery({
    queryKey: salesKeys.payments(filters),
    queryFn: () => salesApi.listPayments(filters),
    enabled: validRange,
    placeholderData: (previous) => previous,
  });

  const closeNew = () => {
    const next = new URLSearchParams(params);
    next.delete("new");
    setParams(next, { replace: true });
  };

  const totals = query.data?.totals;
  const items = query.data?.items ?? [];
  const showLocation = selected === ALL_LOCATIONS && me.locations.length > 1;

  return (
    <div className="stack">
      <div className="sales-toolbar">
        <TextField label="Desde" type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} />
        <TextField label="Hasta" type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} />
        <SelectField
          label="Método"
          value={methodId}
          onChange={(e) => setMethodId(e.target.value)}
          options={[{ value: "", label: "Todos" }, ...(methods.data ?? []).map((m) => ({ value: m.id, label: m.active ? m.name : `${m.name} (inactivo)` }))]}
        />
        <SelectField label="Tipo" value={kind} onChange={(e) => setKind(e.target.value as "" | PaymentKind)} options={KIND_OPTIONS} />
        <div className="sales-toolbar-actions">
          <button type="button" className="btn btn-primary" onClick={() => setParams({ new: "1" })}>
            <Icon id="plus" size={16} />
            Nuevo cobro
          </button>
        </div>
      </div>
      {!validRange && <p className="field-error">La fecha «Hasta» tiene que ser igual o posterior a «Desde».</p>}

      {totals && (
        <div className="sales-kpis" aria-label="Totales del período">
          <Kpi label="Cobrado" value={formatCents(totals.collectedCents, currency)} hint={`${totals.count} movimientos`} />
          <Kpi label="Señas" value={formatCents(totals.depositsCents, currency)} />
          <Kpi label="Devoluciones" value={formatCents(totals.refundsCents, currency)} />
          <Kpi label="Neto" value={formatCents(totals.netCents, currency)} strong />
        </div>
      )}

      {query.isPending && validRange ? (
        <div className="clients-loading" role="status">
          <div className="spinner" aria-hidden="true" />
          <span>Cargando los cobros…</span>
        </div>
      ) : query.isError ? (
        <ErrorState message={errorMessage(query.error, "No pudimos cargar los cobros.")} onRetry={() => void query.refetch()} />
      ) : items.length === 0 ? (
        <EmptyState icon="receipt" title="Sin movimientos" help={`No hay cobros, señas ni devoluciones en esas fechas${showLocation ? "" : ` en esta ${t.location}`}.`} />
      ) : (
        <div className="card sales-table-card">
          <table className="sales-table" aria-label="Movimientos">
            <thead>
              <tr>
                <th scope="col">Fecha</th>
                <th scope="col">{capitalize(t.client)}</th>
                <th scope="col">Tipo</th>
                <th scope="col">Método</th>
                {showLocation && <th scope="col">{capitalize(t.location)}</th>}
                <th scope="col" className="sales-col-num">
                  Monto
                </th>
                {canRefund && (
                  <th scope="col">
                    <span className="visually-hidden">Acciones</span>
                  </th>
                )}
              </tr>
            </thead>
            <tbody>
              {items.map((p) => {
                const refundable = p.kind !== "refund" ? p.amountCents - p.refundedCents : 0;
                return (
                  <tr key={p.id} className={p.kind === "refund" ? "sales-row-refund" : undefined}>
                    <td className="sales-nowrap">{formatWhen(p.paidAt, me.business.timezone)}</td>
                    <td>
                      {p.client ? (
                        <Link className="link" to={`/clients/${p.client.id}`}>
                          {p.client.name}
                        </Link>
                      ) : (
                        "—"
                      )}
                      {p.note && <span className="sales-row-note">{p.note}</span>}
                    </td>
                    <td>
                      <span className={`sales-kind-badge kind-${p.kind}`}>{KIND_LABEL[p.kind]}</span>
                      {p.refundedCents > 0 && <span className="sales-row-note">Devuelto {formatCents(p.refundedCents, currency)}</span>}
                      {!p.appointmentId && p.kind !== "refund" && <span className="sales-row-note">Sin {t.appointment}</span>}
                    </td>
                    <td>{p.method?.name ?? "—"}</td>
                    {showLocation && <td>{p.location?.name ?? "—"}</td>}
                    <td className="sales-col-num tnum">{p.kind === "refund" ? `−${formatCents(p.amountCents, currency)}` : formatCents(p.amountCents, currency)}</td>
                    {canRefund && (
                      <td className="sales-col-action">
                        {refundable > 0 && (
                          <button type="button" className="btn btn-secondary btn-small" onClick={() => setRefunding(p)}>
                            Devolver<span className="visually-hidden"> el {KIND_LABEL[p.kind].toLowerCase()} de {p.client?.name}</span>
                          </button>
                        )}
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
          {query.data?.truncated && <p className="muted sales-truncated">Se muestran los movimientos más recientes: acotá las fechas para ver el resto.</p>}
        </div>
      )}

      <NewPaymentDialog open={creating} onClose={closeNew} />
      {refunding && <RefundDialog payment={refunding} onClose={() => setRefunding(null)} />}
    </div>
  );
}

export function Kpi({ label, value, hint, strong }: { label: string; value: string; hint?: string; strong?: boolean }) {
  return (
    <div className={"card sales-kpi" + (strong ? " sales-kpi-strong" : "")}>
      <span className="sales-kpi-label">{label}</span>
      <span className="sales-kpi-value tnum">{value}</span>
      {hint && <span className="muted">{hint}</span>}
    </div>
  );
}

/** Devolver (parte o todo) un cobro o una seña, con motivo. */
function RefundDialog({ payment, onClose }: { payment: Payment; onClose: () => void }) {
  const me = useSession();
  const currency = me.business.currency;
  const { showToast } = useToast();
  const invalidate = useSalesInvalidation();
  const methods = usePaymentMethods();
  const remaining = payment.amountCents - payment.refundedCents;
  const [amount, setAmount] = useState(centsToInput(remaining));
  const [reason, setReason] = useState("");
  const [methodId, setMethodId] = useState(payment.method?.id ?? "");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const mutation = useMutation({
    mutationFn: (input: { amountCents: number; reason: string; methodId?: string }) => salesApi.refund(payment.id, input),
    onSuccess: ({ refund }) => {
      invalidate();
      showToast(`Devolución registrada: ${formatCents(refund.amountCents, currency)} a ${refund.client?.name ?? "la persona"}.`);
      onClose();
    },
  });
  useEffect(() => mutation.reset(), [payment.id]);

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    const cents = parseAmountToCents(amount);
    const next: Record<string, string> = {};
    if (!cents) next.amount = "Escribí un monto mayor que cero.";
    else if (cents > remaining) next.amount = `Se puede devolver hasta ${formatCents(remaining, currency)}.`;
    if (!reason.trim()) next.reason = "Contanos el motivo (queda en el historial).";
    setErrors(next);
    if (Object.keys(next).length > 0 || !cents) return;
    mutation.mutate({ amountCents: cents, reason: reason.trim(), methodId: methodId || undefined });
  }

  const apiError = isApiError(mutation.error) ? mutation.error : null;
  return (
    <Dialog open onClose={onClose} title="Devolver un pago">
      <form onSubmit={onSubmit} noValidate>
        <p className="settings-help">
          {KIND_LABEL[payment.kind]} de {payment.client?.name ?? "—"} por {formatCents(payment.amountCents, currency)} ({payment.method?.name ?? "—"}, {formatWhen(payment.paidAt, me.business.timezone)}).
          {payment.refundedCents > 0 && ` Ya se devolvieron ${formatCents(payment.refundedCents, currency)}.`}
        </p>
        <div className="form-grid">
          <TextField
            label={`Monto a devolver (${currencySymbol(currency)})`}
            inputMode="decimal"
            autoComplete="off"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            error={errors.amount ?? apiError?.fieldError("amountCents")}
          />
          <SelectField
            label="Se devuelve por"
            value={methodId}
            onChange={(e) => setMethodId(e.target.value)}
            options={(methods.data ?? []).filter((m) => m.active || m.id === payment.method?.id).map((m) => ({ value: m.id, label: m.name }))}
          />
        </div>
        <TextField label="Motivo" value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} error={errors.reason ?? apiError?.fieldError("reason")} />
        <FormError message={mutation.isError && !apiError?.fieldError("amountCents") && !apiError?.fieldError("reason") ? errorMessage(mutation.error) : null} />
        <div className="form-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Cancelar
          </button>
          <button type="submit" className="btn btn-danger" disabled={mutation.isPending}>
            {mutation.isPending ? "Registrando…" : "Registrar devolución"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
