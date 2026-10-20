import type { ReactNode } from "react";
import { errorMessage, isApiError } from "../../lib/api";
import Dialog from "../../ui/Dialog";
import { FormError } from "../../ui/Field";
import Icon from "../../ui/Icons";

// Piezas compartidas por las subpáginas de Configuración.

/** Aviso de modo lectura (recepción y profesionales). */
export function ReadOnlyNotice() {
  return (
    <p className="readonly-notice">
      <Icon id="eye" size={16} />
      <span>Estás viendo esta sección en modo lectura: solo el dueño o la administración pueden cambiarla.</span>
    </p>
  );
}

/** Estado de carga de una subpágina. */
export function LoadingState({ label = "Cargando…" }: { label?: string }) {
  return (
    <div className="empty-state" role="status" aria-live="polite">
      <div className="spinner" aria-hidden="true" />
      <p className="empty-state-help">{label}</p>
    </div>
  );
}

/** Error de un campo del cuerpo según la respuesta de la API (`body.<campo>`). */
export function fieldErrorOf(error: unknown, field: string): string | undefined {
  return isApiError(error) ? error.fieldError(field) : undefined;
}

/** Mensaje general de un error de mutación (o null). */
export function mutationError(error: unknown): string | null {
  return error ? errorMessage(error) : null;
}

interface OrderButtonsProps {
  index: number;
  count: number;
  /** Nombre del elemento para el lector de pantalla ("Limpieza facial"). */
  label: string;
  disabled?: boolean;
  onMove: (from: number, to: number) => void;
}

/** Subir / bajar un elemento de una lista ordenada. */
export function OrderButtons({ index, count, label, disabled, onMove }: OrderButtonsProps) {
  return (
    <>
      <button type="button" className="icon-btn" aria-label={`Subir ${label}`} disabled={disabled || index === 0} onClick={() => onMove(index, index - 1)}>
        <Icon id="chevronUp" size={18} />
      </button>
      <button
        type="button"
        className="icon-btn"
        aria-label={`Bajar ${label}`}
        disabled={disabled || index === count - 1}
        onClick={() => onMove(index, index + 1)}
      >
        <Icon id="chevronDown" size={18} />
      </button>
    </>
  );
}

/** Mueve `ids[from]` a `to` y devuelve la lista nueva. */
export function moveId(ids: readonly string[], from: number, to: number): string[] {
  const next = [...ids];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  children: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  pending?: boolean;
  error?: string | null;
  onConfirm: () => void;
  onClose: () => void;
}

/** Confirmación de una acción (eliminar, desactivar). */
export function ConfirmDialog({ open, title, children, confirmLabel, danger, pending, error, onConfirm, onClose }: ConfirmDialogProps) {
  return (
    <Dialog open={open} onClose={onClose} title={title}>
      <div className="settings-help">{children}</div>
      <FormError message={error} />
      <div className="form-actions">
        <button type="button" className="btn btn-secondary" onClick={onClose}>
          Cancelar
        </button>
        <button type="button" className={`btn ${danger ? "btn-danger" : "btn-primary"}`} disabled={pending} onClick={onConfirm}>
          {pending ? "Un momento…" : confirmLabel}
        </button>
      </div>
    </Dialog>
  );
}

interface CheckRowProps {
  label: ReactNode;
  hint?: ReactNode;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}

/** Casilla con su texto (y ayuda opcional). */
export function CheckRow({ label, hint, checked, disabled, onChange }: CheckRowProps) {
  return (
    <label className="check-row">
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span>
        {label}
        {hint && <small>{hint}</small>}
      </span>
    </label>
  );
}
