import { useState } from "react";
import { Link } from "react-router-dom";
import { capitalize, terminologyOf } from "../../app/navigation";
import { useSession } from "../../app/session";
import { errorMessage } from "../../lib/api";
import { formatCents } from "../../lib/money";
import Icon from "../../ui/Icons";
import { isoToZoned } from "../settings/zonedTime";
import { formatTime, formatWhen, isActive, STATUS_LABEL } from "./format";
import NewAppointmentDialog from "./NewAppointmentDialog";
import { useAgendaSetup, useClientHistory } from "./schedulingApi";
import "./agenda.css";

interface Props {
  client: { id: string; name: string; phone: string | null; anonymized: boolean };
}

/**
 * Historial de citas de la ficha (`GET /clients/:id/appointments`): de la más nueva a la
 * más vieja, con "Ver más" y el atajo para agendarle una cita.
 */
export default function ClientAppointments({ client }: Props) {
  const me = useSession();
  const t = terminologyOf(me);
  const history = useClientHistory(client.id);
  const [creating, setCreating] = useState(false);
  const canBook = !client.anonymized && (me.role !== "staff" || Boolean(me.staffId));
  const setup = useAgendaSetup();
  const items = history.data?.pages.flatMap((p) => p.items) ?? [];
  const now = Date.now();
  const next = items.filter((a) => isActive(a.status) && new Date(a.startsAt).getTime() >= now).at(-1);

  return (
    <section className="card client-section" aria-labelledby="client-history-title">
      <div className="client-history-head">
        <h2 id="client-history-title" className="card-title">
          Historial de {t.appointments}
        </h2>
        {canBook && (
          <button type="button" className="btn btn-secondary btn-small" onClick={() => setCreating(true)} disabled={!setup.locations.data}>
            <Icon id="plus" size={16} />
            Agendar {t.appointment}
          </button>
        )}
      </div>

      {history.isPending ? (
        <p className="muted" role="status">
          Cargando el historial…
        </p>
      ) : history.isError ? (
        <p className="field-error">{errorMessage(history.error, "No pudimos cargar el historial.")}</p>
      ) : items.length === 0 ? (
        <div className="client-history-placeholder">
          <Icon id="calendar" size={22} strokeWidth={1.6} />
          <div>
            <p className="client-history-title">Todavía no tiene {t.appointments}</p>
            <p className="muted">Acá vas a ver las pasadas, las próximas y las que no se presentó.</p>
          </div>
        </div>
      ) : (
        <>
          {next && (
            <p className="client-next">
              Próxima: <strong>{formatWhen(next.startsAt, next.location?.timezone ?? me.business.timezone)}</strong> con {next.staff?.name ?? `un ${t.staffMember}`}
            </p>
          )}
          <ul className="client-history-list">
            {items.map((a) => {
              const tz = a.location?.timezone ?? me.business.timezone;
              const date = isoToZoned(a.startsAt, tz).date;
              return (
                <li key={a.id}>
                  <Link className="client-history-item" to={`/agenda?date=${date}&appointment=${a.id}`}>
                    <span className="client-history-when">
                      {capitalize(formatWhen(a.startsAt, tz).split(",")[0])}
                      <span className="muted tnum"> {formatTime(a.startsAt, tz)}</span>
                    </span>
                    <span className="client-history-what">
                      {a.services.map((l) => l.name).join(" + ")}
                      <span className="muted">
                        {" "}
                        · {a.staff?.name ?? "—"}
                        {a.location ? ` · ${a.location.name}` : ""}
                        {a.totalCents > 0 ? ` · ${formatCents(a.totalCents, me.business.currency)}` : ""}
                      </span>
                    </span>
                    <span className={`status-badge status-${a.status}`}>{STATUS_LABEL[a.status]}</span>
                  </Link>
                </li>
              );
            })}
          </ul>
          {history.hasNextPage && (
            <div className="clients-more">
              <button type="button" className="btn btn-secondary" onClick={() => void history.fetchNextPage()} disabled={history.isFetchingNextPage}>
                {history.isFetchingNextPage ? "Cargando…" : "Ver más"}
              </button>
            </div>
          )}
        </>
      )}

      {canBook && setup.locations.data && (
        <NewAppointmentDialog
          open={creating}
          onClose={() => setCreating(false)}
          defaults={{ client: { id: client.id, name: client.name, phone: client.phone } }}
          locations={setup.locations.data}
          staff={setup.staff.data ?? []}
          services={setup.catalog.data?.services ?? []}
        />
      )}
    </section>
  );
}
