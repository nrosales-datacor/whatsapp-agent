import { useId, useState, type InputHTMLAttributes, type ReactNode, type Ref, type SelectHTMLAttributes } from "react";
import Icon from "./Icons";

// ─────────────────────────────────────────────────────────────────────────────
// Campos de formulario con label asociado, ayuda y error accesibles: el error se enlaza
// con aria-describedby y marca aria-invalid, así el lector de pantalla lo lee al enfocar.
// ─────────────────────────────────────────────────────────────────────────────

interface FieldShellProps {
  id: string;
  label: string;
  hint?: ReactNode;
  error?: string;
  /** Algo a la derecha del label (p. ej. "¿La olvidaste?"). */
  labelAside?: ReactNode;
  children: ReactNode;
}

function FieldShell({ id, label, hint, error, labelAside, children }: FieldShellProps) {
  return (
    <div className="field">
      <div className="field-label-row">
        <label htmlFor={id} className="field-label">
          {label}
        </label>
        {labelAside}
      </div>
      {children}
      {hint && !error && (
        <p id={`${id}-hint`} className="field-hint">
          {hint}
        </p>
      )}
      {error && (
        <p id={`${id}-error`} className="field-error">
          {error}
        </p>
      )}
    </div>
  );
}

function describedBy(id: string, hint: ReactNode, error: string | undefined): string | undefined {
  if (error) return `${id}-error`;
  if (hint) return `${id}-hint`;
  return undefined;
}

type InputProps = Omit<InputHTMLAttributes<HTMLInputElement>, "id"> & {
  label: string;
  hint?: ReactNode;
  error?: string;
  labelAside?: ReactNode;
  ref?: Ref<HTMLInputElement>;
};

export function TextField({ label, hint, error, labelAside, className, ref, ...rest }: InputProps) {
  const id = useId();
  return (
    <FieldShell id={id} label={label} hint={hint} error={error} labelAside={labelAside}>
      <input
        ref={ref}
        id={id}
        className={"input" + (className ? ` ${className}` : "")}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(id, hint, error)}
        {...rest}
      />
    </FieldShell>
  );
}

/** Campo de clave con botón para mostrarla u ocultarla. */
export function PasswordField({ label, hint, error, labelAside, className, ...rest }: Omit<InputProps, "type">) {
  const id = useId();
  const [visible, setVisible] = useState(false);
  return (
    <FieldShell id={id} label={label} hint={hint} error={error} labelAside={labelAside}>
      <div className="password-wrap">
        <input
          id={id}
          type={visible ? "text" : "password"}
          className={"input" + (className ? ` ${className}` : "")}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy(id, hint, error)}
          {...rest}
        />
        <button
          type="button"
          className="password-toggle"
          onClick={() => setVisible((v) => !v)}
          aria-label={visible ? "Ocultar clave" : "Mostrar clave"}
          aria-pressed={visible}
          aria-controls={id}
        >
          <Icon id={visible ? "eyeOff" : "eye"} size={18} />
        </button>
      </div>
    </FieldShell>
  );
}

type SelectProps = Omit<SelectHTMLAttributes<HTMLSelectElement>, "id"> & {
  label: string;
  hint?: ReactNode;
  error?: string;
  options: readonly { value: string; label: string }[];
};

export function SelectField({ label, hint, error, options, className, ...rest }: SelectProps) {
  const id = useId();
  return (
    <FieldShell id={id} label={label} hint={hint} error={error}>
      <select
        id={id}
        className={"input select" + (className ? ` ${className}` : "")}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(id, hint, error)}
        {...rest}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </FieldShell>
  );
}

/** Error general de un formulario (lo anuncia el lector de pantalla al aparecer). */
export function FormError({ message }: { message: string | null | undefined }) {
  return (
    <div className="form-error" role="alert">
      {message ? (
        <>
          <Icon id="alert" size={16} />
          <span>{message}</span>
        </>
      ) : null}
    </div>
  );
}
