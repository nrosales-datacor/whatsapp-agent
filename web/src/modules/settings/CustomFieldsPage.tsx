import { useId, useState, type FormEvent } from "react";
import { terminologyOf } from "../../app/navigation";
import { useSession } from "../../app/session";
import { errorMessage } from "../../lib/api";
import Dialog from "../../ui/Dialog";
import EmptyState from "../../ui/EmptyState";
import ErrorState from "../../ui/ErrorState";
import { FormError, SelectField, TextField } from "../../ui/Field";
import Icon from "../../ui/Icons";
import { useToast } from "../../ui/Toast";
import {
  COMPATIBLE_TYPES,
  FIELD_TYPE_LABELS,
  hasOptions,
  useCustomFieldMutations,
  useCustomFields,
  type CustomField,
  type CustomFieldEntity,
  type CustomFieldType,
} from "../clients/crmApi";
import { CheckRow, ConfirmDialog, fieldErrorOf, LoadingState, moveId, mutationError, OrderButtons } from "./common";
import "../clients/clients.css";

// Configuración › Campos personalizados (plan Pro): datos extra para la ficha del cliente y
// para la cita, con su tipo, opciones, obligatorio y orden. "Desactivar" no borra lo ya
// cargado (vuelve si se reactiva); el tipo solo cambia entre tipos compatibles.

const TYPES = Object.keys(FIELD_TYPE_LABELS) as CustomFieldType[];

type Dialogs = { kind: "edit"; field: CustomField | null } | { kind: "archive"; field: CustomField } | null;

export default function CustomFieldsPage() {
  const me = useSession();
  const t = terminologyOf(me);
  const [entity, setEntity] = useState<CustomFieldEntity>("client");
  const query = useCustomFields(me.business.id, entity, { includeInactive: true });
  const { update, archive, reorder } = useCustomFieldMutations(me.business.id);
  const [dialog, setDialog] = useState<Dialogs>(null);
  const { showToast } = useToast();
  const entityLabel = entity === "client" ? `Ficha del ${t.client}` : `${t.appointment.charAt(0).toLocaleUpperCase("es")}${t.appointment.slice(1)}`;

  const fields = query.data ?? [];
  const ids = fields.map((f) => f.id);

  return (
    <div className="settings-stack">
      <div className="crm-segmented" role="radiogroup" aria-label="¿Dónde se cargan?">
        {(["client", "appointment"] as const).map((e) => (
          <button key={e} type="button" role="radio" aria-checked={entity === e} className="crm-segment" onClick={() => setEntity(e)}>
            {e === "client" ? `Ficha del ${t.client}` : `Cada ${t.appointment}`}
          </button>
        ))}
      </div>

      <div className="settings-toolbar">
        <button type="button" className="btn btn-primary" onClick={() => setDialog({ kind: "edit", field: null })}>
          <Icon id="plus" size={16} />
          Nuevo campo
        </button>
      </div>

      {query.isPending ? (
        <LoadingState />
      ) : query.isError ? (
        <ErrorState message={errorMessage(query.error, "No pudimos cargar los campos.")} onRetry={() => void query.refetch()} />
      ) : fields.length === 0 ? (
        <EmptyState
          icon="grid"
          title="Todavía no hay campos"
          help={entity === "client" ? `Por ejemplo: alergias, tipo de piel o forma preferida. Se completan en la ficha de cada ${t.client}.` : `Por ejemplo: pieza dental o diseño elegido. Se completan en cada ${t.appointment}.`}
        />
      ) : (
        <ul className="settings-list" aria-label={`Campos: ${entityLabel}`}>
          {fields.map((f, i) => (
            <li key={f.id} className={"settings-item" + (f.active ? "" : " inactive")}>
              <div className="settings-item-main">
                <span className="settings-item-title">
                  {f.label}
                  {f.required && <span className="badge badge-info">Obligatorio</span>}
                  {!f.active && <span className="badge badge-muted">Desactivado</span>}
                </span>
                <span className="settings-item-meta">
                  {FIELD_TYPE_LABELS[f.type]}
                  {hasOptions(f.type) && f.options.length > 0 && `: ${f.options.join(", ")}`}
                </span>
              </div>
              <div className="settings-item-actions">
                <OrderButtons
                  index={i}
                  count={fields.length}
                  label={`el campo ${f.label}`}
                  disabled={reorder.isPending}
                  onMove={(from, to) => reorder.mutate({ entity, ids: moveId(ids, from, to) }, { onError: (e) => showToast(errorMessage(e, "No pudimos cambiar el orden.")) })}
                />
                <button type="button" className="icon-btn" aria-label={`Editar el campo ${f.label}`} onClick={() => setDialog({ kind: "edit", field: f })}>
                  <Icon id="pencil" size={18} />
                </button>
                {f.active ? (
                  <button type="button" className="icon-btn danger" aria-label={`Desactivar el campo ${f.label}`} onClick={() => setDialog({ kind: "archive", field: f })}>
                    <Icon id="trash" size={18} />
                  </button>
                ) : (
                  <button
                    type="button"
                    className="btn btn-secondary btn-small"
                    disabled={update.isPending}
                    onClick={() =>
                      update.mutate(
                        { id: f.id, patch: { active: true } },
                        { onSuccess: () => showToast(`«${f.label}» está activo de nuevo.`), onError: (e) => showToast(errorMessage(e)) },
                      )
                    }
                  >
                    Reactivar
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      {dialog?.kind === "edit" && <FieldDialog entity={entity} field={dialog.field} onClose={() => setDialog(null)} />}
      {dialog?.kind === "archive" && (
        <ConfirmDialog
          open
          title="Desactivar el campo"
          confirmLabel="Desactivar"
          danger
          pending={archive.isPending}
          error={mutationError(archive.error)}
          onClose={() => {
            archive.reset();
            setDialog(null);
          }}
          onConfirm={() =>
            archive.mutate(dialog.field.id, {
              onSuccess: () => {
                showToast(`Desactivamos «${dialog.field.label}».`);
                setDialog(null);
              },
            })
          }
        >
          <p>
            «{dialog.field.label}» deja de aparecer en los formularios. Lo que ya está cargado no se borra: vuelve a verse si lo reactivás.
          </p>
        </ConfirmDialog>
      )}
    </div>
  );
}

function FieldDialog({ entity, field, onClose }: { entity: CustomFieldEntity; field: CustomField | null; onClose: () => void }) {
  const me = useSession();
  const { create, update } = useCustomFieldMutations(me.business.id);
  const mutation = field ? update : create;
  const { showToast } = useToast();
  const [label, setLabel] = useState(field?.label ?? "");
  const [type, setType] = useState<CustomFieldType>(field?.type ?? "text");
  const [optionsText, setOptionsText] = useState((field?.options ?? []).join("\n"));
  const [required, setRequired] = useState(field?.required ?? false);
  const [localError, setLocalError] = useState<string | null>(null);
  const optionsId = useId();
  const allowedTypes = field ? [field.type, ...COMPATIBLE_TYPES[field.type]] : TYPES;
  const options = optionsText
    .split("\n")
    .map((o) => o.trim())
    .filter(Boolean);

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!label.trim()) return setLocalError("Escribí el nombre del campo.");
    if (hasOptions(type) && options.length < 2) return setLocalError("Cargá al menos dos opciones (una por línea).");
    setLocalError(null);
    const body = { label: label.trim(), type, options: hasOptions(type) ? options : [], required };
    const done = () => {
      showToast(field ? "Campo actualizado." : "Campo creado.");
      onClose();
    };
    if (field) update.mutate({ id: field.id, patch: body }, { onSuccess: done });
    else create.mutate({ entity, ...body }, { onSuccess: done });
  }

  return (
    <Dialog open onClose={onClose} title={field ? "Editar campo" : "Nuevo campo"}>
      <form onSubmit={onSubmit} noValidate>
        <TextField label="Nombre" value={label} maxLength={80} autoFocus error={fieldErrorOf(mutation.error, "label")} onChange={(e) => setLabel(e.target.value)} />
        <SelectField
          label="Tipo"
          value={type}
          options={allowedTypes.map((v) => ({ value: v, label: FIELD_TYPE_LABELS[v] }))}
          hint={field ? "Para pasar a otro tipo, creá un campo nuevo y desactivá este (así no se pierde lo cargado)." : undefined}
          error={fieldErrorOf(mutation.error, "type")}
          onChange={(e) => setType(e.target.value as CustomFieldType)}
        />
        {hasOptions(type) && (
          <div className="field">
            <div className="field-label-row">
              <label htmlFor={optionsId} className="field-label">
                Opciones (una por línea)
              </label>
            </div>
            <textarea id={optionsId} className="input" rows={5} value={optionsText} onChange={(e) => setOptionsText(e.target.value)} />
            {fieldErrorOf(mutation.error, "options") ? (
              <p className="field-error">{fieldErrorOf(mutation.error, "options")}</p>
            ) : (
              field && <p className="field-hint">Quitar una opción no cambia lo que ya está cargado en las fichas.</p>
            )}
          </div>
        )}
        <CheckRow label="Obligatorio" hint="Se pide al guardar la ficha. No se exige al importar." checked={required} onChange={setRequired} />
        <FormError message={localError ?? (mutation.isError && !fieldErrorOf(mutation.error, "label") ? errorMessage(mutation.error) : null)} />
        <div className="form-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Cancelar
          </button>
          <button type="submit" className="btn btn-primary" disabled={mutation.isPending}>
            {mutation.isPending ? "Guardando…" : "Guardar"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
