import { useEffect, useId, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { terminologyOf } from "../../app/navigation";
import { useSession } from "../../app/session";
import { errorMessage } from "../../lib/api";
import Dialog from "../../ui/Dialog";
import { TextField } from "../../ui/Field";
import { clientKeys, searchClients, type ClientRef } from "./clientsApi";
import { formatPhone } from "./format";

interface Props {
  open: boolean;
  onClose: () => void;
  /** El cliente de la ficha (no puede ser su propio responsable). */
  clientId: string;
  onPick: (guardian: ClientRef) => void;
}

/**
 * Elegir el responsable de un cliente (p. ej. la mamá de un menor): buscador sobre los
 * clientes del negocio y una lista de botones. Las reglas (no uno mismo, no alguien que ya
 * tiene responsable) las valida el backend al guardar.
 */
export default function GuardianPicker({ open, onClose, clientId, onPick }: Props) {
  const me = useSession();
  const t = terminologyOf(me);
  const [draft, setDraft] = useState("");
  const [q, setQ] = useState("");
  const listId = useId();

  useEffect(() => {
    const timer = window.setTimeout(() => setQ(draft.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [draft]);

  const results = useQuery({
    queryKey: [...clientKeys.all(me.business.id), "guardian-search", q],
    queryFn: () => searchClients(q),
    enabled: open && q.length > 0,
  });
  const options = (results.data?.items ?? []).filter((c) => c.id !== clientId);

  function close() {
    setDraft("");
    setQ("");
    onClose();
  }

  return (
    <Dialog open={open} onClose={close} title="Elegir responsable">
      <p>La persona a cargo (por ejemplo, de un menor). Tiene que ser otro {t.client} del negocio.</p>
      <TextField
        label={`Buscar ${t.client}`}
        type="search"
        autoComplete="off"
        autoFocus
        placeholder="Nombre o teléfono"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        aria-controls={listId}
      />
      <div id={listId} className="client-picker-results" aria-live="polite">
        {q.length === 0 ? null : results.isPending ? (
          <p className="muted">Buscando…</p>
        ) : results.isError ? (
          <p className="field-error">{errorMessage(results.error)}</p>
        ) : options.length === 0 ? (
          <p className="muted">No encontramos {t.clients} con «{q}».</p>
        ) : (
          <ul className="client-picker-list">
            {options.map((c) => (
              <li key={c.id}>
                <button
                  type="button"
                  className="client-picker-option"
                  onClick={() => {
                    onPick({ id: c.id, name: c.name });
                    close();
                  }}
                >
                  <span className="client-picker-name">{c.name}</span>
                  <span className="muted">{formatPhone(c.phone) || c.email || "Sin teléfono"}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Dialog>
  );
}
