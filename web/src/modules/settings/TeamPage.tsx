import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { capitalize, terminologyOf } from "../../app/navigation";
import { useSession } from "../../app/session";
import { errorMessage, isApiError } from "../../lib/api";
import { centsToInput, currencySymbol, parseAmountToCents } from "../../lib/money";
import Dialog from "../../ui/Dialog";
import EmptyState from "../../ui/EmptyState";
import ErrorState from "../../ui/ErrorState";
import { FormError, SelectField, TextField } from "../../ui/Field";
import Icon from "../../ui/Icons";
import { useToast } from "../../ui/Toast";
import { CheckRow, ConfirmDialog, fieldErrorOf, LoadingState, moveId, mutationError, OrderButtons, ReadOnlyNotice } from "./common";
import { blocksFromDraft, draftFromBlocks, mapServerErrors, summarizeHours, validateDraft, type HoursDraft } from "./hoursDraft";
import { durationLabel, priceLabel } from "./ServicesPage";
import { canManageSettings, SETTINGS_KEYS, settingsApi, type LocationView, type StaffServiceItem, type StaffView } from "./settingsApi";
import TimeOffSection from "./TimeOffSection";
import WeeklyHoursEditor from "./WeeklyHoursEditor";

// Configuración > Equipo: profesionales (datos, color, usuario vinculado, orden de la
// agenda), su horario por sucursal, los servicios que hace (con precio/duración propios)
// y las ausencias.

/** Paleta de colores de la agenda (misma que STAFF_COLORS del backend). */
export const STAFF_COLORS = ["#0b7d72", "#6a8ee8", "#e86a92", "#e0902f", "#8a63d2", "#5cb88a", "#c7513b", "#3aa0c8"];

type Dialogs =
  | { kind: "edit"; staff: StaffView | null }
  | { kind: "hours"; staff: StaffView }
  | { kind: "services"; staff: StaffView }
  | { kind: "delete"; staff: StaffView }
  | null;

export default function TeamPage() {
  const me = useSession();
  const t = terminologyOf(me);
  const canEdit = canManageSettings(me);
  const qc = useQueryClient();
  const { showToast } = useToast();
  const staffQuery = useQuery({ queryKey: SETTINGS_KEYS.staff, queryFn: settingsApi.listStaff });
  const locationsQuery = useQuery({ queryKey: SETTINGS_KEYS.locations, queryFn: settingsApi.listLocations });
  const [dialog, setDialog] = useState<Dialogs>(null);
  const close = () => setDialog(null);

  const reorder = useMutation({
    mutationFn: (ids: string[]) => settingsApi.reorderStaff(ids),
    onSettled: () => void qc.invalidateQueries({ queryKey: SETTINGS_KEYS.staff }),
    onError: (error) => showToast(errorMessage(error, "No pudimos cambiar el orden.")),
  });

  if (staffQuery.isPending) return <LoadingState />;
  if (staffQuery.isError) return <ErrorState message={errorMessage(staffQuery.error, `No pudimos cargar a los ${t.staff}.`)} onRetry={() => void staffQuery.refetch()} />;
  const staff = staffQuery.data;
  const locations = locationsQuery.data ?? [];

  return (
    <div className="settings-stack">
      {!canEdit && <ReadOnlyNotice />}
      <div className="settings-toolbar">
        {canEdit && (
          <button type="button" className="btn btn-primary" onClick={() => setDialog({ kind: "edit", staff: null })}>
            <Icon id="plus" size={16} />
            Agregar {t.staffMember}
          </button>
        )}
      </div>
      {staff.length === 0 ? (
        <EmptyState icon="users" title={`Todavía no hay ${t.staff}`} help={`Cargá a cada ${t.staffMember} con su horario para que la agenda y el agente sepan cuándo atiende.`} />
      ) : (
        <ul className="settings-list" aria-label={capitalize(t.staff)}>
          {staff.map((s, i) => (
            <li key={s.id} className={"settings-item" + (s.active ? "" : " inactive")}>
              <div className="settings-item-main">
                <span className="settings-item-title">
                  <span className="color-dot" style={{ background: s.color ?? "var(--text-3)" }} aria-hidden="true" />
                  {s.name}
                  {!s.active && <span className="badge badge-muted">Inactivo</span>}
                  {s.member && <span className="badge">Con usuario</span>}
                </span>
                {s.member && <span className="settings-item-meta">{s.member.email}</span>}
                <StaffHoursSummary staff={s} locations={locations} />
              </div>
              {canEdit && (
                <div className="settings-item-actions">
                  <OrderButtons index={i} count={staff.length} label={s.name} disabled={reorder.isPending} onMove={(from, to) => reorder.mutate(moveId(staff.map((x) => x.id), from, to))} />
                  <button type="button" className="btn btn-secondary btn-small" onClick={() => setDialog({ kind: "hours", staff: s })}>
                    Horario<span className="visually-hidden"> de {s.name}</span>
                  </button>
                  <button type="button" className="btn btn-secondary btn-small" onClick={() => setDialog({ kind: "services", staff: s })}>
                    Servicios<span className="visually-hidden"> de {s.name}</span>
                  </button>
                  <button type="button" className="icon-btn" aria-label={`Editar ${s.name}`} onClick={() => setDialog({ kind: "edit", staff: s })}>
                    <Icon id="pencil" size={18} />
                  </button>
                  <button type="button" className="icon-btn danger" aria-label={`Eliminar ${s.name}`} onClick={() => setDialog({ kind: "delete", staff: s })}>
                    <Icon id="trash" size={18} />
                  </button>
                </div>
              )}
              {!canEdit && (
                <div className="settings-item-actions">
                  <button type="button" className="btn btn-secondary btn-small" onClick={() => setDialog({ kind: "services", staff: s })}>
                    Servicios<span className="visually-hidden"> de {s.name}</span>
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      <h3 className="settings-section-title">Ausencias y feriados</h3>
      <TimeOffSection staff={staff} locations={locations} canEdit={canEdit} />

      {dialog?.kind === "edit" && <StaffDialog staff={dialog.staff} allStaff={staff} onClose={close} />}
      {dialog?.kind === "hours" && <StaffHoursDialog staff={dialog.staff} locations={locations} onClose={close} />}
      {dialog?.kind === "services" && <StaffServicesDialog staff={dialog.staff} readOnly={!canEdit} onClose={close} />}
      {dialog?.kind === "delete" && <DeleteStaffDialog staff={dialog.staff} onClose={close} />}
    </div>
  );
}

function StaffHoursSummary({ staff, locations }: { staff: StaffView; locations: LocationView[] }) {
  const byLocation = [...new Set(staff.hours.map((h) => h.locationId))];
  if (byLocation.length === 0) return <span className="hours-summary">Sin horario cargado</span>;
  return (
    <>
      {byLocation.map((locationId) => (
        <span key={locationId} className="hours-summary">
          <Icon id="mapPin" size={14} /> {locations.find((l) => l.id === locationId)?.name ?? "Sucursal"}:{" "}
          {summarizeHours(staff.hours.filter((h) => h.locationId === locationId))}
        </span>
      ))}
    </>
  );
}

function useStaffInvalidation() {
  const qc = useQueryClient();
  return () => void qc.invalidateQueries({ queryKey: SETTINGS_KEYS.staff });
}

function StaffDialog({ staff, allStaff, onClose }: { staff: StaffView | null; allStaff: StaffView[]; onClose: () => void }) {
  const me = useSession();
  const t = terminologyOf(me);
  const invalidate = useStaffInvalidation();
  const { showToast } = useToast();
  const membersQuery = useQuery({ queryKey: SETTINGS_KEYS.members, queryFn: settingsApi.listMembers });
  const [name, setName] = useState(staff?.name ?? "");
  const [color, setColor] = useState(staff?.color ?? STAFF_COLORS[allStaff.length % STAFF_COLORS.length]);
  const [active, setActive] = useState(staff?.active ?? true);
  const [membershipId, setMembershipId] = useState(staff?.membershipId ?? "");
  const [localError, setLocalError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: () => {
      const input = { name: name.trim(), color, active, membershipId: membershipId || null };
      return staff ? settingsApi.updateStaff(staff.id, input) : settingsApi.createStaff(input);
    },
    onSuccess: (saved) => {
      invalidate();
      showToast(staff ? `Listo, «${saved.name}» quedó guardado.` : `Listo, «${saved.name}» quedó agregado. Cargale su horario.`);
      onClose();
    },
  });

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) return setLocalError("Escribí el nombre.");
    setLocalError(null);
    mutation.mutate();
  }

  const taken = new Set(allStaff.filter((s) => s.id !== staff?.id && s.membershipId).map((s) => s.membershipId));
  const memberOptions = (membersQuery.data ?? []).filter((m) => m.active && !taken.has(m.membershipId));
  return (
    <Dialog open onClose={onClose} title={staff ? `Editar ${staff.name}` : `Agregar ${t.staffMember}`}>
      <form onSubmit={onSubmit} noValidate>
        <TextField label="Nombre" value={name} maxLength={120} autoFocus error={localError ?? fieldErrorOf(mutation.error, "name")} onChange={(e) => setName(e.target.value)} />
        <fieldset className="field">
          <legend>Color en la agenda</legend>
          <div className="color-swatches" role="radiogroup" aria-label="Color en la agenda">
            {STAFF_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                role="radio"
                aria-checked={color.toLowerCase() === c}
                aria-label={`Color ${c}`}
                className="swatch"
                style={{ background: c }}
                onClick={() => setColor(c)}
              >
                {color.toLowerCase() === c && <Icon id="check" size={16} strokeWidth={2.4} />}
              </button>
            ))}
          </div>
          <label className="check-row">
            <input type="color" className="swatch" value={color} onChange={(e) => setColor(e.target.value)} />
            <span>Otro color</span>
          </label>
        </fieldset>
        {membersQuery.isSuccess && (
          <SelectField
            label="Usuario del panel (opcional)"
            hint={`Vinculalo si este ${t.staffMember} entra con su propio usuario («Mi agenda»).`}
            value={membershipId}
            options={[
              { value: "", label: "Sin usuario" },
              ...memberOptions.map((m) => ({ value: m.membershipId, label: `${m.name} (${m.email})` })),
              ...(membershipId && !memberOptions.some((m) => m.membershipId === membershipId) ? [{ value: membershipId, label: staff?.member?.name ?? "Usuario actual" }] : []),
            ]}
            error={fieldErrorOf(mutation.error, "membershipId")}
            onChange={(e) => setMembershipId(e.target.value)}
          />
        )}
        <div className="field">
          <CheckRow label="Activo" hint="Un profesional inactivo no aparece en la agenda ni en el agente." checked={active} onChange={setActive} />
        </div>
        <FormError message={isApiError(mutation.error, "membership_taken") ? "Ese usuario ya está vinculado a otra persona del equipo." : mutationError(mutation.error)} />
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

function StaffHoursDialog({ staff, locations, onClose }: { staff: StaffView; locations: LocationView[]; onClose: () => void }) {
  const me = useSession();
  const t = terminologyOf(me);
  const invalidate = useStaffInvalidation();
  const { showToast } = useToast();
  // Solo las sucursales activas a las que entra la sesión (más las que ya tienen horario).
  const allowed = new Set(me.allLocations ? locations.map((l) => l.id) : me.locations.map((l) => l.id));
  const options = locations.filter((l) => allowed.has(l.id) && (l.active || staff.hours.some((h) => h.locationId === l.id)));
  const [locationId, setLocationId] = useState(options.find((l) => staff.hours.some((h) => h.locationId === l.id))?.id ?? options[0]?.id ?? "");
  const draftFor = (id: string) => draftFromBlocks(staff.hours.filter((h) => h.locationId === id));
  const [draft, setDraft] = useState<HoursDraft>(() => draftFor(locationId));
  const [errors, setErrors] = useState<Record<string, string>>({});

  const mutation = useMutation({
    mutationFn: () => settingsApi.replaceStaffHours(staff.id, locationId, blocksFromDraft(draft).blocks),
    onSuccess: () => {
      invalidate();
      showToast(`Listo, el horario de «${staff.name}» quedó guardado.`);
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
    <Dialog open onClose={onClose} title={`Horario de ${staff.name}`} wide>
      {options.length === 0 ? (
        <p className="settings-help">{`No hay ${t.locations} activas a las que tengas acceso.`}</p>
      ) : (
        <>
          {options.length > 1 && (
            <SelectField
              label={capitalize(t.location)}
              hint={`El horario se carga por ${t.location}; no puede cruzarse con el de otra el mismo día.`}
              value={locationId}
              options={options.map((l) => ({ value: l.id, label: l.name }))}
              onChange={(e) => {
                setLocationId(e.target.value);
                setDraft(draftFor(e.target.value));
                setErrors({});
              }}
            />
          )}
          <WeeklyHoursEditor value={draft} onChange={setDraft} errors={errors} openLabel="Trabaja" closedLabel="No trabaja" disabled={mutation.isPending} />
        </>
      )}
      <FormError message={Object.keys(errors).length > 0 ? "Revisá los tramos marcados." : mutationError(mutation.error)} />
      <div className="form-actions">
        <button type="button" className="btn btn-secondary" onClick={onClose}>
          Cancelar
        </button>
        <button type="button" className="btn btn-primary" disabled={mutation.isPending || !locationId} onClick={save}>
          {mutation.isPending ? "Guardando…" : "Guardar horario"}
        </button>
      </div>
    </Dialog>
  );
}

interface OverrideDraft {
  checked: boolean;
  price: string;
  durationMin: string;
}

function StaffServicesDialog({ staff, readOnly, onClose }: { staff: StaffView; readOnly: boolean; onClose: () => void }) {
  const me = useSession();
  const currency = me.business.currency;
  const qc = useQueryClient();
  const { showToast } = useToast();
  const catalogQuery = useQuery({ queryKey: SETTINGS_KEYS.catalog, queryFn: settingsApi.getCatalog });
  const ownQuery = useQuery({ queryKey: SETTINGS_KEYS.staffServices(staff.id), queryFn: () => settingsApi.getStaffServices(staff.id) });
  const [allServices, setAllServices] = useState<boolean | null>(null);
  const [drafts, setDrafts] = useState<Record<string, OverrideDraft> | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: (items: StaffServiceItem[]) => settingsApi.replaceStaffServices(staff.id, items),
    onSuccess: (saved) => {
      qc.setQueryData(SETTINGS_KEYS.staffServices(staff.id), saved);
      showToast(`Listo, los servicios de «${staff.name}» quedaron guardados.`);
      onClose();
    },
  });

  const loading = catalogQuery.isPending || ownQuery.isPending;
  const failed = catalogQuery.isError || ownQuery.isError;
  const services = catalogQuery.data?.services ?? [];
  const own = ownQuery.data;
  const isAll = allServices ?? own?.allServices ?? true;
  const current: Record<string, OverrideDraft> =
    drafts ??
    Object.fromEntries(
      services.map((s) => {
        const o = own?.services.find((x) => x.serviceId === s.id);
        return [s.id, { checked: !!o, price: o?.priceCents != null ? centsToInput(o.priceCents) : "", durationMin: o?.durationMin != null ? String(o.durationMin) : "" }];
      }),
    );
  const update = (id: string, change: Partial<OverrideDraft>) => setDrafts({ ...current, [id]: { ...current[id], ...change } });

  function save() {
    if (isAll) return mutation.mutate([]);
    const items: StaffServiceItem[] = [];
    for (const s of services) {
      const d = current[s.id];
      if (!d?.checked) continue;
      const priceCents = d.price.trim() ? parseAmountToCents(d.price) : null;
      if (d.price.trim() && priceCents === null) return setLocalError(`Precio inválido en «${s.name}».`);
      const duration = d.durationMin.trim() ? Number(d.durationMin) : null;
      if (duration !== null && (!Number.isInteger(duration) || duration < 5 || duration % 5 !== 0)) {
        return setLocalError(`La duración de «${s.name}» tiene que ser un múltiplo de 5 minutos.`);
      }
      items.push({ serviceId: s.id, priceCents, durationMin: duration });
    }
    if (items.length === 0) return setLocalError("Marcá al menos un servicio, o elegí «Hace todos los servicios».");
    setLocalError(null);
    mutation.mutate(items);
  }

  return (
    <Dialog open onClose={onClose} title={`Servicios de ${staff.name}`} wide>
      {loading ? (
        <LoadingState />
      ) : failed ? (
        <ErrorState message="No pudimos cargar los servicios." onRetry={() => void Promise.all([catalogQuery.refetch(), ownQuery.refetch()])} />
      ) : (
        <>
          <div className="check-list">
            <CheckRow
              label="Hace todos los servicios"
              hint="Con los precios y duraciones del catálogo."
              checked={isAll}
              disabled={readOnly}
              onChange={(v) => setAllServices(v)}
            />
          </div>
          {!isAll && (
            <ul className="settings-list" aria-label="Servicios que hace">
              {services.map((s) => {
                const d = current[s.id];
                return (
                  <li key={s.id} className="settings-item">
                    <div className="settings-item-main">
                      <CheckRow label={s.name} hint={`${durationLabel(s)} · ${priceLabel(s, currency)}`} checked={d?.checked ?? false} disabled={readOnly} onChange={(v) => update(s.id, { checked: v })} />
                    </div>
                    {d?.checked && (
                      <div className="inline-fields">
                        <div className="money-field">
                          <span aria-hidden="true">{currencySymbol(currency)}</span>
                          <input
                            className="input"
                            inputMode="decimal"
                            placeholder="Precio del catálogo"
                            aria-label={`Precio propio para ${s.name} (vacío = el del catálogo)`}
                            value={d.price}
                            disabled={readOnly}
                            onChange={(e) => update(s.id, { price: e.target.value })}
                          />
                        </div>
                        <input
                          className="input"
                          inputMode="numeric"
                          placeholder={`${s.durationMin} min`}
                          aria-label={`Duración propia en minutos para ${s.name} (vacío = la del catálogo)`}
                          value={d.durationMin}
                          disabled={readOnly}
                          onChange={(e) => update(s.id, { durationMin: e.target.value.replace(/\D/g, "") })}
                        />
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}
      <FormError message={localError ?? mutationError(mutation.error)} />
      <div className="form-actions">
        <button type="button" className="btn btn-secondary" onClick={onClose}>
          {readOnly ? "Cerrar" : "Cancelar"}
        </button>
        {!readOnly && (
          <button type="button" className="btn btn-primary" disabled={mutation.isPending || loading || failed} onClick={save}>
            {mutation.isPending ? "Guardando…" : "Guardar"}
          </button>
        )}
      </div>
    </Dialog>
  );
}

function DeleteStaffDialog({ staff, onClose }: { staff: StaffView; onClose: () => void }) {
  const me = useSession();
  const t = terminologyOf(me);
  const invalidate = useStaffInvalidation();
  const { showToast } = useToast();
  const mutation = useMutation({
    mutationFn: () => settingsApi.deleteStaff(staff.id),
    onSuccess: (result) => {
      invalidate();
      showToast(result.deleted ? `«${staff.name}» quedó eliminado.` : `«${staff.name}» tiene historial: quedó desactivado.`);
      onClose();
    },
  });
  return (
    <ConfirmDialog
      open
      title={`¿Eliminar a ${staff.name}?`}
      confirmLabel="Eliminar"
      danger
      pending={mutation.isPending}
      error={mutationError(mutation.error)}
      onConfirm={() => mutation.mutate()}
      onClose={onClose}
    >
      <p>
        Si ya tiene {t.appointments} o comisiones, no se borra: queda <strong>desactivado</strong> y su historial se conserva.
      </p>
    </ConfirmDialog>
  );
}
