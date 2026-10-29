import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { capitalize, terminologyOf } from "../../app/navigation";
import { useSession } from "../../app/session";
import { errorMessage } from "../../lib/api";
import Dialog from "../../ui/Dialog";
import ErrorState from "../../ui/ErrorState";
import { FormError, SelectField, TextField } from "../../ui/Field";
import Icon from "../../ui/Icons";
import { useToast } from "../../ui/Toast";
import { CheckRow, ConfirmDialog, fieldErrorOf, LoadingState, mutationError } from "./common";
import { SETTINGS_KEYS, settingsApi, type LocationView, type StaffView, type TimeOffEntry, type TimeOffScope } from "./settingsApi";
import { addDays, formatRange, isAllDay, isoToZoned, zonedToIso } from "./zonedTime";

// Ausencias y feriados (Configuración > Equipo): del negocio entero, de una sucursal o de
// un profesional. Se escriben y se leen en la hora local de la sucursal (o del negocio);
// la API recibe instantes. "Todo el día" guarda [inicio 00:00, día siguiente al fin 00:00).

interface Props {
  staff: StaffView[];
  locations: LocationView[];
  canEdit: boolean;
}

export default function TimeOffSection({ staff, locations, canEdit }: Props) {
  const me = useSession();
  const t = terminologyOf(me);
  const query = useQuery({ queryKey: SETTINGS_KEYS.timeOff, queryFn: settingsApi.listTimeOff });
  const [editing, setEditing] = useState<TimeOffEntry | "new" | null>(null);
  const [deleting, setDeleting] = useState<TimeOffEntry | null>(null);

  const zoneOf = (entry: Pick<TimeOffEntry, "locationId">) => locations.find((l) => l.id === entry.locationId)?.timezone ?? me.business.timezone;
  const scopeLabel = (e: TimeOffEntry) => {
    const where = locations.find((l) => l.id === e.locationId)?.name;
    if (e.scope === "business") return "Todo el negocio";
    if (e.scope === "location") return `${capitalize(t.location)} ${where ?? ""}`.trim();
    const who = staff.find((s) => s.id === e.staffId)?.name ?? capitalize(t.staffMember);
    return where ? `${who} (en ${where})` : who;
  };

  return (
    <div className="settings-stack">
      {canEdit && (
        <div className="settings-toolbar">
          <button type="button" className="btn btn-secondary" onClick={() => setEditing("new")}>
            <Icon id="plus" size={16} />
            Nueva ausencia o feriado
          </button>
        </div>
      )}
      {query.isPending ? (
        <LoadingState />
      ) : query.isError ? (
        <ErrorState message={errorMessage(query.error, "No pudimos cargar las ausencias.")} onRetry={() => void query.refetch()} />
      ) : query.data.length === 0 ? (
        <p className="settings-help">No hay ausencias ni feriados próximos.</p>
      ) : (
        <ul className="settings-list" aria-label="Ausencias y feriados">
          {query.data.map((e) => (
            <li key={e.id} className="settings-item">
              <div className="settings-item-main">
                <span className="settings-item-title">
                  {scopeLabel(e)}
                  {e.reason && <span className="badge badge-muted">{e.reason}</span>}
                </span>
                <span className="settings-item-meta">{formatRange(e.startsAt, e.endsAt, zoneOf(e))}</span>
              </div>
              {canEdit && (
                <div className="settings-item-actions">
                  <button type="button" className="icon-btn" aria-label={`Editar la ausencia: ${scopeLabel(e)}`} onClick={() => setEditing(e)}>
                    <Icon id="pencil" size={18} />
                  </button>
                  <button type="button" className="icon-btn danger" aria-label={`Eliminar la ausencia: ${scopeLabel(e)}`} onClick={() => setDeleting(e)}>
                    <Icon id="trash" size={18} />
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {editing && <TimeOffDialog entry={editing === "new" ? null : editing} staff={staff} locations={locations} onClose={() => setEditing(null)} />}
      {deleting && <DeleteTimeOffDialog entry={deleting} label={scopeLabel(deleting)} onClose={() => setDeleting(null)} />}
    </div>
  );
}

function TimeOffDialog({ entry, staff, locations, onClose }: { entry: TimeOffEntry | null; staff: StaffView[]; locations: LocationView[]; onClose: () => void }) {
  const me = useSession();
  const t = terminologyOf(me);
  const qc = useQueryClient();
  const { showToast } = useToast();
  const restricted = !me.allLocations;
  const visibleLocations = restricted ? locations.filter((l) => me.locations.some((m) => m.id === l.id)) : locations;

  const initialZone = locations.find((l) => l.id === entry?.locationId)?.timezone ?? me.business.timezone;
  const initialAllDay = entry ? isAllDay(entry.startsAt, entry.endsAt, initialZone) : true;
  const start = entry ? isoToZoned(entry.startsAt, initialZone) : null;
  const end = entry ? isoToZoned(entry.endsAt, initialZone) : null;
  const [scope, setScope] = useState<TimeOffScope>(entry?.scope ?? (restricted ? "location" : "business"));
  const [locationId, setLocationId] = useState(entry?.locationId ?? (restricted ? (visibleLocations[0]?.id ?? "") : ""));
  const [staffId, setStaffId] = useState(entry?.staffId ?? staff.find((s) => s.active)?.id ?? "");
  const [allDay, setAllDay] = useState(initialAllDay);
  const [startDate, setStartDate] = useState(start?.date ?? "");
  const [startTime, setStartTime] = useState(start && !initialAllDay ? start.time : "08:00");
  // En "todo el día" el fin guardado es exclusivo (00:00 del día siguiente): se muestra el último día.
  const [endDate, setEndDate] = useState(end ? (initialAllDay ? addDays(end.date, -1) : end.date) : "");
  const [endTime, setEndTime] = useState(end && !initialAllDay ? end.time : "12:00");
  const [reason, setReason] = useState(entry?.reason ?? "");
  const [localError, setLocalError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: (input: { locationId: string | null; staffId: string | null; startsAt: string; endsAt: string; reason: string | null }) =>
      entry ? settingsApi.updateTimeOff(entry.id, input) : settingsApi.createTimeOff(input),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: SETTINGS_KEYS.timeOff });
      showToast(entry ? "Listo, la ausencia quedó guardada." : "Listo, la ausencia quedó registrada.");
      onClose();
    },
  });

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    const lastDay = endDate || startDate;
    if (!startDate) return setLocalError("Elegí la fecha de inicio.");
    if (scope === "staff" && !staffId) return setLocalError(`Elegí el ${t.staffMember}.`);
    if (scope === "location" && !locationId) return setLocalError(`Elegí la ${t.location}.`);
    const loc = scope === "business" ? null : locationId || null;
    const zone = locations.find((l) => l.id === loc)?.timezone ?? me.business.timezone;
    const startsAt = zonedToIso(startDate, allDay ? "00:00" : startTime, zone);
    const endsAt = allDay ? zonedToIso(addDays(lastDay, 1), "00:00", zone) : zonedToIso(lastDay, endTime, zone);
    if (new Date(endsAt) <= new Date(startsAt)) return setLocalError("El fin tiene que ser después del inicio.");
    setLocalError(null);
    mutation.mutate({ locationId: loc, staffId: scope === "staff" ? staffId : null, startsAt, endsAt, reason: reason.trim() || null });
  }

  const scopeOptions = [
    ...(restricted ? [] : [{ value: "business", label: "Todo el negocio (feriado)" }]),
    { value: "location", label: `Una ${t.location} (cierre)` },
    { value: "staff", label: `Un ${t.staffMember} (vacaciones, incapacidad…)` },
  ];
  return (
    <Dialog open onClose={onClose} title={entry ? "Editar ausencia" : "Nueva ausencia o feriado"} wide>
      <form onSubmit={onSubmit} noValidate>
        <SelectField
          label="¿A quién afecta?"
          value={scope}
          options={scopeOptions}
          onChange={(e) => {
            const next = e.target.value as TimeOffScope;
            setScope(next);
            // Un cierre necesita una sucursal elegida (el select no ofrece "todas").
            if (next === "location" && !locationId) setLocationId(visibleLocations[0]?.id ?? "");
          }}
        />
        {scope === "staff" && (
          <SelectField
            label={capitalize(t.staffMember)}
            value={staffId}
            options={staff.map((s) => ({ value: s.id, label: s.name + (s.active ? "" : " (inactivo)") }))}
            error={fieldErrorOf(mutation.error, "staffId")}
            onChange={(e) => setStaffId(e.target.value)}
          />
        )}
        {scope !== "business" && (
          <SelectField
            label={capitalize(t.location)}
            value={locationId}
            options={[...(scope === "staff" && !restricted ? [{ value: "", label: `Todas sus ${t.locations}` }] : []), ...visibleLocations.map((l) => ({ value: l.id, label: l.name }))]}
            error={fieldErrorOf(mutation.error, "locationId")}
            onChange={(e) => setLocationId(e.target.value)}
          />
        )}
        <div className="field">
          <CheckRow label="Todo el día" checked={allDay} onChange={setAllDay} />
        </div>
        <div className="form-grid">
          <TextField label={allDay ? "Desde el día" : "Fecha de inicio"} type="date" value={startDate} error={fieldErrorOf(mutation.error, "startsAt")} onChange={(e) => setStartDate(e.target.value)} />
          {!allDay && <TextField label="Hora de inicio" type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} />}
          <TextField
            label={allDay ? "Hasta el día (incluido)" : "Fecha de fin"}
            type="date"
            value={endDate}
            hint={allDay ? "Vacío = un solo día." : undefined}
            error={fieldErrorOf(mutation.error, "endsAt")}
            onChange={(e) => setEndDate(e.target.value)}
          />
          {!allDay && <TextField label="Hora de fin" type="time" value={endTime} onChange={(e) => setEndTime(e.target.value)} />}
        </div>
        <TextField label="Motivo (opcional)" value={reason} maxLength={200} placeholder="Feriado, vacaciones, capacitación…" onChange={(e) => setReason(e.target.value)} />
        <FormError message={localError ?? mutationError(mutation.error)} />
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

function DeleteTimeOffDialog({ entry, label, onClose }: { entry: TimeOffEntry; label: string; onClose: () => void }) {
  const qc = useQueryClient();
  const { showToast } = useToast();
  const mutation = useMutation({
    mutationFn: () => settingsApi.deleteTimeOff(entry.id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: SETTINGS_KEYS.timeOff });
      showToast("La ausencia quedó eliminada.");
      onClose();
    },
  });
  return (
    <ConfirmDialog
      open
      title="¿Eliminar la ausencia?"
      confirmLabel="Eliminar"
      danger
      pending={mutation.isPending}
      error={mutationError(mutation.error)}
      onConfirm={() => mutation.mutate()}
      onClose={onClose}
    >
      <p>{label}: esos días vuelven a quedar disponibles en la agenda.</p>
    </ConfirmDialog>
  );
}
