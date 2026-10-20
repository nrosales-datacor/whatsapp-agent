import type { ReactNode } from "react";
import { Navigate } from "react-router-dom";
import EmptyState from "../ui/EmptyState";
import PageHeader from "../ui/PageHeader";
import { accessFor, getSection, homePathFor, terminologyOf, type SectionId } from "./navigation";
import { useSession } from "./session";

/** Mensaje de una sección o subsección del plan Pro abierta por URL desde un negocio Básico. */
export function LockedContent({ feature }: { feature: string }) {
  return (
    <EmptyState
      icon="lock"
      title="Disponible en el plan Pro"
      help={`${feature} es parte del plan Pro. Contactanos para actualizar tu plan y empezar a usarlo.`}
    />
  );
}

/**
 * Guarda de una sección por URL, con las mismas reglas que el menú: si el rol no la usa
 * (o el plan la oculta) se vuelve al inicio; si es del plan Pro, se explica en vez de
 * mostrarla.
 */
export default function SectionGate({ id, children }: { id: SectionId; children: ReactNode }) {
  const me = useSession();
  const section = getSection(id);
  const access = accessFor(me, section);

  if (access === "hidden") return <Navigate to={homePathFor(me)} replace />;
  if (access === "locked") {
    const label = section.label(terminologyOf(me), me.role);
    return (
      <div className="page">
        <PageHeader title={label} />
        <LockedContent feature={label} />
      </div>
    );
  }
  return <>{children}</>;
}
