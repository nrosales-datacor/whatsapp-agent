import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { capitalize, terminologyOf } from "../../app/navigation";
import { ME_QUERY_KEY, useSession } from "../../app/session";
import { errorMessage, isApiError } from "../../lib/api";
import Dialog from "../../ui/Dialog";
import EmptyState from "../../ui/EmptyState";
import ErrorState from "../../ui/ErrorState";
import { FormError, SelectField, TextField } from "../../ui/Field";
import Icon from "../../ui/Icons";
import { useToast } from "../../ui/Toast";
import { CheckRow, ConfirmDialog, fieldErrorOf, LoadingState, mutationError, ReadOnlyNotice } from "./common";
import { blocksFromDraft, draftFromBlocks, mapServerErrors, summarizeHours, validateDraft, type HoursDraft } from "./hoursDraft";
import { TIMEZONE_OPTIONS, withCurrent } from "./regions";
import { canManageSettings, SETTINGS_KEYS, settingsApi, type LocationView } from "./settingsApi";
import WeeklyHoursEditor from "./WeeklyHoursEditor";

// Configuración > Sucursales: lista con su horario; alta, edición, horario semanal con
// tramos (descansos) y eliminar (con historial, el backend la desactiva).

type Dialogs = { kind: "edit"; location: LocationView | null } | { kind: "hours"; location: LocationView } | { kind: "delete"; location: LocationView } | null;

export default function LocationsPage() {
  const me = useSession();
  const t = terminologyOf(me);
  const canEdit = canManageSettings(me);
  const query = useQuery({ queryKey: SETTINGS_KEYS.locations, queryFn: settingsApi.listLocations });
  const [dialog, setDialog] = useState<Dialogs>(null);
  const close = () => setDialog(null);

  if (query.isPending) return <LoadingState />;
  if (query.isError) return <ErrorState message={errorMessage(query.error, `No pudimos cargar las ${t.locations}.`)} onRetry={() => void query.refetch()} />;
  const locations = query.data;
  const activeCount = locations.filter((l) => l.active).length;

  return (
    <div className="settings-stack">
      {!canEdit && <ReadOnlyNotice />}
      {canEdit && me.allLocations && (
        <div className="settings-toolbar">
          <button type="button" className="btn btn-primary" onClick={() => setDialog({ kind: "edit", location: null })}>
            <Icon id="plus" size={16} />
            Nueva {t.location}
          </button>
        </div>
      )}
      {locations.length === 0 ? (
        <EmptyState icon="mapPin" title={`Sin ${t.locations}`} help={`Todavía no hay ${t.locations} para mostrar.`} />
      ) : (
        <ul className="settings-list" aria-label={capitalize(t.locations)}>
          {locations.map((l) => (
            <li key={l.id} className={"settings-item" + (l.active ? "" : " inactive")}>
              <div className="settings-item-main">
                <span className="settings-item-title">
                  {l.name}
                  {!l.active && <span className="badge badge-muted">Inactiva</span>}
                </span>
                <span className="settings-item-meta">{[l.address, l.phone, l.timezone.replace("America/", "").replace(/_/g, " ")].filter(Boolean).join(" · ")}</span>
                <span className="hours-summary">
                  <Icon id="clock" size={14} /> {summarizeHours(l.hours, "Cerrada toda la semana")}
                </span>
              </div>
              {canEdit && (
                <div className="settings-item-actions">
                  <button type="button" className="btn btn-secondary" onClick={() => setDialog({ kind: "hours", location: l })}>
                    Horario<span className="visually-hidden"> de {l.name}</span>
                  </button>
                  <button type="button" className="icon-btn" aria-label={`Editar ${l.name}`} onClick={() => setDialog({ kind: "edit", location: l })}>
                    <Icon id="pencil" size={18} />
                  </button>
                  <button
                    type="button"
                    className="icon-btn danger"
                    aria-label={`Eliminar ${l.name}`}
                    disabled={l.active && activeCount <= 1}
                    title={l.active && activeCount <= 1 ? `El negocio necesita al menos una ${t.location} activa` : undefined}
                    onClick={() => setDialog({ kind: "delete", location: l })}
                  >
                    <Icon id="trash" size={18} />
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {dialog?.kind === "edit" && <LocationDialog location={dialog.location} defaultTimezone={me.business.timezone} onClose={close} />}
      {dialog?.kind === "hours" && <HoursDialog location={dialog.location} onClose={close} />}
      {dialog?.kind === "delete" && <DeleteLocationDialog location={dialog.location} onClose={close} />}
    </div>
  );
}

function useLocationsInvalidation() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: SETTINGS_KEYS.locations });
    // El selector de sucursal y `me.locations` salen de la sesión.
    void qc.invalidateQueries({ queryKey: ME_QUERY_KEY });
  };
}

function LocationDialog({ location, defaultTimezone, onClose }: { location: LocationView | null; defaultTimezone: string; onClose: () => void }) {
  const me = useSession();
  const t = terminologyOf(me);
  const { showToast } = useToast();
  const invalidate = useLocationsInvalidation();
  const [name, setName] = useState(location?.name ?? "");
  const [address, setAddress] = useState(location?.address ?? "");
  const [phone, setPhone] = useState(location?.phone ?? "");
  const [timezone, setTimezone] = useState(location?.timezone ?? defaultTimezone);
  const [active, setActive] = useState(location?.active ?? true);
  const [localError, setLocalError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: () => {
      const input = { name: name.trim(), address: address.trim() || null, phone: phone.trim() || null, timezone };
      return location ? settingsApi.updateLocation(location.id, { ...input, active }) : settingsApi.createLocation(input);
    },
    onSuccess: (saved) => {
      invalidate();
      showToast(location ? `Listo, «${saved.name}» quedó guardada.` : `Listo, «${saved.name}» quedó creada con el horario de lunes a sábado.`);
      onClose();
    },
  });

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) return setLocalError("Escribí el nombre.");
    setLocalError(null);
    mutation.mutate();
  }

  const lastActive = isApiError(mutation.error, "last_location");
  return (
    <Dialog open onClose={onClose} title={location ? `Editar ${location.name}` : `Nueva ${t.location}`}>
      <form onSubmit={onSubmit} noValidate>
        <TextField label="Nombre" value={name} maxLength={120} autoFocus error={localError ?? fieldErrorOf(mutation.error, "name")} onChange={(e) => setName(e.target.value)} />
        <TextField label="Dirección" value={address} maxLength={300} error={fieldErrorOf(mutation.error, "address")} onChange={(e) => setAddress(e.target.value)} />
        <TextField label="Teléfono" type="tel" autoComplete="tel" value={phone} maxLength={40} error={fieldErrorOf(mutation.error, "phone")} onChange={(e) => setPhone(e.target.value)} />
        <SelectField label="Zona horaria" value={timezone} options={withCurrent(TIMEZONE_OPTIONS, timezone)} error={fieldErrorOf(mutation.error, "timezone")} onChange={(e) => setTimezone(e.target.value)} />
        {location && (
          <div className="field">
            <CheckRow label="Activa" hint={`Una ${t.location} inactiva no aparece en la agenda ni en el agente.`} checked={active} onChange={setActive} />
          </div>
        )}
        <FormError message={lastActive ? `El negocio tiene que tener al menos una ${t.location} activa.` : mutationError(mutation.error)} />
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

function HoursDialog({ location, onClose }: { location: LocationView; onClose: () => void }) {
  const { showToast } = useToast();
  const invalidate = useLocationsInvalidation();
  const [draft, setDraft] = useState<HoursDraft>(() => draftFromBlocks(location.hours));
  const [errors, setErrors] = useState<Record<string, string>>({});

  const mutation = useMutation({
    mutationFn: () => settingsApi.replaceLocationHours(location.id, blocksFromDraft(draft).blocks),
    onSuccess: () => {
      invalidate();
      showToast(`Listo, el horario de «${location.name}» quedó guardado.`);
      onClose();
    },
    onError: (error) => {
      if (isApiError(error, "validation_error")) setErrors(mapServerErrors(error.fields, blocksFromDraft(draft).index));
    },
  });

  function save() {
    const local = validateDraft(draft);
    setErrors(local);
    if (Object.keys(local).length === 0) mutation.mutate();
  }

  return (
    <Dialog open onClose={onClose} title={`Horario de ${location.name}`} wide>
      <WeeklyHoursEditor value={draft} onChange={setDraft} errors={errors} disabled={mutation.isPending} />
      <FormError message={Object.keys(errors).length > 0 ? "Revisá los tramos marcados." : mutationError(mutation.error)} />
      <div className="form-actions">
        <button type="button" className="btn btn-secondary" onClick={onClose}>
          Cancelar
        </button>
        <button type="button" className="btn btn-primary" disabled={mutation.isPending} onClick={save}>
          {mutation.isPending ? "Guardando…" : "Guardar horario"}
        </button>
      </div>
    </Dialog>
  );
}

function DeleteLocationDialog({ location, onClose }: { location: LocationView; onClose: () => void }) {
  const { showToast } = useToast();
  const invalidate = useLocationsInvalidation();
  const mutation = useMutation({
    mutationFn: () => settingsApi.deleteLocation(location.id),
    onSuccess: (result) => {
      invalidate();
      showToast(result.deleted ? `«${location.name}» quedó eliminada.` : `«${location.name}» tiene historial: quedó desactivada (podés reactivarla cuando quieras).`);
      onClose();
    },
  });
  return (
    <ConfirmDialog
      open
      title={`¿Eliminar ${location.name}?`}
      confirmLabel="Eliminar"
      danger
      pending={mutation.isPending}
      error={mutationError(mutation.error)}
      onConfirm={() => mutation.mutate()}
      onClose={onClose}
    >
      <p>
        Si ya tiene citas, pagos o personas asignadas, no se borra: queda <strong>desactivada</strong> y se conserva para los reportes.
      </p>
    </ConfirmDialog>
  );
}
