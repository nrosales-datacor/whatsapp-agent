import { useLayoutEffect } from "react";
import { documentTitle } from "../lib/branding";
import PausedBillingActions from "../modules/billing/PausedBillingActions";
import Icon from "../ui/Icons";
import { useLogout } from "./session";

/**
 * "Cuenta pausada": el superadmin pausó el negocio (cobro manual) y la API responde 403
 * `business_paused`. Los datos siguen intactos; al reactivarlo, el panel vuelve a la
 * normalidad sin hacer nada. Desde acá solo se puede salir (o reintentar).
 */
export default function AccountPausedPage({ onRetry }: { onRetry: () => void }) {
  const logout = useLogout();

  useLayoutEffect(() => {
    document.title = documentTitle("Cuenta pausada");
  }, []);

  return (
    <main className="full-page-status account-paused" role="alert">
      <div className="empty-state-icon">
        <Icon id="lock" size={26} strokeWidth={1.6} />
      </div>
      <h1 className="empty-state-title">Cuenta pausada</h1>
      <p className="empty-state-help">
        La cuenta de este negocio está pausada por el momento. Tus datos, tu agenda y tus clientes siguen guardados: en cuanto
        se reactive, todo vuelve a funcionar como antes. Escribinos para reactivarla.
      </p>
      <PausedBillingActions />
      <div className="account-paused-actions">
        <button type="button" className="btn btn-secondary" onClick={onRetry}>
          <Icon id="refresh" size={16} />
          Ya la reactivaron
        </button>
        <button type="button" className="btn btn-secondary" onClick={() => logout.mutate()} disabled={logout.isPending}>
          <Icon id="logout" size={16} />
          Cerrar sesión
        </button>
      </div>
    </main>
  );
}
