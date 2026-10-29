import type { ReactNode } from "react";
import EmptyState from "../ui/EmptyState";
import type { IconId } from "../ui/Icons";
import PageHeader from "../ui/PageHeader";
import { ALL_LOCATIONS, useActiveLocation } from "./location";
import { capitalize, getSection, terminologyOf, type SectionId } from "./navigation";
import { useSession } from "./session";

interface Props {
  id: SectionId;
  /** Por defecto, los textos de la sección en navigation.ts. */
  title?: string;
  description?: string;
  planned?: string[];
  icon?: IconId;
  /** La sección depende de la sucursal elegida: se muestra cuál debajo del título. */
  locationScoped?: boolean;
  /** Algo arriba del estado vacío (p. ej. el enlace para volver a la lista). */
  before?: ReactNode;
}

/**
 * Estado de las secciones en esta etapa (I0.7): el título correcto (con la terminología
 * del negocio) y un estado vacío que dice qué va a tener, sin datos inventados.
 */
export default function SectionPlaceholder({ id, title, description, planned, icon, locationScoped, before }: Props) {
  const me = useSession();
  const t = terminologyOf(me);
  const section = getSection(id);
  const { selected, label } = useActiveLocation();

  const items = planned ?? section.planned(t, me.role);
  const subtitle = locationScoped
    ? selected === ALL_LOCATIONS
      ? label
      : `${capitalize(t.location)}: ${label}`
    : undefined;

  return (
    <div className="page">
      <PageHeader title={title ?? section.label(t, me.role)} subtitle={subtitle} />
      {before}
      <EmptyState icon={icon ?? section.icon} title="Esto llega en la próxima etapa" help={description ?? section.description(t, me.role)}>
        {items.length > 0 && (
          <div className="planned">
            <p className="planned-title">Lo que vas a encontrar acá</p>
            <ul className="chips">
              {items.map((item) => (
                <li key={item} className="chip">
                  {item}
                </li>
              ))}
            </ul>
          </div>
        )}
      </EmptyState>
    </div>
  );
}
