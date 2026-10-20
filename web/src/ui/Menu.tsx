import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import Icon, { type IconId } from "./Icons";

// ─────────────────────────────────────────────────────────────────────────────
// Menú desplegable accesible (patrón "menu button" de WAI-ARIA): el botón anuncia
// aria-haspopup/aria-expanded; al abrir, el foco va al primer ítem; flechas, Inicio y Fin
// lo mueven; Escape cierra y devuelve el foco al botón; Tab o un clic afuera lo cierran.
// Los ítems deshabilitados siguen siendo enfocables (para que se lea el "Próximamente"),
// pero no hacen nada.
// ─────────────────────────────────────────────────────────────────────────────

export interface MenuItem {
  key: string;
  label: string;
  icon?: IconId;
  onSelect?: () => void;
  disabled?: boolean;
  /** Texto chico a la derecha (p. ej. "Próximamente"). */
  hint?: string;
  /** Marca el ítem actual (p. ej. el negocio activo). */
  current?: boolean;
}

interface Props {
  /** Nombre accesible del botón cuando su contenido no lo dice (p. ej. solo un avatar). */
  ariaLabel?: string;
  buttonContent: ReactNode;
  buttonClassName?: string;
  items: MenuItem[];
  /** Encabezado no interactivo arriba de los ítems (p. ej. nombre y correo del usuario). */
  header?: ReactNode;
  align?: "start" | "end";
  /** Abre hacia arriba (menús al pie de la barra lateral). */
  placement?: "below" | "above";
}

export default function Menu({ ariaLabel, buttonContent, buttonClassName, items, header, align = "end", placement = "below" }: Props) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const menuId = useId();

  const close = useCallback((returnFocus: boolean) => {
    setOpen(false);
    if (returnFocus) buttonRef.current?.focus();
  }, []);

  // Al abrir, foco al primer ítem.
  useEffect(() => {
    if (open) itemRefs.current[0]?.focus();
  }, [open]);

  // Clic o toque afuera → cerrar (sin robar el foco a lo que se tocó).
  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: PointerEvent) {
      if (!rootRef.current?.contains(e.target as Node)) close(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open, close]);

  function focusItem(index: number) {
    const count = items.length;
    if (count === 0) return;
    itemRefs.current[(index + count) % count]?.focus();
  }

  function onMenuKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    const current = itemRefs.current.findIndex((el) => el === document.activeElement);
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        focusItem(current + 1);
        break;
      case "ArrowUp":
        e.preventDefault();
        focusItem(current - 1);
        break;
      case "Home":
        e.preventDefault();
        focusItem(0);
        break;
      case "End":
        e.preventDefault();
        focusItem(items.length - 1);
        break;
      case "Escape":
        e.preventDefault();
        close(true);
        break;
      case "Tab":
        close(false);
        break;
    }
  }

  function onButtonKeyDown(e: KeyboardEvent<HTMLButtonElement>) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setOpen(true);
    }
  }

  return (
    <div className="menu-root" ref={rootRef}>
      <button
        ref={buttonRef}
        type="button"
        className={buttonClassName}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={ariaLabel}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={onButtonKeyDown}
      >
        {buttonContent}
      </button>
      {open && (
        <div className={`menu-popover menu-${align} menu-${placement}`} onKeyDown={onMenuKeyDown}>
          {header && <div className="menu-header">{header}</div>}
          <div role="menu" id={menuId} aria-label={ariaLabel} className="menu-list">
            {items.map((item, i) => (
              <button
                key={item.key}
                ref={(el) => {
                  itemRefs.current[i] = el;
                }}
                type="button"
                role="menuitem"
                tabIndex={-1}
                className={"menu-item" + (item.current ? " menu-item-current" : "")}
                aria-disabled={item.disabled || undefined}
                aria-current={item.current || undefined}
                onClick={() => {
                  if (item.disabled) return;
                  close(true);
                  item.onSelect?.();
                }}
              >
                {item.icon && <Icon id={item.icon} size={18} />}
                <span className="menu-item-label">{item.label}</span>
                {item.hint && <span className="menu-item-hint">{item.hint}</span>}
                {item.current && <Icon id="check" size={16} />}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
