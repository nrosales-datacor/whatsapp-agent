import { useEffect, useState, type FormEvent } from "react";
import { capitalize, terminologyOf } from "../../app/navigation";
import { useSession } from "../../app/session";
import { errorMessage, isApiError } from "../../lib/api";
import { centsToInput, currencySymbol, formatCents, parseAmountToCents } from "../../lib/money";
import Dialog from "../../ui/Dialog";
import { FormError, SelectField, TextField } from "../../ui/Field";
import { useToast } from "../../ui/Toast";
import type { Appointment } from "../scheduling/schedulingApi";
import { registeredLabel } from "./format";
import { useAppointmentBalance, useChargeAppointment, usePaymentMethods, type ChargeKind } from "./salesApi";

interface Props {
  appointment: Appointment;
  open: boolean;
  onClose: () => void;
}

/** ¿Se puede cobrar esta cita? (las canceladas y no-show no se cobran). */
export function isChargeable(status: Appointment["status"]): boolean {
  return status === "pending" || status === "confirmed" || status === "completed";
}

/**
 * "Cobrar" una cita: seña (antes de la cita) o pago, monto (de entrada, el saldo), método y
 * nota. Muestra total, cobrado y saldo; el backend frena cobrar más que el saldo.
 */
export default function ChargeDialog({ appointment, open, onClose }: Props) {
  const me = useSession();
  const t = terminologyOf(me);
  const currency = me.business.currency;
  const { showToast } = useToast();
  const balance = useAppointmentBalance(open ? appointment.id : null);
  const methods = usePaymentMethods(open);
  const mutation = useChargeAppointment(appointment.id);
  const depositAllowed = appointment.status === "pending" || appointment.status === "confirmed";

  const [kind, setKind] = useState<ChargeKind>("payment");
  const [amount, setAmount] = useState("");
  const [methodId, setMethodId] = useState("");
  const [note, setNote] = useState("");
  const [amountError, setAmountError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  const active = (methods.data ?? []).filter((m) => m.active);
  const due = balance.data?.balanceCents ?? null;

  // Al abrir (y cuando llega el saldo), se arranca del saldo y del primer método activo.
  useEffect(() => {
    if (!open) return;
    setKind("payment");
    setNote("");
    setAmountError(null);
    setFormError(null);
    mutation.reset();
  }, [open]);
  useEffect(() => {
    if (open && due !== null) setAmount(due > 0 ? centsToInput(due) : "");
  }, [open, due]);
  useEffect(() => {
    if (open && !active.some((m) => m.id === methodId)) setMethodId(active[0]?.id ?? "");
  }, [open, methods.data]);

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    const cents = parseAmountToCents(amount);
    setAmountError(null);
    setFormError(null);
    if (!cents) return setAmountError("Escribí un monto mayor que cero.");
    if (due !== null && cents > due) return setAmountError(`El monto supera el saldo (${formatCents(due, currency)}).`);
    if (!methodId) return setFormError("Elegí el método de pago.");
    mutation.mutate(
      { kind, amountCents: cents, methodId, note: note.trim() || null },
      {
        onSuccess: ({ payment, balance: next }) => {
          showToast(
            `${registeredLabel(payment.kind)}: ${formatCents(payment.amountCents, currency)} (${payment.method?.name ?? "—"}).` +
              (next.balanceCents > 0 ? ` Saldo: ${formatCents(next.balanceCents, currency)}.` : " Quedó pagada."),
          );
          onClose();
        },
      },
    );
  }

  const apiError = isApiError(mutation.error) ? mutation.error : null;
  const paidUp = due === 0;
  return (
    <Dialog open={open} onClose={onClose} title={`Cobrar ${t.appointment}`}>
      <p className="settings-help">
        {appointment.client?.name ?? capitalize(t.client)} · {appointment.services.map((l) => l.name).join(" + ")}
      </p>
      {balance.isPending ? (
        <p className="muted" role="status">
          Cargando el saldo…
        </p>
      ) : balance.isError ? (
        <p className="field-error" role="alert">
          {errorMessage(balance.error, "No pudimos cargar el saldo.")}
        </p>
      ) : (
        <dl className="sales-balance" aria-label="Saldo de la cita">
          <div>
            <dt>Total</dt>
            <dd className="tnum">{formatCents(balance.data.totalCents, currency)}</dd>
          </div>
          <div>
            <dt>Cobrado</dt>
            <dd className="tnum">{formatCents(balance.data.paidCents, currency)}</dd>
          </div>
          <div className={balance.data.balanceCents > 0 ? "sales-balance-due" : "sales-balance-paid"}>
            <dt>Saldo</dt>
            <dd className="tnum">{formatCents(balance.data.balanceCents, currency)}</dd>
          </div>
        </dl>
      )}
      {paidUp ? (
        <p className="sales-note">Esta {t.appointment} ya está pagada. Si hay que devolver algo, hacelo desde Ventas › Cobros.</p>
      ) : (
        <form onSubmit={onSubmit} noValidate>
          {depositAllowed && (
            <fieldset className="field sales-kind">
              <legend className="field-label">Tipo</legend>
              <label className="check-row">
                <input type="radio" name="charge-kind" checked={kind === "payment"} onChange={() => setKind("payment")} />
                <span>Pago</span>
              </label>
              <label className="check-row">
                <input type="radio" name="charge-kind" checked={kind === "deposit"} onChange={() => setKind("deposit")} />
                <span>
                  Seña<small>Un adelanto antes de la {t.appointment}.</small>
                </span>
              </label>
            </fieldset>
          )}
          <div className="form-grid">
            <TextField
              label={`Monto (${currencySymbol(currency)})`}
              inputMode="decimal"
              autoComplete="off"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              error={amountError ?? apiError?.fieldError("amountCents")}
            />
            <SelectField
              label="Método de pago"
              value={methodId}
              onChange={(e) => setMethodId(e.target.value)}
              options={active.length ? active.map((m) => ({ value: m.id, label: m.name })) : [{ value: "", label: methods.isPending ? "Cargando…" : "Sin métodos activos" }]}
              error={apiError?.fieldError("methodId")}
            />
          </div>
          <TextField label="Nota (opcional)" value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} />
          <FormError message={formError ?? (mutation.isError && !apiError?.fieldError("amountCents") && !apiError?.fieldError("methodId") ? errorMessage(mutation.error) : null)} />
          <div className="form-actions">
            <button type="button" className="btn btn-secondary" onClick={onClose}>
              Cancelar
            </button>
            <button type="submit" className="btn btn-primary" disabled={mutation.isPending || balance.isPending}>
              {mutation.isPending ? "Registrando…" : kind === "deposit" ? "Registrar seña" : "Registrar pago"}
            </button>
          </div>
        </form>
      )}
    </Dialog>
  );
}
