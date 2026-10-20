import { useSession } from "../../app/session";

// Configuración > Plan (solo lectura). Placeholder hasta que existan los planes y su
// cobro (I2/I6): muestra el plan del negocio y los módulos que trae (`me.modules`).

const MODULE_LABELS: Record<string, string> = {
  scheduling: "Agenda",
  clients: "Clientes",
  sales: "Ventas y cobros",
  commissions: "Comisiones",
  reports: "Reportes",
  whatsapp: "WhatsApp IA",
  campaigns: "Campañas",
};

export default function PlanPage() {
  const me = useSession();
  const pro = me.business.plan === "pro";
  return (
    <div className="settings-stack">
      <section className="card" aria-labelledby="plan-current">
        <h3 id="plan-current" className="card-title">
          Plan actual
        </h3>
        <p className="page-subtitle-heading">{pro ? "Pro · gestión completa" : "Básico · el agente de WhatsApp"}</p>
        <p className="settings-help">
          {pro
            ? "Clientes, cobros, comisiones, reportes y varias sucursales, con o sin el agente."
            : "El agente de WhatsApp con la agenda, los clientes y el inicio para operar alrededor de él."}
        </p>
        <h4 className="card-title" style={{ marginTop: "var(--space-md)" }}>
          Módulos incluidos
        </h4>
        <div className="plan-modules">
          {me.modules.map((m) => (
            <span key={m} className="chip">
              {MODULE_LABELS[m] ?? m}
            </span>
          ))}
        </div>
      </section>
      <p className="settings-help">Para cambiar de plan o sumar un módulo, escribinos: pronto vas a poder hacerlo desde acá.</p>
    </div>
  );
}
