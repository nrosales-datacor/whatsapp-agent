import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { capitalize, terminologyOf } from "../../app/navigation";
import { useSession } from "../../app/session";
import { errorMessage, isApiError } from "../../lib/api";
import { formatCents } from "../../lib/money";
import Dialog from "../../ui/Dialog";
import { FormError, SelectField, TextField } from "../../ui/Field";
import { useToast } from "../../ui/Toast";
import { clientKeys, searchClients, useCreateClient } from "../clients/clientsApi";
import { formatPhone } from "../clients/format";
import type { LocationView, ServiceView, StaffView } from "../settings/settingsApi";
import { formatMinutes, formatTime, formatWhen } from "./format";
import { useCreateAppointment, type Appointment, type PanelChannel, type Slot } from "./schedulingApi";
import SlotPicker from "./SlotPicker";

export interface NewAppointmentDefaults {
  locationId?: string;
  date?: string;
  staffId?: string;
  client?: { id: string; name: string; phone?: string | null } | null;
  /** Horario a preelegir si está libre (clic en la agenda). */
  startsAt?: string | null;
}

interface Props {
  open: boolean;
  onClose: () => void;
  defaults: NewAppointmentDefaults;
  locations: LocationView[];
  staff: StaffView[];
  services: ServiceView[];
  onCreated?: (appointment: Appointment) => void;
}

interface PickedClient {
  id: string;
  name: string;
  phone?: string | null;
}

const CHANNELS: { value: PanelChannel; label: string }[] = [
  { value: "panel", label: "Agendada en el panel" },
  { value: "phone", label: "Por teléfono" },
  { value: "walk_in", label: "Llegó sin cita" },
];

/**
 * "Nueva cita": cliente (buscar o alta rápida por teléfono), uno o varios servicios,
 * profesional ("cualquiera" o uno), fecha y uno de los horarios libres de `/availability`.
 * El profesional del rol `staff` queda fijo en él mismo.
 */
export default function NewAppointmentDialog({ open, onClose, defaults, locations, staff, services, onCreated }: Props) {
  const me = useSession();
  const t = terminologyOf(me);
  const { showToast } = useToast();
  const isStaff = me.role === "staff";
  const activeLocations = locations.filter((l) => l.active);

  const [locationId, setLocationId] = useState(defaults.locationId ?? activeLocations[0]?.id ?? "");
  const [client, setClient] = useState<PickedClient | null>(defaults.client ?? null);
  const [serviceIds, setServiceIds] = useState<string[]>([]);
  const [staffId, setStaffId] = useState<string>(isStaff ? (me.staffId ?? "") : (defaults.staffId ?? "any"));
  const [date, setDate] = useState(defaults.date ?? "");
  const [slot, setSlot] = useState<Slot | null>(null);
  const [channel, setChannel] = useState<PanelChannel>("panel");
  const [notes, setNotes] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);
  const mutation = useCreateAppointment();

  // Al abrir, se arranca de los valores que manda la agenda.
  useEffect(() => {
    if (!open) return;
    setLocationId(defaults.locationId ?? activeLocations[0]?.id ?? "");
    setClient(defaults.client ?? null);
    setServiceIds([]);
    setStaffId(isStaff ? (me.staffId ?? "") : (defaults.staffId ?? "any"));
    setDate(defaults.date ?? "");
    setSlot(null);
    setChannel("panel");
    setNotes("");
    setLocalError(null);
    mutation.reset();
    // Solo al abrir: los defaults cambian de identidad en cada render de la agenda.
  }, [open]);

  const location = locations.find((l) => l.id === locationId) ?? null;
  const timeZone = location?.timezone ?? me.business.timezone;
  const offered = services.filter((s) => s.active && (s.locationIds.length === 0 || s.locationIds.includes(locationId)));
  const lanes = staff.filter((s) => s.active && s.hours.some((h) => h.locationId === locationId));
  const params = useMemo(
    () => (locationId && date && serviceIds.length > 0 ? { locationId, date, serviceIds, staffId: staffId || "any" } : null),
    [locationId, date, serviceIds, staffId],
  );

  function toggleService(id: string) {
    setServiceIds((list) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]));
    setSlot(null);
  }

  function close() {
    mutation.reset();
    onClose();
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (mutation.isPending) return;
    const problem = !client
      ? `Elegí el ${t.client}.`
      : serviceIds.length === 0
        ? "Elegí al menos un servicio."
        : !slot
          ? "Elegí un horario."
          : null;
    setLocalError(problem);
    if (problem || !client || !slot) return;
    const chosenStaff = staffId && staffId !== "any" ? staffId : slot.staff.length === 1 ? slot.staff[0].id : "any";
    mutation.mutate(
      { locationId, clientId: client.id, serviceIds, staffId: chosenStaff, startsAt: slot.startsAt, channel, notes: notes.trim() || null },
      {
        onSuccess: (appointment) => {
          showToast(`${capitalize(t.appointment)} agendada: ${client.name}, ${formatWhen(appointment.startsAt, timeZone)}`);
          onCreated?.(appointment);
          close();
        },
      },
    );
  }

  const apiError = isApiError(mutation.error) ? mutation.error : null;
  const fieldError = (name: string) => apiError?.fieldError(name);
  const generalError =
    localError ??
    (apiError?.code === "slot_taken"
      ? "Ese horario se acaba de ocupar. Elegí otro."
      : mutation.isError && !(apiError && Object.keys(apiError.fields).length > 0)
        ? errorMessage(mutation.error)
        : (fieldError("startsAt") ?? fieldError("staffId") ?? fieldError("serviceIds") ?? fieldError("clientId") ?? null));

  const summary = slot && slot.staff.length > 0 ? slot.staff : null;
  const chosen = summary ? (staffId !== "any" ? summary.find((s) => s.id === staffId) : summary[0]) : null;

  return (
    <Dialog open={open} onClose={close} title={`Nueva ${t.appointment}`} wide>
      <form onSubmit={onSubmit} noValidate className="appt-form">
        <ClientPicker value={client} onChange={setClient} open={open} />

        <div className="form-grid">
          {activeLocations.length > 1 ? (
            <SelectField
              label={capitalize(t.location)}
              value={locationId}
              onChange={(e) => {
                setLocationId(e.target.value);
                setServiceIds([]);
                setSlot(null);
                if (!isStaff) setStaffId("any");
              }}
              options={activeLocations.map((l) => ({ value: l.id, label: l.name }))}
            />
          ) : null}
          {!isStaff && (
            <SelectField
              label={capitalize(t.staffMember)}
              value={staffId}
              onChange={(e) => {
                setStaffId(e.target.value);
                setSlot(null);
              }}
              options={[{ value: "any", label: "Cualquiera disponible" }, ...lanes.map((s) => ({ value: s.id, label: s.name }))]}
            />
          )}
          <TextField
            label="Fecha"
            type="date"
            value={date}
            required
            onChange={(e) => {
              setDate(e.target.value);
              setSlot(null);
            }}
          />
          <SelectField label="Cómo llegó" value={channel} onChange={(e) => setChannel(e.target.value as PanelChannel)} options={CHANNELS} />
        </div>

        <fieldset className="appt-fieldset">
          <legend className="field-label">Servicios</legend>
          {offered.length === 0 ? (
            <p className="muted">No hay servicios activos en esta {t.location}.</p>
          ) : (
            <ul className="service-options">
              {offered.map((s) => {
                const index = serviceIds.indexOf(s.id);
                return (
                  <li key={s.id}>
                    <label className={"service-option" + (index >= 0 ? " service-option-checked" : "")}>
                      <input type="checkbox" checked={index >= 0} onChange={() => toggleService(s.id)} />
                      <span className="service-option-name">
                        {index >= 0 && serviceIds.length > 1 ? <span className="service-order">{index + 1}</span> : null}
                        {s.name}
                      </span>
                      <span className="muted tnum">
                        {formatMinutes(s.durationMin)} · {s.priceCents > 0 ? `${s.variablePrice ? "desde " : ""}${formatCents(s.priceCents, me.business.currency)}` : "sin precio"}
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
          )}
          {serviceIds.length > 1 && <p className="field-hint">Se hacen uno detrás del otro, en el orden en que los elegiste.</p>}
        </fieldset>

        <div className="field">
          <p className="field-label" id="slots-label">
            Horario
          </p>
          <SlotPicker
            params={params}
            timeZone={timeZone}
            value={slot?.startsAt ?? null}
            onChange={setSlot}
            preferredStart={defaults.startsAt}
            idleHint={!date ? "Elegí la fecha y los servicios para ver los horarios." : undefined}
          />
          {chosen && slot && (
            <p className="field-hint">
              {formatTime(slot.startsAt, timeZone)} a {formatTime(chosen.endsAt, timeZone)} con {staffId === "any" && summary && summary.length > 1 ? `${chosen.name} (o quien esté libre)` : chosen.name}
              {chosen.totalCents > 0 ? ` · ${formatCents(chosen.totalCents, me.business.currency)}` : ""}
            </p>
          )}
        </div>

        <TextField label="Notas (opcional)" value={notes} maxLength={2000} onChange={(e) => setNotes(e.target.value)} />
        <FormError message={generalError} />
        <div className="client-form-actions">
          <button type="button" className="btn btn-secondary" onClick={close}>
            Cancelar
          </button>
          <button type="submit" className="btn btn-primary" disabled={mutation.isPending}>
            {mutation.isPending ? "Agendando…" : `Agendar ${t.appointment}`}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

// ── Cliente: buscar o alta rápida ───────────────────────────────────────────

function ClientPicker({ value, onChange, open }: { value: PickedClient | null; onChange: (c: PickedClient | null) => void; open: boolean }) {
  const me = useSession();
  const t = terminologyOf(me);
  const [draft, setDraft] = useState("");
  const [q, setQ] = useState("");
  const [quick, setQuick] = useState(false);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const listId = useId();
  const searchRef = useRef<HTMLInputElement>(null);
  const create = useCreateClient(me.business.id);

  useEffect(() => {
    if (open && !value) searchRef.current?.focus();
    if (!open) {
      setDraft("");
      setQ("");
      setQuick(false);
      setName("");
      setPhone("");
      create.reset();
    }
  }, [open]);

  useEffect(() => {
    const timer = window.setTimeout(() => setQ(draft.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [draft]);

  const results = useQuery({
    queryKey: [...clientKeys.all(me.business.id), "appointment-search", q],
    queryFn: () => searchClients(q),
    enabled: open && !value && q.length > 0,
  });

  if (value) {
    return (
      <div className="field">
        <p className="field-label">{capitalize(t.client)}</p>
        <div className="picked-client">
          <div>
            <p className="picked-client-name">{value.name}</p>
            {value.phone && <p className="muted">{formatPhone(value.phone)}</p>}
          </div>
          <button type="button" className="link-button" onClick={() => onChange(null)}>
            Cambiar
          </button>
        </div>
      </div>
    );
  }

  if (quick) {
    const apiError = isApiError(create.error) ? create.error : null;
    return (
      <div className="quick-client">
        <p className="field-label">Alta rápida de {t.client}</p>
        <div className="form-grid">
          <TextField label="Nombre" value={name} autoComplete="off" onChange={(e) => setName(e.target.value)} error={apiError?.fieldError("name")} />
          <TextField
            label="Teléfono"
            type="tel"
            inputMode="tel"
            autoComplete="off"
            placeholder="8888 7777"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            error={apiError?.fieldError("phone") ?? (apiError?.code === "phone_taken" ? apiError.message : undefined)}
          />
        </div>
        {create.isError && !apiError?.fieldError("name") && !apiError?.fieldError("phone") && apiError?.code !== "phone_taken" && (
          <p className="field-error">{errorMessage(create.error)}</p>
        )}
        <div className="quick-client-actions">
          <button type="button" className="btn btn-secondary btn-small" onClick={() => setQuick(false)}>
            Volver a buscar
          </button>
          <button
            type="button"
            className="btn btn-primary btn-small"
            disabled={create.isPending || !name.trim()}
            onClick={() =>
              create.mutate(
                { name: name.trim(), phone: phone.trim() || null },
                { onSuccess: (c) => onChange({ id: c.id, name: c.name, phone: c.phone }) },
              )
            }
          >
            {create.isPending ? "Guardando…" : `Guardar ${t.client}`}
          </button>
        </div>
      </div>
    );
  }

  const options = results.data?.items ?? [];
  return (
    <div>
      <TextField
        label={`Buscar ${t.client}`}
        type="search"
        autoComplete="off"
        ref={searchRef}
        placeholder="Nombre o teléfono"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        aria-controls={listId}
      />
      <div id={listId} className="client-picker-results" aria-live="polite">
        {q.length === 0 ? null : results.isPending ? (
          <p className="muted">Buscando…</p>
        ) : results.isError ? (
          <p className="field-error">{errorMessage(results.error)}</p>
        ) : options.length === 0 ? (
          <p className="muted">No encontramos {t.clients} con «{q}».</p>
        ) : (
          <ul className="client-picker-list">
            {options.map((c) => (
              <li key={c.id}>
                <button type="button" className="client-picker-option" onClick={() => onChange({ id: c.id, name: c.name, phone: c.phone })}>
                  <span className="client-picker-name">{c.name}</span>
                  <span className="muted">{formatPhone(c.phone) || c.email || "Sin teléfono"}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <button
        type="button"
        className="link-button"
        onClick={() => {
          setQuick(true);
          const digits = draft.replace(/[^\d+]/g, "");
          if (digits.length >= 7) setPhone(draft.trim());
          else setName(draft.trim());
        }}
      >
        + Alta rápida de {t.client}
      </button>
    </div>
  );
}
