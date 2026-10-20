import { Navigate, useParams } from "react-router-dom";
import { accessFor, SETTINGS_PAGES, terminologyOf } from "../../app/navigation";
import { LockedContent } from "../../app/SectionGate";
import { useSession } from "../../app/session";
import EmptyState from "../../ui/EmptyState";
import PageHeader from "../../ui/PageHeader";

/** Una subsección de Configuración (/settings/:page). Por ahora, su estado vacío. */
export default function SettingsSubPage() {
  const { page: slug } = useParams();
  const me = useSession();
  const t = terminologyOf(me);
  const page = SETTINGS_PAGES.find((p) => p.slug === slug);
  const access = page ? accessFor(me, page) : "hidden";

  if (!page || access === "hidden") return <Navigate to="/settings/business" replace />;
  const label = page.label(t);

  return (
    <>
      <PageHeader title={label} level={2} tabTitle={`${label} · Configuración`} />
      {access === "locked" ? (
        <LockedContent feature={label} />
      ) : (
        <EmptyState icon="gear" title="Esto llega en la próxima etapa" help={page.description(t)} />
      )}
    </>
  );
}
