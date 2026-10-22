import { useId } from "react";
import { SelectField, TextField } from "../../ui/Field";
import type { CustomField } from "./crmApi";

// ─────────────────────────────────────────────────────────────────────────────
// Un campo personalizado en un formulario (ficha del cliente; en el futuro, la cita). El
// borrador es texto o lista de texto (lo que maneja un <input>); `fromDraft` lo convierte
// al valor de la API con las mismas reglas que el backend (src/modules/business/
// customFields.ts), y el backend lo vuelve a validar.
// ─────────────────────────────────────────────────────────────────────────────

/** Valor en edición: texto (o "true"/"false"/"" para sí/no) o lista de opciones. */
export type FieldDraft = string | string[];

/** Valor guardado → borrador. Un valor que no calza con el tipo (definición vieja) se muestra como texto. */
export function toDraft(field: CustomField, value: unknown): FieldDraft {
  if (field.type === "multi_select") return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
  if (value === undefined || value === null) return "";
  if (field.type === "boolean") return value === true ? "true" : value === false ? "false" : "";
  if (Array.isArray(value)) return value.join(", ");
  return String(value);
}

/** Borrador → valor para la API (null = vaciar) o un error. */
export function fromDraft(field: CustomField, draft: FieldDraft): { ok: true; value: unknown } | { ok: false; error: string } {
  if (Array.isArray(draft)) return { ok: true, value: draft.length > 0 ? field.options.filter((o) => draft.includes(o)) : null };
  const text = draft.trim();
  if (text === "") return { ok: true, value: null };
  switch (field.type) {
    case "number": {
      const n = Number(text.replace(/\s/g, "").replace(",", "."));
      return Number.isFinite(n) ? { ok: true, value: n } : { ok: false, error: "Escribí un número." };
    }
    case "boolean":
      return { ok: true, value: text === "true" };
    default:
      return { ok: true, value: text };
  }
}

/** ¿El valor del borrador es el mismo que el guardado? (para mandar solo lo que cambió). */
export function sameValue(field: CustomField, draft: FieldDraft, stored: unknown): boolean {
  return JSON.stringify(toDraft(field, stored)) === JSON.stringify(draft);
}

interface Props {
  field: CustomField;
  value: FieldDraft;
  error?: string;
  disabled?: boolean;
  onChange: (value: FieldDraft) => void;
}

export default function CustomFieldInput({ field, value, error, disabled, onChange }: Props) {
  const groupId = useId();
  const label = field.required ? `${field.label} *` : field.label;
  const text = Array.isArray(value) ? value.join(", ") : value;

  switch (field.type) {
    case "long_text":
      return (
        <div className="field">
          <div className="field-label-row">
            <label htmlFor={groupId} className="field-label">
              {label}
            </label>
          </div>
          <textarea
            id={groupId}
            className="input client-custom-textarea"
            rows={3}
            maxLength={5000}
            value={text}
            disabled={disabled}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? `${groupId}-error` : undefined}
            onChange={(e) => onChange(e.target.value)}
          />
          {error && (
            <p id={`${groupId}-error`} className="field-error">
              {error}
            </p>
          )}
        </div>
      );
    case "number":
      return <TextField label={label} inputMode="decimal" value={text} error={error} disabled={disabled} onChange={(e) => onChange(e.target.value)} />;
    case "date":
      return <TextField label={label} type="date" value={text} error={error} disabled={disabled} onChange={(e) => onChange(e.target.value)} />;
    case "boolean":
      return (
        <SelectField
          label={label}
          value={text}
          error={error}
          disabled={disabled}
          options={[
            { value: "", label: "Sin dato" },
            { value: "true", label: "Sí" },
            { value: "false", label: "No" },
          ]}
          onChange={(e) => onChange(e.target.value)}
        />
      );
    case "select": {
      // Un valor guardado que ya no es una opción (se quitó) se sigue mostrando.
      const legacy = text && !field.options.includes(text) ? [{ value: text, label: `${text} (opción anterior)` }] : [];
      return (
        <SelectField
          label={label}
          value={text}
          error={error}
          disabled={disabled}
          options={[{ value: "", label: "Sin dato" }, ...field.options.map((o) => ({ value: o, label: o })), ...legacy]}
          onChange={(e) => onChange(e.target.value)}
        />
      );
    }
    case "multi_select": {
      const picked = Array.isArray(value) ? value : [];
      return (
        <fieldset className="field" aria-describedby={error ? `${groupId}-error` : undefined}>
          <legend>{label}</legend>
          <div className="client-custom-options">
            {field.options.map((option) => (
              <label key={option} className="check-row">
                <input
                  type="checkbox"
                  checked={picked.includes(option)}
                  disabled={disabled}
                  onChange={(e) => onChange(e.target.checked ? [...picked, option] : picked.filter((p) => p !== option))}
                />
                <span>{option}</span>
              </label>
            ))}
          </div>
          {error && (
            <p id={`${groupId}-error`} className="field-error">
              {error}
            </p>
          )}
        </fieldset>
      );
    }
    default:
      return <TextField label={label} value={text} maxLength={500} error={error} disabled={disabled} onChange={(e) => onChange(e.target.value)} />;
  }
}
