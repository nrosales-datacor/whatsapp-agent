import { useEffect, useId, useRef, type ReactNode } from "react";
import Icon from "./Icons";

// ─────────────────────────────────────────────────────────────────────────────
// Panel lateral modal (detalle de una cita) sobre el <dialog> nativo, igual que Dialog: el
// navegador resuelve la trampa de foco, Escape, el inert del resto y devolver el foco. En
// escritorio se ancla a la derecha; en el celular ocupa la pantalla.
// ─────────────────────────────────────────────────────────────────────────────

interface Props {
  open: boolean;
  onClose: () => void;
  title: string;
  /** Línea chica debajo del título. */
  subtitle?: ReactNode;
  children: ReactNode;
  /** Acciones fijas al pie. */
  footer?: ReactNode;
}

export default function Drawer({ open, onClose, title, subtitle, children, footer }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      className="drawer"
      aria-labelledby={titleId}
      // React propaga `close` por el árbol de componentes: el cierre de un diálogo abierto
      // ADENTRO (p. ej. "Cobrar" en el panel de una cita) no tiene que cerrar este.
      onClose={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      {open && (
        <div className="drawer-box">
          <div className="drawer-header">
            <div className="drawer-heading">
              <h2 id={titleId} className="drawer-title">
                {title}
              </h2>
              {subtitle && <p className="drawer-subtitle">{subtitle}</p>}
            </div>
            <button type="button" className="icon-btn" onClick={onClose} aria-label="Cerrar">
              <Icon id="x" size={18} />
            </button>
          </div>
          <div className="drawer-content">{children}</div>
          {footer && <div className="drawer-footer">{footer}</div>}
        </div>
      )}
    </dialog>
  );
}
