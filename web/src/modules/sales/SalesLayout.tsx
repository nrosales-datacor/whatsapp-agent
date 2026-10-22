import { Link, Navigate, Outlet, useLocation } from "react-router-dom";
import { ALL_LOCATIONS, useActiveLocation } from "../../app/location";
import { capitalize, terminologyOf } from "../../app/navigation";
import { useSession } from "../../app/session";
import type { Me } from "../../lib/contract";
import PageHeader from "../../ui/PageHeader";
// Clases compartidas que usa la sección (tablas, carga, avisos y listas de Configuración).
import "../clients/clients.css";
import "../settings/settings.css";
import "./sales.css";

// ─────────────────────────────────────────────────────────────────────────────
// Ventas (/sales/*, PLAN-GESTION.md §6): Cobros · Pendientes · Resumen del día · Comisiones.
//   /sales               Cobros: movimientos con filtros, nuevo cobro, devoluciones
//   /sales/pending       Pendientes: citas completadas con saldo (cobrar desde ahí)
//   /sales/today         Resumen del día por método (imprimible)
//   /sales/commissions   Comisiones (dueño y admin) · "Mis comisiones" (profesional)
// Recepción ve todo menos Comisiones; el profesional solo "Mis comisiones". La guarda del
// módulo (plan y rol) es la de la sección, en App.tsx.
// ─────────────────────────────────────────────────────────────────────────────

interface Tab {
  path: string;
  label: string;
}

const DESK_TABS: readonly Tab[] = [
  { path: "/sales", label: "Cobros" },
  { path: "/sales/pending", label: "Pendientes" },
  { path: "/sales/today", label: "Resumen del día" },
];

const COMMISSIONS_TAB: Tab = { path: "/sales/commissions", label: "Comisiones" };

/** Pestañas que ve la sesión según su rol y los módulos del plan. */
export function salesTabsFor(me: Me): Tab[] {
  if (me.role === "staff") return me.modules.includes("commissions") ? [{ ...COMMISSIONS_TAB, label: "Mis comisiones" }] : [];
  const tabs = me.modules.includes("sales") ? [...DESK_TABS] : [];
  if ((me.role === "owner" || me.role === "admin") && me.modules.includes("commissions")) tabs.push(COMMISSIONS_TAB);
  return tabs;
}

function activeTab(pathname: string): string {
  for (const p of ["/sales/pending", "/sales/today", "/sales/commissions"]) if (pathname.startsWith(p)) return p;
  return "/sales";
}

export default function SalesLayout() {
  const me = useSession();
  const t = terminologyOf(me);
  const { pathname } = useLocation();
  const { selected, label } = useActiveLocation();
  const tabs = salesTabsFor(me);
  const current = activeTab(pathname);
  const currentTab = tabs.find((tab) => tab.path === current);

  // Una pestaña que la sesión no tiene (p. ej. el profesional en /sales): a la primera que sí.
  if (!currentTab && tabs[0]) return <Navigate to={tabs[0].path} replace />;
  const title = me.role === "staff" ? "Mis comisiones" : "Ventas";
  const scoped = current !== "/sales/commissions";

  return (
    <div className="page sales-page">
      <div className="sales-head no-print">
        <PageHeader
          title={title}
          tabTitle={currentTab && me.role !== "staff" ? `${currentTab.label} · Ventas` : title}
          subtitle={scoped ? (selected === ALL_LOCATIONS ? label : `${capitalize(t.location)}: ${label}`) : undefined}
        />
        {tabs.length > 1 && (
          <nav className="sales-tabs" aria-label="Secciones de Ventas">
            <ul>
              {tabs.map((tab) => (
                <li key={tab.path}>
                  <Link to={tab.path} className={"sales-tab" + (tab.path === current ? " active" : "")} aria-current={tab.path === current ? "page" : undefined}>
                    {tab.label}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
        )}
      </div>
      <Outlet />
    </div>
  );
}
