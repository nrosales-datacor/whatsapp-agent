import { useEffect, useRef } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import { capitalize, terminologyOf } from "../../app/navigation";
import { ME_QUERY_KEY, useSession } from "../../app/session";
import { errorMessage } from "../../lib/api";
import type { BillingOption, BillingStatusView } from "../../lib/contract";
import { atLimit, BILLING_STATUS_LABELS, monthLabel, MODULES, trialDaysLeft, trialEndsText, usageText } from "../../lib/plans";
import { FormError } from "../../ui/Field";
import Icon from "../../ui/Icons";
import { useToast } from "../../ui/Toast";
import { BILLING_STATUS_QUERY_KEY, getBillingStatus, openBillingPortal, startCheckout } from "./billingApi";

// ─────────────────────────────────────────────────────────────────────────────
// Configuración › Plan (solo el dueño): el plan del negocio con sus módulos, el nivel de
// clientes, los límites y el uso del mes. Todo sale de `me.plan` (lo resuelve
// modules/billing); al entrar se vuelve a pedir la sesión para que el uso esté al día.
// Con Stripe configurado (I6.6), el dueño se suscribe (Checkout) o administra el pago, el
// plan y las facturas (Portal); sin Stripe, cambiar de plan es con nosotros (cobro manual).
// ─────────────────────────────────────────────────────────────────────────────

const PLAN_PITCH: Record<string, string> = {
  basic: "El agente de WhatsApp con la agenda, la ficha de clientes y el inicio para operar alrededor de él.",
  pro: "La gestión completa: clientes, cobros, comisiones, reportes, varias sucursales y marca propia.",
};

/** Lo que trae cada opción que se vende en línea (una línea, junto al botón). */
const OPTION_PITCH: Record<BillingOption, string> = {
  basic: "El agente de WhatsApp con la agenda y la ficha de clientes.",
  pro: "La gestión completa con el agente de WhatsApp.",
  pro_no_agent: "La gestión completa, sin el agente de WhatsApp.",
};

function UsageRow({ label, used, limit, note }: { label: string; used: number | null; limit: number | null; note?: string }) {
  const full = used !== null && atLimit(used, limit);
  const ratio = used !== null && limit ? Math.min(1, used / limit) : 0;
  const value = used !== null ? usageText(used, limit) : limit === null ? "Sin tope" : `Hasta ${limit}`;
  return (
    <li className="plan-usage-row">
      <div className="plan-usage-head">
        <span className="plan-usage-label">{label}</span>
        <span className={"plan-usage-value tnum" + (full ? " full" : "")}>{value}</span>
      </div>
      {used !== null && limit !== null && (
        <div className={"plan-usage-bar" + (full ? " full" : "")} role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={limit} aria-valuenow={used}>
          <span style={{ width: `${Math.round(ratio * 100)}%` }} />
        </div>
      )}
      {(note || full) && <span className="plan-usage-note">{full ? "Llegaste al tope de tu plan." : note}</span>}
    </li>
  );
}

/** Suscripción en línea (Stripe): suscribirse a una opción o administrar el pago. */
function OnlineBilling({ status }: { status: BillingStatusView }) {
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
    <section className="card" aria-labelledby="plan-billing">
      <h3 id="plan-billing" className="card-title">
        Pago
      </h3>
      <p className="settings-help">
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

/** Lo de crecimiento que hace el agente (I6; se activa en WhatsApp IA › Crecimiento). */
const GROWTH_FEATURES: readonly { id: string; label: string; description: string }[] = [
  { id: "reviews", label: "Reseñas", description: "después de cada cita, el agente pide la opinión y la reseña en Google." },
  { id: "quote_recovery", label: "Rescate de cotizaciones", description: "a quien preguntó un precio y no agendó, el agente le vuelve a escribir." },
  { id: "upsell", label: "Sugerencias al agendar", description: "el agente ofrece un servicio complementario al agendar." },
];

export default function PlanPage() {
  const me = useSession();
  const qc = useQueryClient();
  const { showToast } = useToast();
  const [params, setParams] = useSearchParams();
  const t = terminologyOf(me);
  const { plan } = me;
  const billing = useQuery({ queryKey: BILLING_STATUS_QUERY_KEY, queryFn: getBillingStatus });

  useEffect(() => {
    void qc.invalidateQueries({ queryKey: ME_QUERY_KEY });
  }, [qc]);

  // Vuelta del Checkout de Stripe (?billing=ok|cancelled): aviso y estado al día. El cambio
  // de plan lo aplica el webhook, que puede tardar unos segundos.
  const returned = params.get("billing");
  const handled = useRef(false);
  useEffect(() => {
    if (!returned || handled.current) return;
    handled.current = true;
    if (returned === "ok") showToast("¡Listo! Recibimos tu suscripción. El plan se actualiza en unos segundos.");
    else if (returned === "cancelled") showToast("No se hizo ningún cobro. Podés suscribirte cuando quieras.");
    void qc.invalidateQueries({ queryKey: BILLING_STATUS_QUERY_KEY });
    void qc.invalidateQueries({ queryKey: ME_QUERY_KEY });
    const next = new URLSearchParams(params);
    next.delete("billing");
    setParams(next, { replace: true });
  }, [returned, params, setParams, qc, showToast]);

  const included = new Set(plan.modules);
  const isPro = plan.id === "pro";
  const branding = plan.features.includes("branding");
  const trialDays = plan.billingStatus === "trial" ? trialDaysLeft(plan.trialEndsAt) : null;
  const online = billing.data?.configured ? billing.data : null;

  return (
    <div className="settings-stack">
      <section className="card" aria-labelledby="plan-current">
        <h3 id="plan-current" className="card-title">
          Plan actual
        </h3>
        <div className="plan-header">
          <p className="page-subtitle-heading">{plan.label}</p>
          <span className={"badge" + (plan.billingStatus === "past_due" ? " badge-warning" : "")}>
            {BILLING_STATUS_LABELS[plan.billingStatus] ?? plan.billingStatus}
          </span>
        </div>
        <p className="settings-help">{PLAN_PITCH[plan.id] ?? ""}</p>
        {trialDays !== null && <p className="plan-trial">{trialEndsText(trialDays)}.</p>}
        <ul className="plan-facts">
          <li>
            <Icon id="users" size={16} />
            <span>
              {plan.clientsTier === "full"
                ? `${capitalize(t.clients)}: CRM completo (estados, visitas, gasto, etiquetas y filtros).`
                : `${capitalize(t.clients)}: ficha automática con su historial de ${t.appointments} y notas.`}
            </span>
          </li>
          <li>
            <Icon id={branding ? "sparkles" : "lock"} size={16} />
            <span>{branding ? "Marca propia: tus colores y tu logo en el panel." : "Marca propia: disponible en el plan Pro."}</span>
          </li>
          {GROWTH_FEATURES.map((f) => {
            const on = plan.features.includes(f.id);
            const why = !isPro ? "disponible en el plan Pro." : "las hace el agente de WhatsApp: no aplican sin él.";
            return (
              <li key={f.id}>
                <Icon id={on ? "sparkles" : "lock"} size={16} />
                <span>{on ? `${f.label}: ${f.description}` : `${f.label}: ${why}`}</span>
              </li>
            );
          })}
        </ul>
      </section>

      {online && <OnlineBilling status={online} />}

      <section className="card" aria-labelledby="plan-modules">
        <h3 id="plan-modules" className="card-title">
          Módulos
        </h3>
        <ul className="plan-module-list">
          {MODULES.map((m) => {
            const on = included.has(m.id);
            return (
              <li key={m.id} className={"plan-module" + (on ? "" : " off")}>
                <Icon id={on ? "check" : "lock"} size={16} />
                <span className="plan-module-name">{m.label}</span>
                <span className="plan-module-state">{on ? "Incluido" : isPro ? "No contratado" : "Disponible en Pro"}</span>
              </li>
            );
          })}
        </ul>
      </section>

      <section className="card" aria-labelledby="plan-limits">
        <h3 id="plan-limits" className="card-title">
          Límites y uso de {monthLabel(plan.usage.month)}
        </h3>
        <ul className="plan-usage">
          <UsageRow label={`${capitalize(t.locations)} activas`} used={plan.usage.locations} limit={plan.limits.locations} />
          <UsageRow label={`${capitalize(t.staff)} activos`} used={plan.usage.staff} limit={plan.limits.staff} />
          <UsageRow label="Usuarios del panel" used={plan.usage.users} limit={plan.limits.users} note="Cuentan también las invitaciones pendientes." />
          {included.has("whatsapp") && (
            <UsageRow
              label="Conversaciones del agente este mes"
              used={plan.usage.aiConversations}
              limit={plan.limits.aiConversations}
              note={plan.usage.aiConversations === null ? "Se empieza a medir cuando conectes WhatsApp IA." : undefined}
            />
          )}
        </ul>
      </section>

      <p className="settings-help">
        {online
          ? "Para sumar un módulo suelto o ampliar tus cupos, escribinos: lo ajustamos en el momento, sin perder nada de lo que ya cargaste."
          : "Para cambiar de plan, sumar un módulo o ampliar tus cupos, escribinos: lo ajustamos en el momento, sin perder nada de lo que ya cargaste."}
      </p>
    </div>
  );
}
