import { useEffect, useLayoutEffect, type ReactNode } from "react";
import { documentTitle } from "../lib/branding";

interface Props {
  title: string;
  subtitle?: ReactNode;
  /** h1 para la página, h2 para una subpágina (p. ej. dentro de Configuración). */
  level?: 1 | 2;
  /** Título de la pestaña del navegador (default: `title`). */
  tabTitle?: string;
  /** Acciones a la derecha del título. */
  children?: ReactNode;
}

/**
 * Encabezado de página. Fija el título del documento ("Agenda · Selyon CRM") y marca su
 * título con `data-page-heading`: el layout le pasa el foco al navegar.
 */
export default function PageHeader({ title, subtitle, level = 1, tabTitle, children }: Props) {
  // La página (h1) fija el título en un layout effect y la subpágina (h2) en un effect
  // común, que corre después: así en Configuración gana "Negocio · Configuración".
  const fullTitle = documentTitle(tabTitle ?? title);
  useLayoutEffect(() => {
    if (level === 1) document.title = fullTitle;
  }, [level, fullTitle]);
  useEffect(() => {
    if (level !== 1) document.title = fullTitle;
  }, [level, fullTitle]);

  const Heading = level === 1 ? "h1" : "h2";
  return (
    <div className="page-header">
      <div className="page-header-text">
        <Heading className={level === 1 ? "page-title" : "page-subtitle-heading"} tabIndex={-1} data-page-heading>
          {title}
        </Heading>
        {subtitle && <p className="page-subtitle">{subtitle}</p>}
      </div>
      {children && <div className="page-actions">{children}</div>}
    </div>
  );
}
