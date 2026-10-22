import { useState } from "react";
import { useSession } from "../../app/session";
import { errorMessage } from "../../lib/api";
import { formatCents } from "../../lib/money";
import type { Appointment } from "../scheduling/schedulingApi";
import ChargeDialog, { isChargeable } from "./ChargeDialog";
import { useAppointmentBalance } from "./salesApi";
import "./sales.css";

/**
 * Saldo de una cita en su panel de la Agenda (plan con Ventas): cobrado y saldo, y el botón
 * "Cobrar" (dueño, admin y recepción; no en citas canceladas o no-show). El profesional ve
 * el saldo de sus citas pero no cobra.
 */
export default function AppointmentBalance({ appointment }: { appointment: Appointment }) {
  const me = useSession();
  const currency = me.business.currency;
  const balance = useAppointmentBalance(appointment.id);
  const [charging, setCharging] = useState(false);
  const canCharge = me.role !== "staff" && isChargeable(appointment.status);

  return (
    <section className="appt-balance" aria-label="Cobro de la cita">
      <p className="field-label">Cobro</p>
      {balance.isPending ? (
        <p className="muted">Cargando el saldo…</p>
      ) : balance.isError ? (
        <p className="field-error">{errorMessage(balance.error, "No pudimos cargar el saldo.")}</p>
      ) : (
        <dl className="sales-balance">
          <div>
            <dt>Cobrado</dt>
            <dd className="tnum">{formatCents(balance.data.paidCents, currency)}</dd>
          </div>
          <div>
            <dt>Señas</dt>
            <dd className="tnum">{formatCents(balance.data.depositsCents, currency)}</dd>
          </div>
          <div className={balance.data.balanceCents > 0 ? "sales-balance-due" : "sales-balance-paid"}>
            <dt>Saldo</dt>
            <dd className="tnum">{formatCents(balance.data.balanceCents, currency)}</dd>
          </div>
        </dl>
      )}
      {canCharge && balance.data && balance.data.balanceCents > 0 && (
        <button type="button" className="btn btn-primary" onClick={() => setCharging(true)}>
          Cobrar
        </button>
      )}
      <ChargeDialog appointment={appointment} open={charging} onClose={() => setCharging(false)} />
    </section>
  );
}
