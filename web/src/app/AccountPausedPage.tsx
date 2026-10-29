import { useEffect, useLayoutEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import { documentTitle } from "../lib/branding";
import type { BillingStatusView } from "../lib/contract";
import { BILLING_STATUS_QUERY_KEY, getBillingStatus } from "../modules/settings/billingApi";
import OnlineBilling from "../modules/settings/OnlineBilling";
import Icon from "../ui/Icons";
import { useLogout } from "./session";

/** Por qué se pausó por falta de pago, en una línea. */
function unpaidReason(status: BillingStatusView): string {
  if (status.billingStatus === "cancelled") return "Tu suscripción terminó.";
  if (status.trialEndsAt) return "Terminó tu prueba gratis.";
  return "No pudimos cobrar tu suscripción.";
}

/**
 * "Cuenta pausada": la API responde 403 `business_paused`. Los datos siguen intactos; al
 * reactivarlo, el panel vuelve a la normalidad sin hacer nada.
 *
 *   • Pausa del superadmin (cobro manual): desde acá solo se puede salir o reintentar.
 *   • Pausa por falta de pago (la gracia venció) y quien mira es la dueña: `/billing/status`
 *     sigue andando y acá mismo puede pagar; al pagar, se reactiva sola. A la vuelta del
 *     Checkout (`?billing=ok`) se espera al webhook y se entra sola al panel.
 */
export default function AccountPausedPage({ onRetry }: { onRetry: () => void }) {
  const logout = useLogout();
  const [params] = useSearchParams();
  const returned = params.get("billing") === "ok";
  // Solo la dueña lo ve (los demás reciben 403 y queda el aviso general).
  const billing = useQuery({
    queryKey: BILLING_STATUS_QUERY_KEY,
    queryFn: getBillingStatus,
    retry: false,
    staleTime: 0,
    refetchInterval: returned ? 4_000 : false,
  });
  const unpaid = billing.data?.pausedForBilling ? billing.data : null;
  const reactivated = returned && billing.data !== undefined && !billing.data.pausedForBilling;

  useLayoutEffect(() => {
    document.title = documentTitle("Cuenta pausada");
  }, []);

  // Volvió de pagar y el webhook ya la reactivó: a la sesión.
  useEffect(() => {
    if (reactivated) onRetry();
  }, [reactivated, onRetry]);

  return (
    <main className="full-page-status account-paused" role="alert">
      <div className="empty-state-icon">
        <Icon id="lock" size={26} strokeWidth={1.6} />
      </div>
      <h1 className="empty-state-title">Cuenta pausada</h1>
      {unpaid ? (
        <p className="empty-state-help">
          {unpaidReason(unpaid)} Tus datos, tu agenda y tus clientes siguen guardados: en cuanto pagues, la cuenta se reactiva
          sola.
        </p>
      ) : (
        <p className="empty-state-help">
          La cuenta de este negocio está pausada por el momento. Tus datos, tu agenda y tus clientes siguen guardados: en cuanto
          se reactive, todo vuelve a funcionar como antes. Escribinos para reactivarla.
        </p>
      )}
      {unpaid && returned && (
        <p className="empty-state-help" role="status">
          Recibimos tu pago. La cuenta se reactiva en unos segundos.
        </p>
      )}
      {unpaid && !returned && (
        <div className="account-paused-billing">
          <OnlineBilling status={unpaid} title="Reactivá tu cuenta" />
        </div>
      )}
      <div className="account-paused-actions">
        <button type="button" className="btn btn-secondary" onClick={onRetry}>
          <Icon id="refresh" size={16} />
          {unpaid ? "Ya pagué" : "Ya la reactivaron"}
        </button>
        <button type="button" className="btn btn-secondary" onClick={() => logout.mutate()} disabled={logout.isPending}>
          <Icon id="logout" size={16} />
          Cerrar sesión
        </button>
      </div>
    </main>
  );
}
