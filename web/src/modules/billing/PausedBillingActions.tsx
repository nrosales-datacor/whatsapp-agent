import { BillingActions } from "./SubscriptionCard";
import { useBillingStatus } from "./billingApi";
import "./billing.css";

/**
 * En "Cuenta pausada": si la pausa es POR EL COBRO (prueba vencida, pago atrasado o
 * suscripción terminada) y quien mira es la dueña, los botones para pagar; al pagar, la
 * cuenta se reactiva sola. Para los demás (o una pausa del superadmin) no muestra nada:
 * `/billing/status` responde 403 y el aviso general alcanza.
 */
export default function PausedBillingActions() {
  const status = useBillingStatus();
  if (!status.data || !status.data.pausedForBilling) return null;
  const reason =
    status.data.billingStatus === "trial"
      ? "Terminó tu prueba gratis."
      : status.data.billingStatus === "cancelled"
        ? "Tu suscripción terminó."
        : "No pudimos cobrar tu suscripción.";
  return (
    <section className="card billing-paused" aria-labelledby="billing-paused-title">
      <h2 id="billing-paused-title" className="card-title">
        Reactivá tu cuenta
      </h2>
      <p className="settings-help">{reason} En cuanto pagues, la cuenta se reactiva sola.</p>
      <BillingActions status={status.data} />
    </section>
  );
}
