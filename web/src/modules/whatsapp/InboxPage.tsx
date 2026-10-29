import { useCallback } from "react";
import { useLocation, useMatch, useSearchParams } from "react-router-dom";
import { useSession } from "../../app/session";
import EmptyState from "../../ui/EmptyState";
import ChatPane from "./ChatPane";
import ConversationList from "./ConversationList";
import type { ConversationFilter } from "./whatsappApi";

const FILTER_VALUES: readonly ConversationFilter[] = ["open", "attended", "all"];

function parseFilter(value: string | null): ConversationFilter {
  return FILTER_VALUES.includes(value as ConversationFilter) ? (value as ConversationFilter) : "open";
}

/**
 * Bandeja (/whatsapp y /whatsapp/conversations/:id). En desktop, lista y chat lado a lado;
 * en el celular, la lista o el chat (según la URL, así "atrás" vuelve a la lista). El
 * filtro y la búsqueda viven en la URL (?status=&q=) y los enlaces los conservan.
 */
export default function InboxPage() {
  const me = useSession();
  const location = useLocation();
  const [params, setParams] = useSearchParams();
  const openId = useMatch("/whatsapp/conversations/:id")?.params.id ?? null;
  const status = parseFilter(params.get("status"));
  const q = params.get("q") ?? "";

  const updateParams = useCallback(
    (change: Record<string, string>) =>
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          for (const [key, value] of Object.entries(change)) {
            if (!value || (key === "status" && value === "open")) next.delete(key);
            else next.set(key, value);
          }
          return next;
        },
        { replace: true },
      ),
    [setParams],
  );
  const onStatusChange = useCallback((value: ConversationFilter) => updateParams({ status: value }), [updateParams]);
  const onSearch = useCallback((value: string) => updateParams({ q: value.trim() }), [updateParams]);

  return (
    <div className={"wa-inbox" + (openId ? " wa-inbox-chat" : "")}>
      <ConversationList
        status={status}
        q={q}
        onStatusChange={onStatusChange}
        onSearch={onSearch}
        openId={openId}
        search={location.search}
        timeZone={me.business.timezone}
      />
      <section className="wa-chat-pane" aria-label="Conversación">
        {openId ? (
          <ChatPane key={openId} id={openId} search={location.search} />
        ) : (
          <div className="wa-chat-placeholder">
            <EmptyState icon="chat" title="Elegí una conversación" help="Tocá una conversación de la lista para ver los mensajes y responder." />
          </div>
        )}
      </section>
    </div>
  );
}
