import { useEffect, useId, useRef, type ReactNode } from "react";
import Icon from "./Icons";

// ─────────────────────────────────────────────────────────────────────────────
// Diálogo modal sobre el <dialog> nativo: el navegador ya resuelve la trampa de foco,
// Escape para cerrar, el inert del resto de la página y devolver el foco al botón que lo
// abrió. `variant="sheet"` lo ancla abajo (hoja del menú "Más" en móvil).
// ─────────────────────────────────────────────────────────────────────────────

interface Props {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  variant?: "center" | "sheet";
  /** Más ancho (formularios con varias columnas, editor de horario). */
  wide?: boolean;
}

export default function Dialog({ open, onClose, title, children, variant = "center", wide = false }: Props) {
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
      className={"dialog" + (variant === "sheet" ? " dialog-sheet" : "") + (wide ? " dialog-wide" : "")}
      aria-labelledby={titleId}
      // React propaga `close` por el árbol de componentes: el cierre de un diálogo abierto
      // ADENTRO de este no tiene que cerrarlo.
      onClose={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      // Clic en el fondo (fuera de la caja): el target es el propio <dialog>.
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      {open && (
        <div className="dialog-box">
          <div className="dialog-header">
            <h2 id={titleId} className="dialog-title">
              {title}
            </h2>
            <button type="button" className="icon-btn" onClick={onClose} aria-label="Cerrar">
              <Icon id="x" size={18} />
            </button>
          </div>
          <div className="dialog-content">{children}</div>
        </div>
      )}
    </dialog>
  );
}
