import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { ALL_LOCATIONS, useActiveLocation } from "../../app/location";
import { capitalize, getSection, terminologyOf } from "../../app/navigation";
import { useSession } from "../../app/session";
import { errorMessage } from "../../lib/api";
import EmptyState from "../../ui/EmptyState";
import ErrorState from "../../ui/ErrorState";
import Icon from "../../ui/Icons";
import PageHeader from "../../ui/PageHeader";
import { isoToZoned } from "../settings/zonedTime";
import { addDays, weekDates } from "./agendaLayout";
import AppointmentDrawer from "./AppointmentDrawer";
import DayView from "./DayView";
import { dayRange, formatLongDate, formatShortDate, todayIn } from "./format";
import NewAppointmentDialog, { type NewAppointmentDefaults } from "./NewAppointmentDialog";
import { useAgendaSetup, useAppointments, type Appointment } from "./schedulingApi";
import WeekView from "./WeekView";
import "./agenda.css";

type View = "day" | "week";
const RE_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Agenda (/agenda): día con carriles por profesional y semana, de la sucursal activa (con
 * "Todas" se elige una acá). URL enlazable: `?date=AAAA-MM-DD&view=day|week&appointment=<id>`;
 * `?new=1` abre "Nueva cita" (lo usa "+ Nuevo → Cita"). El profesional ve solo su carril.
 */
export default function AgendaPage() {
  const me = useSession();
  const t = terminologyOf(me);
  const section = getSection("agenda");
  const isStaff = me.role === "staff";
  const { selected } = useActiveLocation();
  const [params, setParams] = useSearchParams();
  const setup = useAgendaSetup();

  const locations = (setup.locations.data ?? []).filter((l) => l.active);
  const pinned = selected !== ALL_LOCATIONS ? selected : null;
  const location = locations.find((l) => l.id === (pinned ?? params.get("loc"))) ?? locations[0] ?? null;
  const tz = location?.timezone ?? me.business.timezone;
  const view: View = params.get("view") === "week" ? "week" : "day";
  const rawDate = params.get("date");
  const date = rawDate && RE_DATE.test(rawDate) ? rawDate : todayIn(tz);
  const days = view === "week" ? weekDates(date) : [date];
  const range = useMemo(() => dayRange(days[0], tz, days.length), [days[0], tz, days.length]);

  const appointmentsQuery = useAppointments(range.from, range.to, isStaff ? (me.staffId ?? null) : null);
  const [showCancelled, setShowCancelled] = useState(false);
  const [newDefaults, setNewDefaults] = useState<NewAppointmentDefaults | null>(null);
  const openId = params.get("appointment");

  function update(changes: Record<string, string | null>) {
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        for (const [k, v] of Object.entries(changes)) {
          if (v === null) next.delete(k);
          else next.set(k, v);
        }
        return next;
      },
      { replace: true },
    );
  }

  // "+ Nuevo → Cita" llega con ?new=1: se abre el diálogo y se limpia la URL.
  useEffect(() => {
    if (params.get("new") === "1" && location) {
      setNewDefaults({ locationId: location.id, date });
      update({ new: null });
    }
  }, [params, location?.id]);

  const staffList = setup.staff.data ?? [];
  const lanes = useMemo(() => {
    if (!location) return [];
    const inView = new Set((appointmentsQuery.data ?? []).filter((a) => a.locationId === location.id).map((a) => a.staffId));
    return staffList.filter((s) => {
      if (isStaff) return s.id === me.staffId;
      return (s.active && s.hours.some((h) => h.locationId === location.id)) || inView.has(s.id);
    });
  }, [staffList, location, appointmentsQuery.data, isStaff, me.staffId]);

  const visible = (appointmentsQuery.data ?? []).filter(
    (a) =>
      a.locationId === location?.id &&
      lanes.some((l) => l.id === a.staffId) &&
      (showCancelled || a.status !== "cancelled"),
  );
  const staffColors = new Map(staffList.map((s) => [s.id, s.color]));

  function openNew(extra: Partial<NewAppointmentDefaults> = {}) {
    if (!location) return;
    setNewDefaults({ locationId: location.id, date, ...extra });
  }

  function onCreated(a: Appointment) {
    const d = isoToZoned(a.startsAt, a.location?.timezone ?? tz).date;
    update({ date: d });
  }

  const title = section.label(t, me.role);
  const canCreate = !isStaff || Boolean(me.staffId);
  const header = (
    <PageHeader
      title={title}
      subtitle={location ? `${capitalize(t.location)}: ${location.name}` : undefined}
    >
      {canCreate && location && (
        <button type="button" className="btn btn-primary" onClick={() => openNew()}>
          <Icon id="plus" size={18} strokeWidth={2.2} />
          Nueva {t.appointment}
        </button>
      )}
    </PageHeader>
  );

  if (setup.locations.isPending || setup.staff.isPending || setup.catalog.isPending) {
    return (
      <div className="page page-wide">
        {header}
        <div className="clients-loading" role="status">
          <div className="spinner" aria-hidden="true" />
          <span>Cargando la agenda…</span>
        </div>
      </div>
    );
  }
  if (setup.locations.isError || setup.staff.isError || setup.catalog.isError) {
    return (
      <div className="page page-wide">
        {header}
        <ErrorState
          message="No pudimos cargar la agenda."
          onRetry={() => {
            void setup.locations.refetch();
            void setup.staff.refetch();
            void setup.catalog.refetch();
          }}
        />
      </div>
    );
  }
  if (!location) {
    return (
      <div className="page page-wide">
        {header}
        <EmptyState icon="mapPin" title={`No hay ${t.locations} activas`} help={`Activá una ${t.location} en Configuración para usar la agenda.`} />
      </div>
    );
  }
  if (isStaff && !me.staffId) {
    return (
      <div className="page page-wide">
        {header}
        <EmptyState
          icon="calendar"
          title={`Tu usuario no está vinculado a un ${t.staffMember}`}
          help={`Pedile a quien administra el negocio que te vincule en Configuración › Equipo para ver tus ${t.appointments}.`}
        />
      </div>
    );
  }

  const step = view === "week" ? 7 : 1;
  const label = view === "week" ? `${formatShortDate(days[0])} – ${formatShortDate(days[6])}` : capitalize(formatLongDate(date));
  const today = todayIn(tz);

  return (
    <div className="page page-wide">
      {header}
      <div className="agenda-toolbar">
        <div className="agenda-nav" role="group" aria-label="Fecha">
          <button type="button" className="icon-btn agenda-nav-btn" onClick={() => update({ date: addDays(date, -step) })} aria-label={view === "week" ? "Semana anterior" : "Día anterior"}>
            <Icon id="chevronLeft" size={18} />
          </button>
          <button type="button" className="btn btn-secondary btn-small" onClick={() => update({ date: null })} disabled={date === today && view === "day"}>
            Hoy
          </button>
          <button type="button" className="icon-btn agenda-nav-btn agenda-next" onClick={() => update({ date: addDays(date, step) })} aria-label={view === "week" ? "Semana siguiente" : "Día siguiente"}>
            <Icon id="chevronLeft" size={18} />
          </button>
          <h2 className="agenda-date" aria-live="polite">
            {label}
          </h2>
          <label className="agenda-jump">
            <span className="visually-hidden">Ir a la fecha</span>
            <input type="date" className="input" value={date} onChange={(e) => e.target.value && update({ date: e.target.value })} />
          </label>
        </div>
        <div className="agenda-options">
          {!pinned && locations.length > 1 && (
            <label className="agenda-location">
              <span className="field-label">{capitalize(t.location)}</span>
              <select className="input select" value={location.id} onChange={(e) => update({ loc: e.target.value })}>
                {locations.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <div className="segmented" role="group" aria-label="Vista">
            <button type="button" aria-pressed={view === "day"} onClick={() => update({ view: null })}>
              Día
            </button>
            <button type="button" aria-pressed={view === "week"} onClick={() => update({ view: "week" })}>
              Semana
            </button>
          </div>
          <label className="check-inline">
            <input type="checkbox" checked={showCancelled} onChange={(e) => setShowCancelled(e.target.checked)} />
            Ver canceladas
          </label>
        </div>
      </div>

      {appointmentsQuery.isError ? (
        <ErrorState message={errorMessage(appointmentsQuery.error, `No pudimos cargar las ${t.appointments}.`)} onRetry={() => void appointmentsQuery.refetch()} />
      ) : (
        <div className={appointmentsQuery.isFetching && appointmentsQuery.isPlaceholderData ? "agenda-body agenda-loading" : "agenda-body"} aria-busy={appointmentsQuery.isPending}>
          {view === "day" ? (
            <DayView
              date={date}
              location={location}
              lanes={lanes}
              appointments={visible}
              onSelect={(a) => update({ appointment: a.id })}
              onCreateAt={canCreate ? (staffId, startsAt) => openNew({ staffId, startsAt, date }) : null}
            />
          ) : (
            <WeekView
              days={days}
              timeZone={tz}
              appointments={visible}
              staffColors={staffColors}
              onSelect={(a) => update({ appointment: a.id })}
              onOpenDay={(d) => update({ date: d, view: null })}
            />
          )}
        </div>
      )}

      <AppointmentDrawer
        appointmentId={openId}
        onClose={() => update({ appointment: null })}
        staff={staffList}
        onMoved={(a) => update({ date: isoToZoned(a.startsAt, a.location?.timezone ?? tz).date })}
      />
      <NewAppointmentDialog
        open={newDefaults !== null}
        onClose={() => setNewDefaults(null)}
        defaults={newDefaults ?? {}}
        locations={setup.locations.data ?? []}
        staff={staffList}
        services={setup.catalog.data?.services ?? []}
        onCreated={onCreated}
      />
    </div>
  );
}
