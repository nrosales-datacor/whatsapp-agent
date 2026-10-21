import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { capitalize, terminologyOf } from "../../app/navigation";
import { ME_QUERY_KEY, useSession } from "../../app/session";
import { atLimit, BILLING_STATUS_LABELS, monthLabel, MODULES, usageText } from "../../lib/plans";
import Icon from "../../ui/Icons";

// ─────────────────────────────────────────────────────────────────────────────
// Configuración › Plan (solo el dueño, solo lectura): el plan del negocio con sus módulos,
// el nivel de clientes, los límites y el uso del mes. Todo sale de `me.plan` (lo resuelve
// modules/billing); al entrar se vuelve a pedir la sesión para que el uso esté al día.
// Cambiar de plan es, por ahora, con nosotros (cobro manual).
// ─────────────────────────────────────────────────────────────────────────────

const PLAN_PITCH: Record<string, string> = {
  basic: "El agente de WhatsApp con la agenda, la ficha de clientes y el inicio para operar alrededor de él.",
  pro: "La gestión completa: clientes, cobros, comisiones, reportes, varias sucursales y marca propia.",
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

export default function PlanPage() {
  const me = useSession();
  const qc = useQueryClient();
  const t = terminologyOf(me);
  const { plan } = me;

  useEffect(() => {
    void qc.invalidateQueries({ queryKey: ME_QUERY_KEY });
  }, [qc]);

  const included = new Set(plan.modules);
  const isPro = plan.id === "pro";
  const branding = plan.features.includes("branding");

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
        </ul>
      </section>

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
        Para cambiar de plan, sumar un módulo o ampliar tus cupos, escribinos: lo ajustamos en el momento, sin perder nada de lo que
        ya cargaste.
      </p>
    </div>
  );
}
