import { Link, Outlet, useLocation, useMatch } from "react-router-dom";
import { useSession } from "../../app/session";
import type { Role } from "../../lib/contract";
import PageHeader from "../../ui/PageHeader";
// Clases compartidas que usa la sección (carga, barra de guardado, avisos, insignias).
import "../clients/clients.css";
import "../settings/settings.css";
import "./whatsapp.css";

// ─────────────────────────────────────────────────────────────────────────────
// WhatsApp IA (/whatsapp/*, PLAN-GESTION.md §6): Bandeja · Métricas · Configuración.
//   /whatsapp                       bandeja (en desktop, lista + "elegí una conversación")
//   /whatsapp/conversations/:id     bandeja con el chat abierto (enlazable desde un push)
//   /whatsapp/metrics               métricas del agente
//   /whatsapp/settings              configuración del agente y números (dueño y admin)
// La guarda del módulo (plan y rol) es la de la sección, en App.tsx.
// ─────────────────────────────────────────────────────────────────────────────

export const AGENT_MANAGERS: readonly Role[] = ["owner", "admin"];

interface Tab {
  path: string;
  label: string;
  managersOnly?: boolean;
}

const TABS: readonly Tab[] = [
  { path: "/whatsapp", label: "Bandeja" },
  { path: "/whatsapp/metrics", label: "Métricas" },
  { path: "/whatsapp/settings", label: "Configuración", managersOnly: true },
];

/** Pestaña activa: la bandeja también cubre /whatsapp/conversations/:id. */
function activeTab(pathname: string): string {
  if (pathname.startsWith("/whatsapp/metrics")) return "/whatsapp/metrics";
  if (pathname.startsWith("/whatsapp/settings")) return "/whatsapp/settings";
  return "/whatsapp";
}

export default function WhatsappLayout() {
  const me = useSession();
  const { pathname } = useLocation();
  const chatOpen = useMatch("/whatsapp/conversations/:id") !== null;
  const current = activeTab(pathname);
  const tabs = TABS.filter((tab) => !tab.managersOnly || AGENT_MANAGERS.includes(me.role));
  const currentLabel = tabs.find((tab) => tab.path === current)?.label ?? "Bandeja";

  return (
    <div className={"page wa-page" + (chatOpen ? " wa-page-chat" : "") + (current === "/whatsapp" ? " wa-page-inbox" : "")}>
      <div className="wa-head">
        <PageHeader title="WhatsApp IA" tabTitle={`${currentLabel} · WhatsApp IA`} />
        <nav className="wa-tabs" aria-label="Secciones de WhatsApp IA">
          <ul>
            {tabs.map((tab) => (
              <li key={tab.path}>
                <Link to={tab.path} className={"wa-tab" + (tab.path === current ? " active" : "")} aria-current={tab.path === current ? "page" : undefined}>
                  {tab.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      </div>
      <Outlet />
    </div>
  );
}
