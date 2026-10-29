import { useId } from "react";
import { useMutation } from "@tanstack/react-query";
import { errorMessage } from "../../lib/api";
import type { BillingOption, BillingStatusView } from "../../lib/contract";
import { FormError } from "../../ui/Field";
import { openBillingPortal, startCheckout } from "./billingApi";
import "./settings.css";

// Pago en línea con Stripe (I6.6): Checkout para suscribirse y Portal para administrar el
// pago. Tras el éxito el navegador se va a Stripe y vuelve a Configuración › Plan.

/** Lo que trae cada opción que se vende en línea (una línea, junto al botón). */
const OPTION_PITCH: Record<BillingOption, string> = {
  basic: "El agente de WhatsApp con la agenda y la ficha de clientes.",
  pro: "La gestión completa con el agente de WhatsApp.",
  pro_no_agent: "La gestión completa, sin el agente de WhatsApp.",
};

/**
 * Suscripción en línea (Stripe): suscribirse a una opción o administrar el pago. La usan
 * Configuración › Plan y "Cuenta pausada" cuando la pausa es por falta de pago (con su
 * título y su explicación).
 */
export default function OnlineBilling({ status, title = "Pago", intro }: { status: BillingStatusView; title?: string; intro?: string }) {
  const headingId = useId();
  const checkout = useMutation({
    mutationFn: (option: BillingOption) => startCheckout(option),
    onSuccess: ({ url }) => window.location.assign(url),
  });
  const portal = useMutation({
    mutationFn: () => openBillingPortal(),
    onSuccess: ({ url }) => window.location.assign(url),
  });
  // Tras el éxito el navegador se va a Stripe: los botones quedan apagados hasta entonces.
  const pending = checkout.isPending || portal.isPending || checkout.isSuccess || portal.isSuccess;
  const error = checkout.isError ? errorMessage(checkout.error) : portal.isError ? errorMessage(portal.error) : null;

  return (
    <section className="card" aria-labelledby={headingId}>
      <h3 id={headingId} className="card-title">
        {title}
      </h3>
      <p className="settings-help">
        {intro ? `${intro} ` : null}
        {status.subscribed
          ? "Tu suscripción se paga con tarjeta. Cambiá de plan, actualizá la tarjeta o descargá tus facturas desde el portal de pagos."
          : "Elegí tu plan y pagalo con tarjeta. Podés cambiarlo o cancelarlo cuando quieras."}
      </p>
      {!status.subscribed && status.options.length > 0 && (
        <ul className="plan-options">
          {status.options.map((o) => (
            <li key={o.id} className="plan-option">
              <div className="plan-option-text">
                <span className="plan-option-name">{o.label}</span>
                <span className="plan-option-pitch">{OPTION_PITCH[o.id]}</span>
              </div>
              <button type="button" className="btn btn-primary btn-small" disabled={pending} onClick={() => checkout.mutate(o.id)}>
                {checkout.isPending && checkout.variables === o.id ? "Abriendo…" : `Suscribirme al ${o.label}`}
              </button>
            </li>
          ))}
        </ul>
      )}
      {status.canManage && (
        <div className="plan-billing-actions">
          <button type="button" className="btn btn-secondary" disabled={pending} onClick={() => portal.mutate()}>
            {portal.isPending ? "Abriendo…" : "Administrar pago"}
          </button>
        </div>
      )}
      <FormError message={error} />
    </section>
  );
}
