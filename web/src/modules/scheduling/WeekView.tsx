import { capitalize, terminologyOf } from "../../app/navigation";
import { useSession } from "../../app/session";
import { isoToZoned } from "../settings/zonedTime";
import { formatShortDate, formatTime, STATUS_LABEL, todayIn } from "./format";
import type { Appointment } from "./schedulingApi";

interface Props {
  days: string[];
  timeZone: string;
  appointments: Appointment[];
  staffColors: Map<string, string | null>;
  onSelect: (appointment: Appointment) => void;
  onOpenDay: (date: string) => void;
}

/** Vista semana: lunes a domingo, cada día con sus citas por hora (en el celular, una debajo de otra). */
export default function WeekView({ days, timeZone, appointments, staffColors, onSelect, onOpenDay }: Props) {
  const me = useSession();
  const t = terminologyOf(me);
  const today = todayIn(timeZone);
  const byDay = new Map<string, Appointment[]>(days.map((d) => [d, []]));
  for (const a of appointments) byDay.get(isoToZoned(a.startsAt, timeZone).date)?.push(a);

  return (
    <div className="week-view">
      {days.map((date) => {
        const list = (byDay.get(date) ?? []).sort((x, y) => x.startsAt.localeCompare(y.startsAt));
        const label = capitalize(formatShortDate(date));
        return (
          <section key={date} className={"week-day" + (date === today ? " week-day-today" : "")} aria-label={label}>
            <h3 className="week-day-title">
              <button type="button" className="week-day-link" onClick={() => onOpenDay(date)} aria-label={`Ver el día ${label}`}>
                {label}
              </button>
              <span className="muted">{list.length || ""}</span>
            </h3>
            {list.length === 0 ? (
              <p className="muted week-empty">Sin {t.appointments}</p>
            ) : (
              <ul className="week-list">
                {list.map((a) => (
                  <li key={a.id}>
                    <button
                      type="button"
                      className={`week-item status-${a.status}`}
                      style={{ ["--staff-color" as string]: staffColors.get(a.staffId) ?? a.staff?.color ?? "var(--accent)" }}
                      onClick={() => onSelect(a)}
                    >
                      <span className="week-item-time tnum">{formatTime(a.startsAt, timeZone)}</span>
                      <span className="week-item-client">{a.client?.name ?? "—"}</span>
                      <span className="week-item-meta">
                        {a.staff?.name ?? ""} · {STATUS_LABEL[a.status]}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        );
      })}
    </div>
  );
}
