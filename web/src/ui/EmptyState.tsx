import type { ReactNode } from "react";
import Icon, { type IconId } from "./Icons";

interface Props {
  icon: IconId;
  title: string;
  help?: ReactNode;
  /** Contenido extra debajo de la ayuda (chips, acciones). */
  children?: ReactNode;
  action?: { label: string; onClick: () => void; icon?: IconId };
}

/** Estado vacío: ícono en chip + título + ayuda + acción opcional (ver design_handoff_panel_whatsapp/). */
export default function EmptyState({ icon, title, help, children, action }: Props) {
  return (
    <div className="empty-state">
      <div className="empty-state-icon">
        <Icon id={icon} size={26} strokeWidth={1.6} />
      </div>
      <p className="empty-state-title">{title}</p>
      {help && <p className="empty-state-help">{help}</p>}
      {children}
      {action && (
        <button type="button" className="btn btn-secondary" onClick={action.onClick}>
          {action.icon && <Icon id={action.icon} size={16} />}
          {action.label}
        </button>
      )}
    </div>
  );
}
