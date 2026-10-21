import { Link } from "react-router-dom";
import Icon from "../../ui/Icons";
import { formatInt } from "./format";
import { useWhatsappSummary } from "./whatsappApi";

/**
 * Tarjeta "Conversaciones esperando" del Inicio (solo si el plan trae WhatsApp IA): las que
 * esperan a una persona, con el resumen de la semana y el acceso a la bandeja.
 */
export default function WaitingCard() {
  const query = useWhatsappSummary();
  const s = query.data;
  return (
    <section className="card home-card" aria-labelledby="home-conv-title">
      <div className="home-card-head">
        <h2 id="home-conv-title" className="card-title">
          Conversaciones esperando
        </h2>
      </div>
      {query.isPending ? (
        <p className="muted">Cargando…</p>
      ) : query.isError || !s ? (
        <p className="muted">
          No pudimos cargar las conversaciones.{" "}
          <button type="button" className="link-button" onClick={() => void query.refetch()}>
            Reintentar
          </button>
        </p>
      ) : (
        <>
          <p className="home-big tnum">{formatInt(s.conversationsWaiting)}</p>
          <p className="muted">
            {s.conversationsWaiting === 0
              ? "Nadie está esperando a una persona."
              : s.conversationsWaiting === 1
                ? "Una conversación espera que alguien del equipo responda."
                : `${formatInt(s.conversationsWaiting)} conversaciones esperan que alguien del equipo responda.`}
          </p>
          <ul className="home-status-list wa-home-stats">
            <li>
              <span>Abiertas</span>
              <span className="tnum">{formatInt(s.openConversations)}</span>
            </li>
            <li>
              <span>Conversaciones esta semana</span>
              <span className="tnum">{formatInt(s.conversationsThisWeek)}</span>
            </li>
            <li>
              <span>Pasadas a una persona esta semana</span>
              <span className="tnum">{formatInt(s.handoffsThisWeek)}</span>
            </li>
          </ul>
          <Link className="btn btn-secondary btn-small wa-home-link" to="/whatsapp">
            <Icon id="chat" size={16} />
            Ir a la bandeja
          </Link>
        </>
      )}
    </section>
  );
}
