import type { ComponentType } from "react";
import { Navigate, useParams } from "react-router-dom";
import { accessFor, SETTINGS_PAGES, terminologyOf } from "../../app/navigation";
import { LockedContent } from "../../app/SectionGate";
import { useSession } from "../../app/session";
import EmptyState from "../../ui/EmptyState";
import PageHeader from "../../ui/PageHeader";
import BusinessSettingsPage from "./BusinessSettingsPage";
import LocationsPage from "./LocationsPage";
import PlanPage from "./PlanPage";
import ServicesPage from "./ServicesPage";
import TeamPage from "./TeamPage";
import UsersPage from "./UsersPage";
import "./settings.css";

// Una subsección de Configuración (/settings/:page): encabezado + la pantalla de esa
// sección. Las del plan Pro que todavía no tienen pantalla (campos personalizados,
// métodos de pago) muestran el candado; en el Básico, el aviso del plan Pro.

const PAGES: Record<string, ComponentType> = {
  business: BusinessSettingsPage,
  locations: LocationsPage,
  services: ServicesPage,
  team: TeamPage,
  users: UsersPage,
  plan: PlanPage,
};

export default function SettingsSubPage() {
  const { page: slug } = useParams();
  const me = useSession();
  const t = terminologyOf(me);
  const page = SETTINGS_PAGES.find((p) => p.slug === slug);
  const access = page ? accessFor(me, page) : "hidden";

  if (!page || access === "hidden") return <Navigate to="/settings/business" replace />;
  const label = page.label(t);
  const Page = PAGES[page.slug];

  return (
    <>
      <PageHeader title={label} level={2} tabTitle={`${label} · Configuración`} />
      <p className="settings-help settings-intro">{page.description(t)}</p>
      {access === "locked" ? (
        <LockedContent feature={label} />
      ) : page.comingSoon || !Page ? (
        <EmptyState icon="lock" title="Disponible en Pro" help={`${label} llega en una próxima versión del plan Pro. ${page.description(t)}`} />
      ) : (
        <Page key={me.business.id} />
      )}
    </>
  );
}
