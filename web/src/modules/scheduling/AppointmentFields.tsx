import { useMemo } from "react";
import { useSession } from "../../app/session";
import { hasCrm, useCustomFields, type CustomField } from "../clients/crmApi";
import CustomFieldInput, { fromDraft, sameValue, toDraft, type FieldDraft } from "../clients/CustomFieldInput";

// ─────────────────────────────────────────────────────────────────────────────
// Campos personalizados de la CITA (CRM del Pro, Configuración › Campos personalizados):
// "pieza dental", "diseño o referencia"… Se cargan al agendar (Nueva cita) y se editan en
// el detalle de la cita. Mismas reglas que la ficha del cliente: el borrador es texto, se
// convierte con `fromDraft` y el backend lo vuelve a validar (obligatorios incluidos).
// ─────────────────────────────────────────────────────────────────────────────

export type FieldDrafts = Record<string, FieldDraft>;

/** Campos activos de la cita; vacío sin el CRM completo (el Básico no los tiene). */
export function useAppointmentFields(enabled = true): CustomField[] {
  const me = useSession();
  const crm = hasCrm(me);
  const query = useCustomFields(me.business.id, "appointment", { enabled: enabled && crm });
  // Misma identidad mientras no cambien los datos: el detalle rehace el borrador cuando cambian.
  return useMemo(() => (crm ? (query.data ?? []).filter((f) => f.active) : []), [crm, query.data]);
}

export function draftsOf(fields: readonly CustomField[], data: Record<string, unknown> | null | undefined): FieldDrafts {
  return Object.fromEntries(fields.map((f) => [f.key, toDraft(f, data?.[f.key])]));
}

/**
 * Lo que se manda a la API. Al agendar (`stored` undefined) van todos los campos (así el
 * backend exige los obligatorios); al editar, solo lo que cambió (null = vaciar). Los
 * errores de formato quedan con la clave `customData.<campo>`, como los del backend.
 */
export function customDataFrom(
  fields: readonly CustomField[],
  drafts: FieldDrafts,
  stored?: Record<string, unknown>,
): { data: Record<string, unknown>; errors: Record<string, string> } {
  const data: Record<string, unknown> = {};
  const errors: Record<string, string> = {};
  for (const field of fields) {
    const draft = drafts[field.key] ?? (field.type === "multi_select" ? [] : "");
    if (stored && sameValue(field, draft, stored[field.key])) continue;
    const parsed = fromDraft(field, draft);
    if (!parsed.ok) errors[`customData.${field.key}`] = parsed.error;
    else data[field.key] = parsed.value;
  }
  return { data, errors };
}

interface Props {
  fields: readonly CustomField[];
  drafts: FieldDrafts;
  onChange: (key: string, value: FieldDraft) => void;
  errorFor: (key: string) => string | undefined;
  disabled?: boolean;
}

/** Los inputs de los campos de la cita. */
export default function AppointmentFields({ fields, drafts, onChange, errorFor, disabled }: Props) {
  return (
    <div className="appt-custom-fields">
      {fields.map((field) => (
        <CustomFieldInput
          key={field.key}
          field={field}
          value={drafts[field.key] ?? (field.type === "multi_select" ? [] : "")}
          error={errorFor(field.key)}
          disabled={disabled}
          onChange={(value) => onChange(field.key, value)}
        />
      ))}
    </div>
  );
}
