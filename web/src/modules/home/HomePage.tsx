import { Link } from "react-router-dom";
import { ALL_LOCATIONS, useActiveLocation } from "../../app/location";
import { capitalize, terminologyOf } from "../../app/navigation";
import { useSession } from "../../app/session";
import { errorMessage } from "../../lib/api";
import type { Terminology } from "../../lib/contract";
import ErrorState from "../../ui/ErrorState";
import Icon from "../../ui/Icons";
import PageHeader from "../../ui/PageHeader";
import { useToast } from "../../ui/Toast";
import { isoToZoned } from "../settings/zonedTime";
import { formatLongDate, formatTime, formatWhen, STATUS_LABEL } from "../scheduling/format";
import { schedulingApi, useAppointmentStore, useHomeToday, type Appointment, type AppointmentStatus } from "../scheduling/schedulingApi";
import "../scheduling/agenda.css";
import "./home.css";

const STATUS_ORDER: AppointmentStatus[] = ["pending", "confirmed", "completed", "no_show", "cancelled"];

/** Enlace a una cita en la agenda (abre su detalle en el día que corresponde). */
function agendaLink(a: Appointment, timeZone: string): string {
  const date = isoToZoned(a.startsAt, a.location?.timezone ?? timeZone).date;
  return `/agenda?date=${date}&appointment=${a.id}`;
}

/**
 * Inicio básico (/): el día de la sucursal activa (o de todas): citas de hoy por estado,
 * próximas, sin confirmar de hoy y mañana, no-show de hoy y lo que agendó el agente esta
 * semana (si el plan trae WhatsApp IA). El Inicio completo del Pro llega en I5.
 */
export default function HomePage() {
  const me = useSession();
  const t = terminologyOf(me);
  const { selected, label } = useActiveLocation();
  const query = useHomeToday();
  const hasWhatsapp = me.modules.includes("whatsapp");
  const subtitle = selected === ALL_LOCATIONS ? label : `${capitalize(t.location)}: ${label}`;

  if (query.isPending) {
    return (
      <div className="page">
        <PageHeader title="Inicio" subtitle={subtitle} />
        <div className="clients-loading" role="status">
          <div className="spinner" aria-hidden="true" />
          <span>Cargando tu día…</span>
        </div>
      </div>
    );
  }
  if (query.isError) {
    return (
      <div className="page">
        <PageHeader title="Inicio" subtitle={subtitle} />
        <ErrorState message={errorMessage(query.error, "No pudimos cargar el resumen del día.")} onRetry={() => void query.refetch()} />
      </div>
    );
  }

  const home = query.data;
  const tz = home.timezone;
  return (
    <div className="page">
      <PageHeader title="Inicio" subtitle={subtitle}>
        <Link className="btn btn-secondary" to="/agenda">
          <Icon id="calendar" size={18} />
          Ver agenda
        </Link>
      </PageHeader>

      <div className="home-grid">
        <section className="card home-card home-today" aria-labelledby="home-today-title">
          <h2 id="home-today-title" className="card-title">
            {capitalize(t.appointments)} de hoy
          </h2>
          <p className="muted">{capitalize(formatLongDate(home.date))}</p>
          <p className="home-big tnum">{home.today.total}</p>
          <ul className="home-status-list">
            {STATUS_ORDER.map((s) => (
              <li key={s}>
                <span className={`status-badge status-${s}`}>{STATUS_LABEL[s]}</span>
                <span className="tnum">{home.today.byStatus[s] ?? 0}</span>
              </li>
            ))}
          </ul>
        </section>

        <AppointmentCard
          id="home-upcoming"
          title={`Próximas ${t.appointments}`}
          empty={`No hay más ${t.appointments} en los próximos días.`}
          items={home.upcoming}
          timeZone={tz}
          t={t}
        />
        <AppointmentCard
          id="home-unconfirmed"
          title="Sin confirmar (hoy y mañana)"
          empty={`Todas las ${t.appointments} de hoy y mañana están confirmadas.`}
          items={home.unconfirmed}
          timeZone={tz}
          t={t}
          confirmable
        />
        <AppointmentCard id="home-noshow" title="No asistieron hoy" empty="Nadie faltó hoy." items={home.noShowsToday} timeZone={tz} t={t} />

        {hasWhatsapp && (
          <section className="card home-card" aria-labelledby="home-ai-title">
            <h2 id="home-ai-title" className="card-title">
              Agendadas por el agente esta semana
            </h2>
            <p className="home-big tnum">{home.aiBookings.count}</p>
            {home.aiBookings.recent.length > 0 ? (
              <ul className="home-list">
                {home.aiBookings.recent.map((a) => (
                  <li key={a.id}>
                    <Link className="home-item home-item-simple" to={agendaLink(a, tz)}>
                      <span className="home-item-main">{a.client?.name ?? "—"}</span>
                      <span className="muted">{formatWhen(a.startsAt, a.location?.timezone ?? tz)}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted">Cuando el agente de WhatsApp agende, lo vas a ver acá.</p>
            )}
          </section>
        )}
        {hasWhatsapp && (
          <section className="card home-card" aria-labelledby="home-conv-title">
            <h2 id="home-conv-title" className="card-title">
              Conversaciones esperando
            </h2>
            {home.conversationsWaiting === null ? (
              <p className="muted">Llega con la bandeja de WhatsApp IA: las conversaciones que esperan a una persona.</p>
            ) : (
              <p className="home-big tnum">{home.conversationsWaiting}</p>
            )}
          </section>
        )}
      </div>
    </div>
  );
}

function AppointmentCard({
  id,
  title,
  empty,
  items,
  timeZone,
  t,
  confirmable = false,
}: {
  id: string;
  title: string;
  empty: string;
  items: Appointment[];
  timeZone: string;
  t: Terminology;
  confirmable?: boolean;
}) {
  const store = useAppointmentStore();
  const { showToast } = useToast();
  return (
    <section className="card home-card" aria-labelledby={`${id}-title`}>
      <div className="home-card-head">
        <h2 id={`${id}-title`} className="card-title">
          {title}
        </h2>
        {items.length > 0 && <span className="home-count tnum">{items.length}</span>}
      </div>
      {items.length === 0 ? (
        <p className="muted">{empty}</p>
      ) : (
        <ul className="home-list">
          {items.map((a) => {
            const tz = a.location?.timezone ?? timeZone;
            return (
              <li key={a.id} className="home-row">
                <Link className="home-item" to={agendaLink(a, timeZone)}>
                  <span className="home-item-time tnum">{formatTime(a.startsAt, tz)}</span>
                  <span className="home-item-main">
                    {a.client?.name ?? capitalize(t.client)}
                    <span className="muted"> · {a.services.map((l) => l.name).join(" + ")}</span>
                  </span>
                  <span className="muted home-item-meta">
                    <span className="staff-dot" style={{ background: a.staff?.color ?? "var(--accent)" }} aria-hidden="true" />
                    {a.staff?.name ?? ""} · {formatWhen(a.startsAt, tz).split(",")[0]}
                  </span>
                </Link>
                {confirmable && a.status === "pending" && (
                  <button
                    type="button"
                    className="btn btn-secondary btn-small"
                    aria-label={`Confirmar la ${t.appointment} de ${a.client?.name ?? t.client}`}
                    onClick={() =>
                      void schedulingApi.confirm(a.id).then(
                        (updated) => {
                          store(updated);
                          showToast(`${capitalize(t.appointment)} confirmada.`);
                        },
                        (error: unknown) => showToast(errorMessage(error)),
                      )
                    }
                  >
                    Confirmar
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
