import { Link } from "react-router-dom";
import { trialDaysLeft, trialEndsText } from "../../lib/plans";
import Icon from "../../ui/Icons";
import { useSession } from "../session";

// ─────────────────────────────────────────────────────────────────────────────
// Aviso del cobro arriba del contenido (I6.6–I6.7), para el dueño y la administración:
//
//   • Pago pendiente (la prueba gratis venció sin suscripción, o Stripe no pudo cobrar).
//   • Prueba gratis que termina en 7 días o menos.
//
// El dueño tiene el enlace a Configuración › Plan; la administración, el aviso de que lo
// resuelve el dueño (Plan es solo del dueño). Recepción y profesionales no lo ven.
// ─────────────────────────────────────────────────────────────────────────────

/** Desde cuántos días antes del fin de la prueba se avisa. */
const TRIAL_NOTICE_DAYS = 7;

export default function BillingBanner() {
  const me = useSession();
  if (me.role !== "owner" && me.role !== "admin") return null;
  const { billingStatus, trialEndsAt } = me.plan;
  const owner = me.role === "owner";

  let message: string | null = null;
  if (billingStatus === "past_due") {
    message = trialEndsAt ? "Tu prueba gratis terminó y falta elegir un plan." : "Hay un pago pendiente de tu plan.";
  } else if (billingStatus === "trial") {
    const days = trialDaysLeft(trialEndsAt);
    if (days !== null && days <= TRIAL_NOTICE_DAYS) message = `${trialEndsText(days)}.`;
  }
  if (!message) return null;

  return (
    <div className={"billing-banner" + (billingStatus === "past_due" ? " billing-banner-warning" : "")} role="status">
      <Icon id="alert" size={16} />
      <span className="billing-banner-text">
        {message} {owner ? null : "Pedile al dueño del negocio que lo resuelva en Configuración › Plan."}
      </span>
      {owner && (
        <Link to="/settings/plan" className="billing-banner-link">
          {billingStatus === "past_due" ? "Elegir mi plan" : "Ver mi plan"}
        </Link>
      )}
    </div>
  );
}
