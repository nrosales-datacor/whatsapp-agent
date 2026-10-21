import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { usePush } from "../../app/push";
import { errorMessage } from "../../lib/api";
import EmptyState from "../../ui/EmptyState";
import ErrorState from "../../ui/ErrorState";
import Icon from "../../ui/Icons";
import { avatarText, clientLabel, formatAppointment, formatListTime, MODE_LABEL } from "./format";
import { useConversationList, type ConversationFilter, type ConversationSummary } from "./whatsappApi";

const FILTERS: readonly { value: ConversationFilter; label: string }[] = [
  { value: "open", label: "Abiertas" },
  { value: "attended", label: "Atendidas" },
  { value: "all", label: "Todas" },
];

const SEARCH_DEBOUNCE_MS = 300;

/** Necesita a una persona: la atiende alguien del equipo y lo último lo escribió el cliente. */
export function needsReply(c: ConversationSummary): boolean {
  return c.status === "open" && c.mode === "human" && c.lastMessage?.direction === "in";
}

interface Props {
  status: ConversationFilter;
  q: string;
  onStatusChange: (status: ConversationFilter) => void;
  onSearch: (q: string) => void;
  openId: string | null;
  /** Query string actual (filtro y búsqueda), para que los enlaces la conserven. */
  search: string;
  timeZone: string;
}

/** Lista de la bandeja: búsqueda, filtros, filas y "Ver más". */
export default function ConversationList({ status, q, onStatusChange, onSearch, openId, search, timeZone }: Props) {
  const query = useConversationList(status, q);
  const push = usePush();
  const [text, setText] = useState(q);

  // La búsqueda va al servidor con un pequeño retardo (y queda en la URL).
  useEffect(() => {
    if (text.trim() === q.trim()) return;
    const timer = window.setTimeout(() => onSearch(text), SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [text, q, onSearch]);

  const items = query.data?.pages.flatMap((p) => p.items) ?? [];
  const filtered = status !== "all" || q.trim() !== "";

  return (
    <section className="wa-list" aria-label="Conversaciones">
      <div className="wa-list-tools">
        <div className="wa-search">
          <Icon id="search" size={18} />
          <input
            type="search"
            className="input"
            placeholder="Nombre, teléfono o mensaje"
            aria-label="Buscar conversaciones"
            value={text}
            onChange={(e) => setText(e.target.value)}
            autoComplete="off"
          />
        </div>
        <div className="wa-filters" role="group" aria-label="Filtrar conversaciones">
          {FILTERS.map((f) => (
            <button
              key={f.value}
              type="button"
              className={"wa-filter" + (status === f.value ? " active" : "")}
              aria-pressed={status === f.value}
              onClick={() => onStatusChange(f.value)}
            >
              {f.label}
            </button>
          ))}
        </div>
        {push.relevant && push.state === "off" && (
          <button type="button" className="btn btn-secondary btn-small wa-push-button" onClick={() => void push.enable()} disabled={push.busy}>
            <Icon id="bell" size={16} />
            Activar notificaciones
          </button>
        )}
      </div>

      <div className="wa-list-body">
        {query.isPending ? (
          <div className="clients-loading" role="status">
            <div className="spinner" aria-hidden="true" />
            <span>Cargando conversaciones…</span>
          </div>
        ) : query.isError && items.length === 0 ? (
          <ErrorState message={errorMessage(query.error, "No pudimos cargar las conversaciones.")} onRetry={() => void query.refetch()} />
        ) : items.length === 0 ? (
          filtered ? (
            <EmptyState
              icon="search"
              title={q.trim() ? `No encontramos conversaciones con «${q.trim()}»` : status === "attended" ? "No hay conversaciones atendidas" : "No hay conversaciones abiertas"}
              help="Probá con otra búsqueda o mirá todas las conversaciones."
              action={{
                label: "Ver todas",
                onClick: () => {
                  setText("");
                  onSearch("");
                  onStatusChange("all");
                },
              }}
            />
          ) : (
            <EmptyState icon="chat" title="Todavía no hay conversaciones" help="Cuando un cliente le escriba a tu WhatsApp, la conversación va a aparecer acá." />
          )
        ) : (
          <>
            <ul className="wa-rows">
              {items.map((c) => (
                <li key={c.id}>
                  <ConversationRow conversation={c} active={c.id === openId} search={search} timeZone={timeZone} />
                </li>
              ))}
            </ul>
            {query.hasNextPage && (
              <div className="wa-more">
                <button type="button" className="btn btn-secondary" onClick={() => void query.fetchNextPage()} disabled={query.isFetchingNextPage}>
                  {query.isFetchingNextPage ? "Cargando…" : "Ver más"}
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
}

function ConversationRow({ conversation: c, active, search, timeZone }: { conversation: ConversationSummary; active: boolean; search: string; timeZone: string }) {
  const name = clientLabel(c.client);
  const waiting = needsReply(c);
  const preview = c.lastMessage?.text?.trim() || "Sin mensajes";
  return (
    <Link
      to={{ pathname: `/whatsapp/conversations/${encodeURIComponent(c.id)}`, search }}
      className={"wa-row" + (active ? " active" : "") + (waiting ? " waiting" : "") + (c.unread > 0 ? " unread" : "")}
      aria-current={active ? "page" : undefined}
    >
      <span className="wa-avatar" aria-hidden="true">
        {avatarText(c.client)}
      </span>
      <span className="wa-row-main">
        <span className="wa-row-line">
          <span className="wa-row-name">{name}</span>
          {c.lastMessage && (
            <time className="wa-row-time tnum" dateTime={c.lastMessage.at}>
              {formatListTime(c.lastMessage.at, timeZone)}
            </time>
          )}
        </span>
        <span className="wa-row-line">
          <span className="wa-row-preview">
            {c.lastMessage?.direction === "out" && (
              <>
                <Icon id="checkCheck" size={14} />
                <span className="visually-hidden">Respuesta enviada: </span>
              </>
            )}
            {preview}
          </span>
          {c.unread > 0 && (
            <span className="wa-unread tnum" aria-label={`${c.unread} sin leer`}>
              {c.unread}
            </span>
          )}
        </span>
        <span className="wa-row-tags">
          <span className={`wa-mode wa-mode-${c.mode}`}>
            <Icon id={c.mode === "bot" ? "bot" : "user"} size={12} />
            {MODE_LABEL[c.mode]}
          </span>
          {waiting && <span className="wa-chip wa-chip-warning">Espera respuesta</span>}
          {c.status === "attended" && <span className="wa-chip">Atendida</span>}
          {c.nextAppointment && (
            <span className="wa-chip wa-chip-info">
              <Icon id="calendar" size={12} />
              {formatAppointment(c.nextAppointment.startsAt, timeZone)}
            </span>
          )}
        </span>
      </span>
    </Link>
  );
}
