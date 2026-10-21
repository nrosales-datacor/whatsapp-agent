import { useEffect, useState, type MouseEvent } from "react";
import { capitalize, terminologyOf } from "../../app/navigation";
import { useSession } from "../../app/session";
import type { LocationView, StaffView } from "../settings/settingsApi";
import { zonedToIso } from "../settings/zonedTime";
import { gridRange, hhmm, layoutColumns, weekdayOf, workingWindows, type Span } from "./agendaLayout";
import { formatTime, minuteOfDay, STATUS_LABEL, todayIn } from "./format";
import type { Appointment } from "./schedulingApi";

/** Alto de una hora en la rejilla (px). */
const HOUR_PX = 72;
const PX_PER_MIN = HOUR_PX / 60;
/** Clic en un hueco: se redondea a esta grilla. */
const CLICK_STEP_MIN = 15;

interface Props {
  date: string;
  location: LocationView;
  lanes: StaffView[];
  appointments: Appointment[];
  onSelect: (appointment: Appointment) => void;
  /** Clic en un hueco de un carril (null = solo lectura). */
  onCreateAt: ((staffId: string, startsAt: string) => void) | null;
}

interface Placed extends Span {
  appointment: Appointment;
}

/**
 * Vista día: una columna (carril) por profesional, sobre una rejilla con el horario de la
 * sucursal. Las horas en que el profesional no atiende quedan sombreadas; cada cita es un
 * bloque con el color del profesional y su estado.
 */
export default function DayView({ date, location, lanes, appointments, onSelect, onCreateAt }: Props) {
  const me = useSession();
  const t = terminologyOf(me);
  const tz = location.timezone;
  const weekday = weekdayOf(date);
  const placed: Placed[] = appointments.map((a) => {
    const startMin = minuteOfDay(a.startsAt, tz);
    const length = Math.max(15, Math.round((new Date(a.endsAt).getTime() - new Date(a.startsAt).getTime()) / 60_000));
    return { appointment: a, startMin, endMin: Math.min(24 * 60, startMin + length) };
  });
  const grid = gridRange(location.hours, weekday, placed);
  const height = (grid.endMin - grid.startMin) * PX_PER_MIN;
  const hours: number[] = [];
  for (let m = grid.startMin; m < grid.endMin; m += 60) hours.push(m);
  const closed = !location.hours.some((h) => h.weekday === weekday);

  // Línea de "ahora" (si el día mostrado es hoy en la sucursal), refrescada cada minuto.
  const [nowMin, setNowMin] = useState(() => minuteOfDay(new Date().toISOString(), tz));
  useEffect(() => {
    const timer = window.setInterval(() => setNowMin(minuteOfDay(new Date().toISOString(), tz)), 60_000);
    return () => window.clearInterval(timer);
  }, [tz]);
  const isToday = todayIn(tz) === date;

  function clickLane(e: MouseEvent<HTMLDivElement>, staffId: string) {
    if (!onCreateAt || e.target !== e.currentTarget) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const minute = grid.startMin + (e.clientY - rect.top) / PX_PER_MIN;
    const rounded = Math.floor(minute / CLICK_STEP_MIN) * CLICK_STEP_MIN;
    onCreateAt(staffId, zonedToIso(date, hhmm(rounded), tz));
  }

  return (
    <div className="day-view">
      {closed && <p className="day-closed">La {t.location} no abre este día según su horario.</p>}
      <div className="day-scroll" role="region" aria-label={`${capitalize(t.appointments)} del día por ${t.staffMember}`} tabIndex={0}>
        <div className="day-grid" style={{ gridTemplateColumns: `56px repeat(${Math.max(lanes.length, 1)}, minmax(150px, 1fr))` }}>
          <div className="day-corner" aria-hidden="true" />
          {lanes.map((s) => (
            <div key={s.id} className="lane-header">
              <span className="staff-dot" style={{ background: s.color ?? "var(--accent)" }} aria-hidden="true" />
              <span className="lane-name">{s.name}</span>
            </div>
          ))}
          {lanes.length === 0 && <div className="lane-header muted">Sin {t.staff} con horario</div>}

          <div className="time-gutter" style={{ height }} aria-hidden="true">
            {hours.map((m) => (
              <span key={m} className="time-label" style={{ top: (m - grid.startMin) * PX_PER_MIN }}>
                {hhmm(m)}
              </span>
            ))}
          </div>

          {lanes.map((s) => {
            const windows = workingWindows(location.hours, s.hours.filter((h) => h.locationId === location.id), weekday);
            const mine = layoutColumns(placed.filter((p) => p.appointment.staffId === s.id));
            return (
              <div
                key={s.id}
                className={"lane" + (onCreateAt ? " lane-clickable" : "")}
                style={{ height }}
                onClick={(e) => clickLane(e, s.id)}
                data-staff-id={s.id}
                aria-label={`Carril de ${s.name}`}
                role="group"
              >
                {windows.map((w) => (
                  <div
                    key={w.startMin}
                    className="lane-open"
                    style={{ top: (w.startMin - grid.startMin) * PX_PER_MIN, height: (w.endMin - w.startMin) * PX_PER_MIN }}
                    aria-hidden="true"
                  />
                ))}
                {hours.map((m) => (
                  <div key={m} className="lane-hour-line" style={{ top: (m - grid.startMin) * PX_PER_MIN }} aria-hidden="true" />
                ))}
                {mine.map((p) => {
                  const a = p.appointment;
                  const top = (p.startMin - grid.startMin) * PX_PER_MIN;
                  const blockHeight = Math.max(24, (p.endMin - p.startMin) * PX_PER_MIN - 2);
                  const services = a.services.map((l) => l.name).join(" + ");
                  return (
                    <button
                      key={a.id}
                      type="button"
                      className={`appt-block status-${a.status}`}
                      style={{
                        top,
                        height: blockHeight,
                        left: `calc(${(100 / p.columns) * p.column}% + 3px)`,
                        width: `calc(${100 / p.columns}% - 6px)`,
                        ["--staff-color" as string]: s.color ?? "var(--accent)",
                      }}
                      onClick={() => onSelect(a)}
                      aria-label={`${formatTime(a.startsAt, tz)}, ${a.client?.name ?? capitalize(t.client)}, ${services}, ${STATUS_LABEL[a.status]}`}
                    >
                      <span className="appt-block-time">
                        {formatTime(a.startsAt, tz)}
                        <span className="appt-block-status">{STATUS_LABEL[a.status]}</span>
                      </span>
                      <span className="appt-block-client">{a.client?.name ?? "—"}</span>
                      {blockHeight > 48 && <span className="appt-block-services">{services}</span>}
                    </button>
                  );
                })}
                {isToday && nowMin >= grid.startMin && nowMin <= grid.endMin && (
                  <div className="now-line" style={{ top: (nowMin - grid.startMin) * PX_PER_MIN }} aria-hidden="true" />
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
