import type { ReactNode } from "react";
import { NavLink } from "react-router-dom";
import Icon from "../../ui/Icons";
import type { NavItem } from "../navigation";
import { useUpsell } from "./upsell";

interface Props {
  items: NavItem[];
  /** Clase de cada ítem (cambia entre el menú lateral, la barra inferior y la hoja "Más"). */
  itemClassName: string;
  /** Se llama al elegir un ítem (p. ej. para cerrar la hoja "Más"). */
  onNavigate?: () => void;
  labelledBy?: string;
  /** Ítem extra al final de la lista (el botón "Más" de la barra inferior). */
  trailing?: ReactNode;
}

/** Lista de ítems del menú: enlace si está abierto, botón con candado si es del plan Pro. */
export default function NavList({ items, itemClassName, onNavigate, labelledBy, trailing }: Props) {
  const { showUpsell } = useUpsell();
  return (
    <ul className="nav-list" aria-labelledby={labelledBy}>
      {items.map(({ section, label, access }) => (
        <li key={section.id}>
          {access === "open" ? (
            <NavLink
              to={section.path}
              end={section.path === "/"}
              className={({ isActive }) => itemClassName + (isActive ? " active" : "")}
              onClick={onNavigate}
            >
              <Icon id={section.icon} size={20} />
              <span className="nav-label">{label}</span>
            </NavLink>
          ) : (
            <button
              type="button"
              className={itemClassName + " locked"}
              aria-haspopup="dialog"
              aria-label={`${label} (disponible en el plan Pro)`}
              onClick={() => {
                onNavigate?.();
                showUpsell(label);
              }}
            >
              <Icon id={section.icon} size={20} />
              <span className="nav-label">{label}</span>
              <span className="nav-lock">
                <Icon id="lock" size={14} />
              </span>
            </button>
          )}
        </li>
      ))}
      {trailing && <li>{trailing}</li>}
    </ul>
  );
}
