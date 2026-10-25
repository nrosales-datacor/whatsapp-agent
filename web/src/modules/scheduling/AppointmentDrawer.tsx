import { useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { useMutation } from "@tanstack/react-query";
import { capitalize, terminologyOf } from "../../app/navigation";
import { useSession } from "../../app/session";
import { errorMessage, isApiError } from "../../lib/api";
import { formatCents } from "../../lib/money";
import Drawer from "../../ui/Drawer";
import { FormError, SelectField, TextField } from "../../ui/Field";
import { useToast } from "../../ui/Toast";
import { formatPhone } from "../clients/format";
import AppointmentBalance from "../sales/AppointmentBalance";
import type { StaffView } from "../settings/settingsApi";
import { isoToZoned } from "../settings/zonedTime";
import { CHANNEL_LABEL, formatLongDate, formatMinutes, formatTime, formatWhen, isActive, STATUS_LABEL } from "./format";
import AppointmentFields, { customDataFrom, draftsOf, useAppointmentFields, type FieldDrafts } from "./AppointmentFields";
import { schedulingApi, useAppointment, useAppointmentStore, type Appointment, type Slot } from "./schedulingApi";
import SlotPicker from "./SlotPicker";

interface Props {
  appointmentId: string | null;
  onClose: () => void;
  staff: StaffView[];
  /** Al reprogramar a otro día, la agenda puede ir a esa fecha. */
  onMoved?: (appointment: Appointment) => void;
}

type Mode = "view" | "cancel" | "reschedule" | "assign";

type RunAction = (fn: () => Promise<Appointment>, message: string | ((a: Appointment) => string), after?: (a: Appointment) => void) => void;

/** Detalle de una cita en un panel lateral, con las acciones que permite su estado y el rol. */
export default function AppointmentDrawer({ appointmentId, onClose, staff, onMoved }: Props) {
  const me = useSession();
  const t = terminologyOf(me);
  const query = useAppointment(appointmentId);
  const appointment = query.data;
  const [mode, setMode] = useState<Mode>("view");
  const { showToast } = useToast();
  const store = useAppointmentStore();
  // La mutación vive acá (no en el detalle, que se vuelve a montar con cada cambio de la cita).
  const action = useMutation({
    mutationFn: async (fn: () => Promise<Appointment>) => fn(),
    onSuccess: (updated) => store(updated),
  });

  useEffect(() => {
    setMode("view");
    action.reset();
  }, [appointmentId]);

  const run: RunAction = (fn, message, after) =>
    action.mutate(fn, {
      onSuccess: (updated) => {
        showToast(typeof message === "function" ? message(updated) : message);
        setMode("view");
        after?.(updated);
      },
    });

  const title = appointment?.client?.name ?? capitalize(t.appointment);
  const tz = appointment?.location?.timezone ?? me.business.timezone;

  return (
    <Drawer
      open={Boolean(appointmentId)}
      onClose={onClose}
      title={title}
      subtitle={appointment ? `${capitalize(formatLongDate(isoToZoned(appointment.startsAt, tz).date))}, ${formatTime(appointment.startsAt, tz)}` : undefined}
    >
      {query.isPending ? (
        <div className="clients-loading" role="status">
          <div className="spinner" aria-hidden="true" />
          <span>Cargando la {t.appointment}…</span>
        </div>
      ) : query.isError || !appointment ? (
        <p className="field-error" role="alert">
          {errorMessage(query.error, `No pudimos cargar la ${t.appointment}.`)}
        </p>
      ) : (
        <AppointmentDetail
          key={`${appointment.id}:${appointment.updatedAt}`}
          appointment={appointment}
          staff={staff}
          mode={mode}
          setMode={setMode}
          onMoved={onMoved}
          run={run}
          pending={action.isPending}
          error={action.isError ? action.error : null}
        />
      )}
    </Drawer>
  );
}

function AppointmentDetail({
  appointment,
  staff,
  mode,
  setMode,
  onMoved,
  run,
  pending,
  error,
}: {
  appointment: Appointment;
  staff: StaffView[];
  mode: Mode;
  setMode: (m: Mode) => void;
  onMoved?: (appointment: Appointment) => void;
  run: RunAction;
  pending: boolean;
  error: unknown;
}) {
  const me = useSession();
  const t = terminologyOf(me);
  const tz = appointment.location?.timezone ?? me.business.timezone;
  const started = new Date(appointment.startsAt).getTime() <= Date.now();
  const active = isActive(appointment.status);
  const canAssign = me.role !== "staff";
  const [notes, setNotes] = useState(appointment.notes ?? "");

  const notesDirty = (appointment.notes ?? "") !== notes.trim();
  const fields = useAppointmentFields();
  const [drafts, setDrafts] = useState<FieldDrafts>(() => draftsOf(fields, appointment.customData));
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  // Los campos llegan después de la cita (otra consulta) o lo guardado cambia: el borrador se
  // rehace. Por el contenido (no la identidad): un refresco con lo mismo no borra lo que se edita.
  const storedKey = JSON.stringify(appointment.customData ?? {});
  useEffect(() => setDrafts(draftsOf(fields, appointment.customData)), [fields, storedKey]);
  const customChanges = customDataFrom(fields, drafts, appointment.customData ?? {});
  const fieldsDirty = Object.keys(customChanges.data).length > 0 || Object.keys(customChanges.errors).length > 0;
  const apiFieldError = isApiError(error) ? (key: string) => error.fieldError(`customData.${key}`) : () => undefined;
  const occupied = Math.round((new Date(appointment.endsAt).getTime() - new Date(appointment.startsAt).getTime()) / 60_000);

  return (
    <div className="appt-detail">
      <div className="appt-detail-status">
        <span className={`status-badge status-${appointment.status}`}>{STATUS_LABEL[appointment.status]}</span>
        <span className="muted">{CHANNEL_LABEL[appointment.channel]}</span>
      </div>

      <dl className="appt-facts">
        <div>
          <dt>Horario</dt>
          <dd>
            {formatTime(appointment.startsAt, tz)} – {formatTime(appointment.endsAt, tz)} <span className="muted">({formatMinutes(occupied)})</span>
          </dd>
        </div>
        <div>
          <dt>{capitalize(t.staffMember)}</dt>
          <dd>
            <span className="staff-dot" style={{ background: appointment.staff?.color ?? "var(--accent)" }} aria-hidden="true" />
            {appointment.staff?.name ?? "—"}
          </dd>
        </div>
        <div>
          <dt>{capitalize(t.location)}</dt>
          <dd>{appointment.location?.name ?? "—"}</dd>
        </div>
        <div>
          <dt>{capitalize(t.client)}</dt>
          <dd>
            {appointment.client ? (
              <Link className="link" to={`/clients/${appointment.client.id}`}>
                {appointment.client.name}
              </Link>
            ) : (
              "—"
            )}
            {appointment.client?.phone && <span className="muted"> · {formatPhone(appointment.client.phone)}</span>}
          </dd>
        </div>
      </dl>

      <div className="appt-lines">
        <p className="field-label">Servicios</p>
        <ul>
          {appointment.services.map((l) => (
            <li key={l.id}>
              <span>{l.name}</span>
              <span className="muted tnum">
                {formatMinutes(l.durationMin)} · {formatCents(l.priceCents, me.business.currency)}
              </span>
            </li>
          ))}
        </ul>
        <p className="appt-total">
          <span>Total</span>
          <span className="tnum">{formatCents(appointment.totalCents, me.business.currency)}</span>
        </p>
      </div>

      {/* Saldo y "Cobrar" (I4): solo con el módulo Ventas en el plan. */}
      {me.modules.includes("sales") && <AppointmentBalance appointment={appointment} />}

      {appointment.status === "cancelled" && (
        <p className="appt-note">
          Cancelada{appointment.cancelledAt ? ` el ${formatWhen(appointment.cancelledAt, tz)}` : ""}
          {appointment.cancellationReason ? `: «${appointment.cancellationReason}»` : "."}
        </p>
      )}

      <form
        className="appt-notes"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          if (notesDirty) run(() => schedulingApi.updateNotes(appointment.id, notes.trim() || null), "Notas guardadas.");
        }}
      >
        <label className="field-label" htmlFor={`notes-${appointment.id}`}>
          Notas
        </label>
        <textarea id={`notes-${appointment.id}`} className="input" rows={3} maxLength={2000} value={notes} onChange={(e) => setNotes(e.target.value)} />
        {notesDirty && (
          <button type="submit" className="btn btn-secondary btn-small" disabled={pending}>
            Guardar notas
          </button>
        )}
      </form>

      {fields.length > 0 && (
        <form
          className="appt-notes"
          aria-label={`Datos de la ${t.appointment}`}
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            setFieldErrors(customChanges.errors);
            if (Object.keys(customChanges.errors).length > 0 || Object.keys(customChanges.data).length === 0) return;
            run(() => schedulingApi.updateCustomData(appointment.id, customChanges.data), "Datos guardados.");
          }}
        >
          <p className="field-label">Datos de la {t.appointment}</p>
          <AppointmentFields
            fields={fields}
            drafts={drafts}
            disabled={pending}
            onChange={(key, value) => {
              setDrafts((d) => ({ ...d, [key]: value }));
              setFieldErrors((e) => ({ ...e, [`customData.${key}`]: "" }));
            }}
            errorFor={(key) => fieldErrors[`customData.${key}`] || apiFieldError(key)}
          />
          {fieldsDirty && (
            <button type="submit" className="btn btn-secondary btn-small" disabled={pending}>
              Guardar datos
            </button>
          )}
        </form>
      )}

      {mode === "cancel" && <CancelForm appointment={appointment} onCancel={() => setMode("view")} onDone={(reason) => run(() => schedulingApi.cancel(appointment.id, reason), `${capitalize(t.appointment)} cancelada.`)} pending={pending} />}
      {mode === "reschedule" && (
        <RescheduleForm
          appointment={appointment}
          onCancel={() => setMode("view")}
          pending={pending}
          onDone={(slot) =>
            run(
              () => schedulingApi.reschedule(appointment.id, slot.startsAt),
              (moved) => `${capitalize(t.appointment)} movida a ${formatWhen(moved.startsAt, tz)}`,
              onMoved,
            )
          }
        />
      )}
      {mode === "assign" && (
        <AssignForm appointment={appointment} staff={staff} onCancel={() => setMode("view")} pending={pending} onDone={(staffId) => run(() => schedulingApi.assign(appointment.id, staffId), "Listo, quedó reasignada.")} />
      )}

      <FormError message={error ? actionError(error) : null} />

      {mode === "view" && active && (
        <div className="appt-actions" role="group" aria-label={`Acciones de la ${t.appointment}`}>
          {appointment.status === "pending" && (
            <button type="button" className="btn btn-primary" disabled={pending} onClick={() => run(() => schedulingApi.confirm(appointment.id), `${capitalize(t.appointment)} confirmada.`)}>
              Confirmar
            </button>
          )}
          <button
            type="button"
            className={appointment.status === "confirmed" ? "btn btn-primary" : "btn btn-secondary"}
            disabled={pending || !started}
            title={started ? undefined : "Se puede completar cuando ya empezó."}
            onClick={() => run(() => schedulingApi.complete(appointment.id), `${capitalize(t.appointment)} completada.`)}
          >
            Completar
          </button>
          <button
            type="button"
            className="btn btn-secondary"
            disabled={pending || !started}
            title={started ? undefined : "Se puede marcar cuando ya empezó."}
            onClick={() => run(() => schedulingApi.noShow(appointment.id), "Marcada como no asistió.")}
          >
            No asistió
          </button>
          <button type="button" className="btn btn-secondary" onClick={() => setMode("reschedule")}>
            Reprogramar
          </button>
          {canAssign && (
            <button type="button" className="btn btn-secondary" onClick={() => setMode("assign")}>
              Reasignar
            </button>
          )}
          <button type="button" className="btn btn-secondary btn-danger-outline" onClick={() => setMode("cancel")}>
            Cancelar {t.appointment}
          </button>
          {!started && <p className="muted appt-actions-hint">Completar y «No asistió» se habilitan cuando la {t.appointment} empieza.</p>}
        </div>
      )}
    </div>
  );
}

function actionError(error: unknown): string {
  if (isApiError(error, "slot_taken")) return "Ese horario se acaba de ocupar. Elegí otro.";
  if (isApiError(error)) return error.fieldError("startsAt") ?? error.fieldError("staffId") ?? error.message;
  return errorMessage(error);
}

function CancelForm({ appointment, onCancel, onDone, pending }: { appointment: Appointment; onCancel: () => void; onDone: (reason: string) => void; pending: boolean }) {
  const me = useSession();
  const t = terminologyOf(me);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | undefined>();
  return (
    <form
      className="appt-subform"
      onSubmit={(e) => {
        e.preventDefault();
        if (!reason.trim()) return setError("Contanos el motivo (queda en el historial).");
        onDone(reason.trim());
      }}
    >
      <p className="appt-subform-title">Cancelar la {t.appointment} de {appointment.client?.name ?? `este ${t.client}`}</p>
      <TextField label="Motivo" value={reason} maxLength={500} autoFocus error={error} onChange={(e) => setReason(e.target.value)} />
      <div className="quick-client-actions">
        <button type="button" className="btn btn-secondary btn-small" onClick={onCancel}>
          Volver
        </button>
        <button type="submit" className="btn btn-danger btn-small" disabled={pending}>
          {pending ? "Cancelando…" : `Cancelar ${t.appointment}`}
        </button>
      </div>
    </form>
  );
}

function RescheduleForm({ appointment, onCancel, onDone, pending }: { appointment: Appointment; onCancel: () => void; onDone: (slot: Slot) => void; pending: boolean }) {
  const me = useSession();
  const t = terminologyOf(me);
  const tz = appointment.location?.timezone ?? me.business.timezone;
  const [date, setDate] = useState(isoToZoned(appointment.startsAt, tz).date);
  const [slot, setSlot] = useState<Slot | null>(null);
  const serviceIds = appointment.services.map((l) => l.serviceId);
  const missing = serviceIds.some((id) => !id);
  const params = missing
    ? null
    : { locationId: appointment.locationId, date, serviceIds: serviceIds as string[], staffId: appointment.staffId, excludeAppointmentId: appointment.id };
  return (
    <div className="appt-subform">
      <p className="appt-subform-title">
        Reprogramar con {appointment.staff?.name ?? `el mismo ${t.staffMember}`}
      </p>
      {missing ? (
        <p className="muted">Alguno de los servicios ya no existe: cancelá esta {t.appointment} y agendá una nueva.</p>
      ) : (
        <>
          <TextField
            label="Nueva fecha"
            type="date"
            value={date}
            onChange={(e) => {
              setDate(e.target.value);
              setSlot(null);
            }}
          />
          <div className="field">
            <SlotPicker params={params} timeZone={tz} value={slot?.startsAt ?? null} onChange={setSlot} label="Horarios para reprogramar" />
          </div>
        </>
      )}
      <div className="quick-client-actions">
        <button type="button" className="btn btn-secondary btn-small" onClick={onCancel}>
          Volver
        </button>
        <button type="button" className="btn btn-primary btn-small" disabled={!slot || pending} onClick={() => slot && onDone(slot)}>
          {pending ? "Moviendo…" : slot ? `Mover a las ${formatTime(slot.startsAt, tz)}` : "Elegí un horario"}
        </button>
      </div>
    </div>
  );
}

function AssignForm({
  appointment,
  staff,
  onCancel,
  onDone,
  pending,
}: {
  appointment: Appointment;
  staff: StaffView[];
  onCancel: () => void;
  onDone: (staffId: string) => void;
  pending: boolean;
}) {
  const me = useSession();
  const t = terminologyOf(me);
  const options = staff.filter((s) => s.active && s.id !== appointment.staffId && s.hours.some((h) => h.locationId === appointment.locationId));
  const [staffId, setStaffId] = useState(options[0]?.id ?? "");
  return (
    <div className="appt-subform">
      <p className="appt-subform-title">Pasar a otro {t.staffMember} (misma hora)</p>
      {options.length === 0 ? (
        <p className="muted">No hay otro {t.staffMember} con horario en esta {t.location}.</p>
      ) : (
        <SelectField label={capitalize(t.staffMember)} value={staffId} onChange={(e) => setStaffId(e.target.value)} options={options.map((s) => ({ value: s.id, label: s.name }))} />
      )}
      <p className="field-hint">Si esa persona tiene otra duración o precio para estos servicios, se actualizan.</p>
      <div className="quick-client-actions">
        <button type="button" className="btn btn-secondary btn-small" onClick={onCancel}>
          Volver
        </button>
        <button type="button" className="btn btn-primary btn-small" disabled={!staffId || pending} onClick={() => onDone(staffId)}>
          {pending ? "Reasignando…" : "Reasignar"}
        </button>
      </div>
    </div>
  );
}
