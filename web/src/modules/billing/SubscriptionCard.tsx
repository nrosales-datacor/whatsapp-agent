import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import { ME_QUERY_KEY } from "../../app/session";
import { errorMessage } from "../../lib/api";
import type { BillingAccount, CheckoutInput, Plan } from "../../lib/contract";
import { FormError } from "../../ui/Field";
import Icon from "../../ui/Icons";
import { BILLING_STATUS_QUERY_KEY, formatBillingDate, goToStripe, openPortal, startCheckout, trialLeftText, useBillingStatus } from "./billingApi";
import "./billing.css";

// ─────────────────────────────────────────────────────────────────────────────
// Configuración › Plan › Suscripción (solo el dueño): el estado del cobro en línea y los
// botones "Suscribirme" (Stripe Checkout) y "Gestionar pago" (Customer Portal). Stripe
// vuelve a /settings/plan?checkout=success|cancelled; el plan se actualiza cuando llega
// el webhook (unos segundos), por eso al volver se vuelve a pedir la sesión.
// ─────────────────────────────────────────────────────────────────────────────

const PLAN_PITCH: Record<Plan, string> = {
  basic: "El agente de WhatsApp con la agenda y la ficha de clientes.",
  pro: "La gestión completa: clientes, cobros, comisiones, reportes y varias sucursales.",
};

/** Estado del cobro en una línea (prueba, renovación, atraso, cancelación). */
export function billingSummary(b: Pick<BillingAccount, "billingStatus" | "trialEndsAt" | "currentPeriodEnd" | "cancelAtPeriodEnd" | "pauseAt" | "hasSubscription">): string | null {
  if (b.billingStatus === "past_due") {
    return b.pauseAt
      ? `No pudimos cobrar tu suscripción. Actualizá tu medio de pago antes del ${formatBillingDate(b.pauseAt)} para que la cuenta no se pause.`
      : "No pudimos cobrar tu suscripción. Actualizá tu medio de pago para que la cuenta no se pause.";
  }
  if (b.billingStatus === "trial" && b.trialEndsAt) return `${trialLeftText(b.trialEndsAt)} (termina el ${formatBillingDate(b.trialEndsAt)}).`;
  if (b.billingStatus === "cancelled") return "Tu suscripción está cancelada.";
  if (b.hasSubscription && b.currentPeriodEnd) {
    return b.cancelAtPeriodEnd
      ? `Tu suscripción termina el ${formatBillingDate(b.currentPeriodEnd)}. Hasta entonces todo sigue igual.`
      : `Tu suscripción se renueva el ${formatBillingDate(b.currentPeriodEnd)}.`;
  }
  return null;
}

function ExtraField({ id, label, value, onChange }: { id: string; label: string; value: number; onChange: (n: number) => void }) {
  return (
    <label className="billing-extra" htmlFor={id}>
      <span>{label}</span>
      <input
        id={id}
        className="input billing-extra-input tnum"
        type="number"
        inputMode="numeric"
        min={0}
        max={100}
        value={value}
        onChange={(e) => onChange(Math.max(0, Math.min(100, Math.floor(Number(e.target.value) || 0))))}
      />
    </label>
  );
}

/** Botones de pago: suscribirse (planes con precio) o gestionar el pago. Lo comparten Plan y la cuenta pausada. */
export function BillingActions({ status }: { status: BillingAccount }) {
  const [extras, setExtras] = useState({ locations: 0, staff: 0 });
  const checkout = useMutation({ mutationFn: (input: CheckoutInput) => startCheckout(input), onSuccess: ({ url }) => goToStripe(url) });
  const portal = useMutation({ mutationFn: openPortal, onSuccess: ({ url }) => goToStripe(url) });
  const busy = checkout.isPending || portal.isPending || checkout.isSuccess || portal.isSuccess;
  const error = checkout.isError ? errorMessage(checkout.error) : portal.isError ? errorMessage(portal.error) : null;

  if (!status.onlinePayments) {
    return <p className="settings-help">El pago en línea todavía no está disponible. Para contratar o cambiar tu plan, escribinos.</p>;
  }

  if (status.hasSubscription) {
    return (
      <div className="billing-actions">
        <p className="settings-help">Cambiá de plan o de cupos, actualizá la tarjeta, descargá tus facturas o cancelá desde la página segura de Stripe.</p>
        <button type="button" className="btn btn-primary" onClick={() => portal.mutate()} disabled={busy}>
          <Icon id="key" size={16} />
          {portal.isPending || portal.isSuccess ? "Abriendo Stripe…" : "Gestionar pago"}
        </button>
        <FormError message={error} />
      </div>
    );
  }

  const offers = status.plans.filter((p) => p.available);
  return (
    <div className="billing-actions">
      {status.billingStatus === "trial" && status.trialEndsAt && (
        <p className="settings-help">Suscribite cuando quieras: no te cobramos nada hasta que termine la prueba.</p>
      )}
      <ul className="billing-offers">
        {offers.map((p) => (
          <li key={p.id} className="billing-offer">
            <div className="billing-offer-head">
              <span className="billing-offer-name">Plan {p.label}</span>
              {status.plan === p.id && <span className="badge">Tu plan actual</span>}
            </div>
            <p className="settings-help">{PLAN_PITCH[p.id]}</p>
            {p.id === "pro" && (status.extras.locations || status.extras.staff) && (
              <div className="billing-extras">
                {status.extras.locations && (
                  <ExtraField id="extra-locations" label="Sucursales extra" value={extras.locations} onChange={(n) => setExtras((x) => ({ ...x, locations: n }))} />
                )}
                {status.extras.staff && (
                  <ExtraField id="extra-staff" label="Profesionales extra" value={extras.staff} onChange={(n) => setExtras((x) => ({ ...x, staff: n }))} />
                )}
              </div>
            )}
            <button
              type="button"
              className={"btn " + (p.id === "pro" ? "btn-primary" : "btn-secondary")}
              disabled={busy}
              onClick={() =>
                checkout.mutate(p.id === "pro" ? { plan: "pro", extraLocations: extras.locations, extraStaff: extras.staff } : { plan: p.id })
              }
            >
              {checkout.isPending && checkout.variables?.plan === p.id ? "Abriendo Stripe…" : `Suscribirme al ${p.label}`}
            </button>
          </li>
        ))}
      </ul>
      {status.canManage && (
        <button type="button" className="link-button" onClick={() => portal.mutate()} disabled={busy}>
          Ver mis facturas y medios de pago
        </button>
      )}
      <FormError message={error} />
    </div>
  );
}

export default function SubscriptionCard() {
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const [returned] = useState(() => params.get("checkout"));
  const status = useBillingStatus();

  // Al volver de Stripe: se limpia la URL y se piden de nuevo la sesión y el estado (el
  // webhook puede tardar unos segundos en actualizar el plan).
  useEffect(() => {
    if (!returned) return;
    setParams(
      (p) => {
        const next = new URLSearchParams(p);
        next.delete("checkout");
        return next;
      },
      { replace: true },
    );
    void qc.invalidateQueries({ queryKey: ME_QUERY_KEY });
    void qc.invalidateQueries({ queryKey: BILLING_STATUS_QUERY_KEY });
  }, [returned, qc, setParams]);

  const summary = status.data ? billingSummary(status.data) : null;
  return (
    <section className="card" aria-labelledby="plan-subscription">
      <h3 id="plan-subscription" className="card-title">
        Suscripción
      </h3>
      {returned === "success" && (
        <p className="billing-notice billing-notice-ok" role="status">
          <Icon id="check" size={16} />
          ¡Gracias! Stripe nos está confirmando el pago: en unos segundos tu plan queda al día.
        </p>
      )}
      {returned === "cancelled" && (
        <p className="billing-notice" role="status">
          El pago no se completó. Podés suscribirte cuando quieras.
        </p>
      )}
      {status.isPending ? (
        <p className="muted" role="status">
          Cargando tu suscripción…
        </p>
      ) : status.isError ? (
        <FormError message={errorMessage(status.error, "No pudimos cargar tu suscripción.")} />
      ) : (
        <>
          {summary && (
            <p className={"billing-summary" + (status.data.billingStatus === "past_due" ? " billing-summary-warning" : "")}>{summary}</p>
          )}
          <BillingActions status={status.data} />
        </>
      )}
    </section>
  );
}
