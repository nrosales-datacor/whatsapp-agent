import type { AdminStripeInfo } from "../../lib/contract";

// Superadmin › un negocio › Cobro en línea (I6): el estado de Stripe del negocio (cliente,
// suscripción, período, atraso, pausa por el cobro y prueba), con el link al Dashboard.

const SUBSCRIPTION_LABELS: Record<string, string> = {
  active: "Activa",
  trialing: "En prueba (Stripe)",
  past_due: "Pago atrasado",
  unpaid: "Impaga",
  paused: "Pausada",
  canceled: "Cancelada",
  incomplete: "Checkout sin pagar",
  incomplete_expired: "Checkout vencido",
};

function date(iso: string | null): string {
  return iso ? new Date(iso).toLocaleDateString("es-CR", { day: "numeric", month: "short", year: "numeric" }) : "—";
}

export default function AdminStripeCard({ stripe }: { stripe: AdminStripeInfo }) {
  const rows: [string, string][] = [
    ["Suscripción", stripe.subscriptionStatus ? (SUBSCRIPTION_LABELS[stripe.subscriptionStatus] ?? stripe.subscriptionStatus) : "Sin suscripción"],
    ["Fin del período", stripe.currentPeriodEnd ? `${date(stripe.currentPeriodEnd)}${stripe.cancelAtPeriodEnd ? " (se cancela)" : ""}` : "—"],
    ["Pago atrasado desde", date(stripe.pastDueSince)],
    ["Se pausa el", date(stripe.pauseAt)],
    ["Fin de la prueba", stripe.trialEndsAt ? date(stripe.trialEndsAt) : "Sin vencimiento (cobro manual)"],
    ["Pausado por el cobro", stripe.billingPaused ? "Sí (al pagar se reactiva solo)" : "No"],
  ];
  return (
    <section className="card" aria-labelledby="stripe-title">
      <h2 id="stripe-title" className="card-title">
        Cobro en línea (Stripe)
      </h2>
      {!stripe.configured && <p className="muted">Stripe no está configurado en el servidor: el cobro es manual.</p>}
      <dl className="admin-usage">
        <div className="admin-usage-row">
          <dt>Cliente</dt>
          <dd>
            {stripe.customerId ? (
              stripe.dashboardUrl ? (
                <a className="link" href={stripe.dashboardUrl} target="_blank" rel="noreferrer noopener">
                  {stripe.customerId}
                </a>
              ) : (
                stripe.customerId
              )
            ) : (
              "Sin cliente en Stripe"
            )}
          </dd>
        </div>
        {rows.map(([label, value]) => (
          <div key={label} className="admin-usage-row">
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
