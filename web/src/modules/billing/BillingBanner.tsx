import { useMutation } from "@tanstack/react-query";
import { Link, useLocation } from "react-router-dom";
import { useSession } from "../../app/session";
import { errorMessage } from "../../lib/api";
import Icon from "../../ui/Icons";
import { useToast } from "../../ui/Toast";
import { formatBillingDate, goToStripe, openPortal, trialLeftText } from "./billingApi";
import "./billing.css";

// ─────────────────────────────────────────────────────────────────────────────
// Aviso del cobro arriba del panel (solo el dueño, que es quien puede pagar): días de
// prueba que quedan, pago atrasado (con la fecha en que se pausa la cuenta) o suscripción
// que termina al final del período. Sale de `me.plan.billing`; en Configuración › Plan no
// se repite (ahí está la tarjeta de la suscripción).
// ─────────────────────────────────────────────────────────────────────────────

export default function BillingBanner() {
  const me = useSession();
  const location = useLocation();
  const { showToast } = useToast();
  const portal = useMutation({ mutationFn: openPortal, onSuccess: ({ url }) => goToStripe(url), onError: (e) => showToast(errorMessage(e)) });
  const billing = me.plan.billing;
  if (me.role !== "owner" || !billing || location.pathname === "/settings/plan") return null;

  if (me.plan.billingStatus === "past_due") {
    return (
      <div className="billing-banner billing-banner-warning" role="alert">
        <Icon id="alert" size={18} />
        <p>
          {billing.pauseAt
            ? `No pudimos cobrar tu suscripción. Actualizá tu medio de pago antes del ${formatBillingDate(billing.pauseAt)} para que la cuenta no se pause.`
            : "No pudimos cobrar tu suscripción. Actualizá tu medio de pago para que la cuenta no se pause."}
        </p>
        {billing.canManage && billing.onlinePayments ? (
          <button type="button" className="btn btn-small btn-primary" onClick={() => portal.mutate()} disabled={portal.isPending || portal.isSuccess}>
            {portal.isPending || portal.isSuccess ? "Abriendo Stripe…" : "Gestionar pago"}
          </button>
        ) : (
          <Link className="btn btn-small btn-secondary" to="/settings/plan">
            Ver mi plan
          </Link>
        )}
      </div>
    );
  }

  if (me.plan.billingStatus === "trial" && billing.trialEndsAt && !billing.hasSubscription) {
    return (
      <div className="billing-banner" role="status">
        <Icon id="sparkles" size={18} />
        <p>
          {trialLeftText(billing.trialEndsAt)}.{" "}
          {billing.onlinePayments ? "Suscribite cuando quieras: no te cobramos hasta que termine." : "Escribinos para contratar tu plan."}
        </p>
        {billing.onlinePayments && (
          <Link className="btn btn-small btn-primary" to="/settings/plan">
            Suscribirme
          </Link>
        )}
      </div>
    );
  }

  if (billing.cancelAtPeriodEnd && billing.currentPeriodEnd) {
    return (
      <div className="billing-banner" role="status">
        <Icon id="clock" size={18} />
        <p>Tu suscripción termina el {formatBillingDate(billing.currentPeriodEnd)}. Después, la cuenta se pausa.</p>
        <Link className="btn btn-small btn-secondary" to="/settings/plan">
          Ver mi plan
        </Link>
      </div>
    );
  }
  return null;
}
