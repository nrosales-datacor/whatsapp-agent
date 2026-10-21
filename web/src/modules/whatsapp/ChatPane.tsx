import { useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type RefObject } from "react";
import { useMutation } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { capitalize, terminologyOf } from "../../app/navigation";
import { useSession } from "../../app/session";
import { errorMessage, isApiError } from "../../lib/api";
import EmptyState from "../../ui/EmptyState";
import ErrorState from "../../ui/ErrorState";
import Icon from "../../ui/Icons";
import { useToast } from "../../ui/Toast";
import { formatPhone } from "../clients/format";
import { formatTime } from "../scheduling/format";
import { AUTHOR_LABEL, avatarText, clientLabel, formatAppointment, formatDayLabel, localDate } from "./format";
import {
  useConversation,
  useConversationUpdater,
  whatsappApi,
  type ConversationMode,
  type ConversationStatus,
  type ConversationSummary,
  type Message,
} from "./whatsappApi";

const NEAR_BOTTOM_PX = 96;
const MAX_MESSAGE = 4096;

/** Solo se enlazan medios con URL http(s) o relativa (nunca `javascript:` ni `data:`). */
function linkableUrl(url: string): boolean {
  return /^https?:\/\//i.test(url) || url.startsWith("/");
}

/** Mensajes de todas las páginas cargadas, sin repetidos y en orden cronológico. */
function mergeMessages(pages: { messages: Message[] }[]): Message[] {
  const byId = new Map<string, Message>();
  for (const page of pages) for (const m of page.messages) byId.set(m.id, m);
  return [...byId.values()].sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.id.localeCompare(b.id));
}

interface Props {
  id: string;
  /** Query string de la bandeja (filtro y búsqueda) para volver a la lista sin perderla. */
  search: string;
}

/** Chat de una conversación: encabezado con acciones, historial paginado y composer. */
export default function ChatPane({ id, search }: Props) {
  const me = useSession();
  const t = terminologyOf(me);
  const tz = me.business.timezone;
  const { showToast } = useToast();
  const query = useConversation(id);
  const update = useConversationUpdater();
  const [draft, setDraft] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const nearBottom = useRef(true);
  const keepFromBottom = useRef<number | null>(null);
  const lastMarked = useRef<string | null>(null);
  const [focusComposer, setFocusComposer] = useState(false);

  const conversation = query.data?.pages[0]?.conversation;

  // Al tomar el control, el foco va al composer apenas aparece.
  const mode = conversation?.mode;
  useEffect(() => {
    if (!focusComposer || mode !== "human" || !composerRef.current) return;
    composerRef.current.focus();
    setFocusComposer(false);
  }, [focusComposer, mode]);
  const messages = useMemo(() => mergeMessages(query.data?.pages ?? []), [query.data]);
  const firstId = messages[0]?.id;
  const lastId = messages[messages.length - 1]?.id;

  // Scroll: al abrir y cuando llega un mensaje (si estaba abajo) se baja al último; al
  // cargar mensajes anteriores se mantiene lo que se estaba leyendo.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (keepFromBottom.current !== null) {
      el.scrollTop = el.scrollHeight - keepFromBottom.current;
      keepFromBottom.current = null;
      return;
    }
    if (nearBottom.current) el.scrollTop = el.scrollHeight;
  }, [firstId, lastId]);

  // Marcar leído: al abrir y cada vez que llegan mensajes nuevos con la pestaña visible.
  const unread = conversation?.unread ?? 0;
  useEffect(() => {
    if (!conversation || unread === 0 || !lastId || lastMarked.current === lastId) return;
    if (document.visibilityState !== "visible") return;
    lastMarked.current = lastId;
    whatsappApi.markRead(id).then(
      () => update(id, { unread: 0 }),
      () => {
        lastMarked.current = null;
      },
    );
  }, [conversation, unread, lastId, id, update]);

  const send = useMutation({
    mutationFn: (text: string) => whatsappApi.send(id, text),
    onSuccess: () => {
      setDraft("");
      nearBottom.current = true;
      update(id, {}, { refetchDetail: true });
    },
    onError: (error) => {
      showToast(errorMessage(error, "No pudimos enviar el mensaje."));
      if (isApiError(error, "window_closed")) update(id, { windowOpen: false }, { refetchDetail: true });
    },
  });

  const setMode = useMutation({
    mutationFn: (mode: ConversationMode) => whatsappApi.setMode(id, mode),
    onSuccess: (_data, mode) => {
      update(id, { mode }, { refetchDetail: true });
      showToast(mode === "human" ? "Tomaste el control: el agente no responde hasta que se la devolvás." : "El agente vuelve a atender esta conversación.");
      if (mode === "human") setFocusComposer(true);
    },
    onError: (error) => showToast(errorMessage(error, "No pudimos cambiar quién atiende la conversación.")),
  });

  const setStatus = useMutation({
    mutationFn: (status: ConversationStatus) => whatsappApi.setStatus(id, status),
    onSuccess: (_data, status) => {
      update(id, { status }, { refetchDetail: true });
      showToast(status === "attended" ? "Conversación marcada como atendida." : "La conversación volvió a las abiertas.");
    },
    onError: (error) => showToast(errorMessage(error, "No pudimos cambiar el estado de la conversación.")),
  });

  const reopen = useMutation({
    mutationFn: () => whatsappApi.reopen(id),
    onSuccess: () => {
      nearBottom.current = true;
      update(id, {}, { refetchDetail: true });
      showToast("Le mandamos la plantilla. Cuando responda, vas a poder escribirle.");
    },
    onError: (error) => showToast(errorMessage(error, "No pudimos reabrir la conversación.")),
  });

  if (query.isPending) {
    return (
      <div className="wa-chat-status clients-loading" role="status">
        <div className="spinner" aria-hidden="true" />
        <span>Cargando la conversación…</span>
      </div>
    );
  }
  if (query.isError || !conversation) {
    return (
      <div className="wa-chat-status">
        <BackLink search={search} />
        {isApiError(query.error, "not_found") ? (
          <EmptyState icon="chat" title="No encontramos esa conversación" help="Puede que sea de otra sucursal o que ya no exista." />
        ) : (
          <ErrorState message={errorMessage(query.error, "No pudimos cargar la conversación.")} onRetry={() => void query.refetch()} />
        )}
      </div>
    );
  }

  const name = clientLabel(conversation.client);
  const human = conversation.mode === "human";
  const attended = conversation.status === "attended";
  const busy = setMode.isPending || setStatus.isPending;

  function submit(e?: FormEvent) {
    e?.preventDefault();
    const text = draft.trim();
    if (!text || send.isPending) return;
    send.mutate(text);
  }

  function onComposerKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  }

  function loadOlder() {
    const el = scrollRef.current;
    if (el) keepFromBottom.current = el.scrollHeight - el.scrollTop;
    void query.fetchNextPage();
  }

  return (
    <div className="wa-chat">
      <header className="wa-chat-head">
        <BackLink search={search} />
        <span className="wa-avatar wa-avatar-sm" aria-hidden="true">
          {avatarText(conversation.client)}
        </span>
        <div className="wa-chat-title">
          <h2 className="wa-chat-name" tabIndex={-1} data-page-heading>
            {name}
          </h2>
          <p className="wa-chat-meta">
            {conversation.client.name && conversation.client.phone && <span className="tnum">{formatPhone(conversation.client.phone)}</span>}
            <span className={`wa-mode wa-mode-${conversation.mode}`}>
              <Icon id={human ? "user" : "bot"} size={12} />
              {human ? "Lo atiende una persona" : "Lo atiende el agente"}
            </span>
            {!conversation.windowOpen && <span className="wa-chip wa-chip-danger">Ventana de 24 h cerrada</span>}
          </p>
          <p className="wa-chat-links">
            <Link className="link" to={`/clients/${encodeURIComponent(conversation.client.id)}`}>
              Ver ficha del {t.client}
            </Link>
            {conversation.nextAppointment && <AppointmentLink appointment={conversation.nextAppointment} timeZone={tz} label={capitalize(t.appointment)} />}
          </p>
        </div>
        <div className="wa-chat-actions">
          <button
            type="button"
            className={"btn btn-small " + (human ? "btn-secondary" : "btn-primary")}
            onClick={() => setMode.mutate(human ? "bot" : "human")}
            disabled={busy}
          >
            <Icon id={human ? "bot" : "hand"} size={16} />
            {human ? "Devolver al agente" : "Tomar control"}
          </button>
          <button type="button" className="btn btn-secondary btn-small" onClick={() => setStatus.mutate(attended ? "open" : "attended")} disabled={busy}>
            <Icon id={attended ? "refresh" : "check"} size={16} />
            {attended ? "Marcar como abierta" : "Marcar atendida"}
          </button>
        </div>
      </header>

      <div
        ref={scrollRef}
        className="wa-chat-scroll"
        role="log"
        aria-label={`Mensajes con ${name}`}
        tabIndex={0}
        onScroll={(e) => {
          const el = e.currentTarget;
          nearBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX;
        }}
      >
        {query.hasNextPage && (
          <div className="wa-older">
            <button type="button" className="btn btn-secondary btn-small" onClick={loadOlder} disabled={query.isFetchingNextPage}>
              {query.isFetchingNextPage ? "Cargando…" : "Ver mensajes anteriores"}
            </button>
          </div>
        )}
        {messages.length === 0 ? (
          <p className="wa-chat-empty muted">Todavía no hay mensajes en esta conversación.</p>
        ) : (
          <MessageList
            messages={messages}
            timeZone={tz}
            onMediaLoad={() => {
              const el = scrollRef.current;
              if (el && nearBottom.current) el.scrollTop = el.scrollHeight;
            }}
          />
        )}
      </div>

      <ChatFooter
        conversation={conversation}
        draft={draft}
        onDraft={setDraft}
        onSubmit={submit}
        onKeyDown={onComposerKey}
        sending={send.isPending}
        reopening={reopen.isPending}
        onReopen={() => reopen.mutate()}
        composerRef={composerRef}
        name={name}
      />
    </div>
  );
}

function BackLink({ search }: { search: string }) {
  return (
    <Link to={{ pathname: "/whatsapp", search }} className="icon-btn wa-back" aria-label="Volver a la bandeja">
      <Icon id="chevronLeft" size={22} />
    </Link>
  );
}

function AppointmentLink({ appointment, timeZone, label }: { appointment: { id: string; startsAt: string }; timeZone: string; label: string }) {
  const date = localDate(appointment.startsAt, timeZone);
  return (
    <Link className="link wa-appointment" to={`/agenda?date=${date}&appointment=${encodeURIComponent(appointment.id)}`}>
      <Icon id="calendar" size={14} />
      {label}: {formatAppointment(appointment.startsAt, timeZone)}
    </Link>
  );
}

function MessageList({ messages, timeZone, onMediaLoad }: { messages: Message[]; timeZone: string; onMediaLoad: () => void }) {
  let lastDay = "";
  return (
    <ol className="wa-messages">
      {messages.flatMap((m) => {
        const day = localDate(m.at, timeZone);
        const separator =
          day !== lastDay ? (
            <li key={`day-${day}`} className="wa-day">
              <span>{formatDayLabel(day, timeZone)}</span>
            </li>
          ) : null;
        lastDay = day;
        return [separator, <MessageBubble key={m.id} message={m} timeZone={timeZone} onMediaLoad={onMediaLoad} />].filter(Boolean);
      })}
    </ol>
  );
}

function MessageBubble({ message: m, timeZone, onMediaLoad }: { message: Message; timeZone: string; onMediaLoad: () => void }) {
  const fromClient = m.by === "client";
  const media = m.mediaUrl && m.mediaType ? { url: m.mediaUrl, type: m.mediaType } : null;
  return (
    <li className={`wa-msg wa-msg-${m.by}`}>
      <div className="wa-bubble">
        <span className={fromClient ? "visually-hidden" : "wa-bubble-author"}>
          {!fromClient && <Icon id={m.by === "bot" ? "bot" : "user"} size={12} />}
          {AUTHOR_LABEL[m.by]}
          {fromClient ? ": " : ""}
        </span>
        {media?.type === "image" &&
          (linkableUrl(media.url) ? (
            <a href={media.url} target="_blank" rel="noopener noreferrer" className="wa-media-link">
              <img src={media.url} alt={fromClient ? "Foto del cliente" : "Foto enviada"} className="wa-media-image" loading="lazy" onLoad={onMediaLoad} />
            </a>
          ) : (
            <img src={media.url} alt={fromClient ? "Foto del cliente" : "Foto enviada"} className="wa-media-image" loading="lazy" onLoad={onMediaLoad} />
          ))}
        {media?.type === "audio" && (
          <audio className="wa-media-audio" controls preload="none" src={media.url} aria-label={fromClient ? "Audio del cliente" : "Audio enviado"} />
        )}
        {!media && m.mediaType && (
          <span className="wa-media-missing">
            <Icon id={m.mediaType === "image" ? "image" : "mic"} size={14} />
            {m.mediaType === "image" ? "Foto no disponible" : "Audio no disponible"}
          </span>
        )}
        {m.text && <p className="wa-bubble-text">{m.text}</p>}
        <time className="wa-bubble-time tnum" dateTime={m.at}>
          {formatTime(m.at, timeZone)}
        </time>
      </div>
    </li>
  );
}

interface FooterProps {
  conversation: ConversationSummary;
  draft: string;
  onDraft: (text: string) => void;
  onSubmit: (e?: FormEvent) => void;
  onKeyDown: (e: KeyboardEvent<HTMLTextAreaElement>) => void;
  sending: boolean;
  reopening: boolean;
  onReopen: () => void;
  composerRef: RefObject<HTMLTextAreaElement | null>;
  name: string;
}

/** Pie del chat: ventana cerrada (reabrir con plantilla), agente atendiendo, o el composer. */
function ChatFooter({ conversation, draft, onDraft, onSubmit, onKeyDown, sending, reopening, onReopen, composerRef, name }: FooterProps) {
  // Alto automático del composer (hasta ~5 líneas).
  useLayoutEffect(() => {
    const el = composerRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 140)}px`;
  }, [draft, composerRef]);

  if (!conversation.windowOpen) {
    return (
      <div className="wa-chat-footer wa-window-closed" role="note">
        <p>
          <strong>Pasaron más de 24 horas desde el último mensaje del cliente.</strong> WhatsApp solo deja escribirle con una plantilla
          aprobada; cuando responda, la conversación se abre de nuevo.
        </p>
        <button type="button" className="btn btn-primary btn-small" onClick={onReopen} disabled={reopening}>
          <Icon id="send" size={16} />
          {reopening ? "Enviando…" : "Reabrir con plantilla"}
        </button>
      </div>
    );
  }
  if (conversation.mode === "bot") {
    return (
      <div className="wa-chat-footer wa-bot-note" role="note">
        <Icon id="bot" size={18} />
        <p>El agente está atendiendo esta conversación. Tocá «Tomar control» para responder vos.</p>
      </div>
    );
  }
  return (
    <form className="wa-chat-footer wa-composer" onSubmit={onSubmit}>
      <label className="visually-hidden" htmlFor={`composer-${conversation.id}`}>
        Mensaje para {name}
      </label>
      <textarea
        id={`composer-${conversation.id}`}
        ref={composerRef}
        className="input wa-composer-input"
        rows={1}
        maxLength={MAX_MESSAGE}
        placeholder="Escribí un mensaje…"
        value={draft}
        onChange={(e) => onDraft(e.target.value)}
        onKeyDown={onKeyDown}
      />
      <button type="submit" className="wa-send" aria-label="Enviar mensaje" disabled={sending || !draft.trim()}>
        <Icon id="send" size={20} />
      </button>
    </form>
  );
}
