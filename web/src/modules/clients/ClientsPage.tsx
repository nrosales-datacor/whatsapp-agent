import { useEffect, useId, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { capitalize, getSection, terminologyOf } from "../../app/navigation";
import { useSession } from "../../app/session";
import { errorMessage } from "../../lib/api";
import EmptyState from "../../ui/EmptyState";
import ErrorState from "../../ui/ErrorState";
import Icon from "../../ui/Icons";
import PageHeader from "../../ui/PageHeader";
import { useClientList, type ClientSort } from "./clientsApi";
import { formatDay, formatPhone } from "./format";
import NewClientDialog from "./NewClientDialog";
import "./clients.css";

const SEARCH_DEBOUNCE_MS = 300;

/** Estado de navegación de la lista a la ficha (para volver con la misma búsqueda). */
export interface ClientListState {
  listSearch?: string;
}

/** Quién puede dar de alta y editar clientes (igual que el backend). */
export function canEditClients(role: string): boolean {
  return role === "owner" || role === "admin" || role === "front_desk";
}

/**
 * Clientes (/clients): buscador, lista con "Ver más" y alta. La búsqueda y el orden viven
 * en la URL (`?q=&sort=`) para volver desde una ficha sin perderlos; `?new=1` abre el alta
 * (lo usa el botón global "+ Nuevo").
 */
export default function ClientsPage() {
  const me = useSession();
  const t = terminologyOf(me);
  const title = getSection("clients").label(t, me.role);
  const [params, setParams] = useSearchParams();
  const q = params.get("q") ?? "";
  const sort: ClientSort = params.get("sort") === "last_visit" ? "last_visit" : "name";
  const creating = params.get("new") === "1";
  const canEdit = canEditClients(me.role);
  const searchId = useId();
  const sortId = useId();

  // Lo que se escribe se aplica a la URL (y a la consulta) después de una pausa corta.
  const [draft, setDraft] = useState(q);
  useEffect(() => setDraft(q), [q]);
  useEffect(() => {
    if (draft === q) return;
    const timer = window.setTimeout(() => updateParams({ q: draft.trim() ? draft : null }), SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [draft, q]);

  // Siempre sobre los parámetros VIGENTES: el temporizador del buscador puede correr
  // después de que cambió el orden (el updater de setParams vería los de su render).
  const paramsRef = useRef(params);
  paramsRef.current = params;
  function updateParams(changes: Record<string, string | null>) {
    const next = new URLSearchParams(paramsRef.current);
    for (const [key, value] of Object.entries(changes)) {
      if (value === null) next.delete(key);
      else next.set(key, value);
    }
    setParams(next, { replace: true });
  }

  const list = useClientList(me.business.id, q, sort);
  const items = list.data?.pages.flatMap((p) => p.items) ?? [];
  const searching = q.trim() !== "";
  const tz = me.business.timezone;
  // La ficha vuelve a esta misma búsqueda y orden con "Volver".
  const listState: ClientListState = { listSearch: params.toString() };

  return (
    <div className="page">
      <PageHeader title={title}>
        {canEdit && (
          <button type="button" className="btn btn-primary" onClick={() => updateParams({ new: "1" })}>
            <Icon id="plus" size={18} strokeWidth={2.2} />
            Nuevo {t.client}
          </button>
        )}
      </PageHeader>

      <div className="clients-toolbar" role="search">
        <div className="clients-search">
          <label htmlFor={searchId} className="visually-hidden">
            Buscar {t.clients}
          </label>
          <Icon id="search" size={18} />
          <input
            id={searchId}
            type="search"
            className="input"
            placeholder="Nombre, teléfono o correo"
            autoComplete="off"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
          />
        </div>
        <div className="clients-sort">
          <label htmlFor={sortId} className="clients-sort-label">
            Ordenar por
          </label>
          <select
            id={sortId}
            className="input select"
            value={sort}
            onChange={(e) => updateParams({ sort: e.target.value === "last_visit" ? "last_visit" : null })}
          >
            <option value="name">Nombre</option>
            <option value="last_visit">Última visita</option>
          </select>
        </div>
      </div>

      {list.isPending ? (
        <div className="clients-loading" role="status">
          <div className="spinner" aria-hidden="true" />
          <span>Cargando {t.clients}…</span>
        </div>
      ) : list.isError && items.length === 0 ? (
        <ErrorState message={`No pudimos cargar tus ${t.clients}.`} onRetry={() => void list.refetch()} />
      ) : items.length === 0 ? (
        searching ? (
          <EmptyState icon="search" title={`No encontramos ${t.clients} con «${q.trim()}»`} help="Probá con otra parte del nombre, del teléfono o del correo." />
        ) : (
          <EmptyState
            icon="users"
            title={`Todavía no tenés ${t.clients}`}
            help={`Acá vas a ver a cada ${t.client} con su teléfono, su última visita y su historial. Se crean solos cuando agendan por WhatsApp, o los podés cargar vos.`}
            action={canEdit ? { label: `Nuevo ${t.client}`, icon: "plus", onClick: () => updateParams({ new: "1" }) } : undefined}
          />
        )
      ) : (
        <>
          <div className="card clients-table-card">
            <table className="clients-table">
              <caption className="visually-hidden">
                {capitalize(t.clients)}
                {searching ? `: resultados de «${q.trim()}»` : ""}
              </caption>
              <thead>
                <tr>
                  <th scope="col">Nombre</th>
                  <th scope="col" className="clients-col-phone">
                    Teléfono
                  </th>
                  <th scope="col">Última visita</th>
                  <th scope="col" className="clients-col-num">
                    Visitas
                  </th>
                </tr>
              </thead>
              <tbody>
                {items.map((c) => (
                  <tr key={c.id}>
                    <td>
                      <Link to={`/clients/${c.id}`} state={listState} className="clients-row-link">
                        {c.name}
                      </Link>
                      <span className="clients-row-sub">{formatPhone(c.phone) || c.email || "Sin teléfono"}</span>
                    </td>
                    <td className="clients-col-phone tnum">{formatPhone(c.phone) || <span className="muted">—</span>}</td>
                    <td className="tnum">{c.lastVisitAt ? formatDay(c.lastVisitAt, tz) : <span className="muted">Nunca</span>}</td>
                    <td className="clients-col-num tnum">{c.visitCount}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="clients-more">
            {list.isError && <p className="field-error">{errorMessage(list.error)}</p>}
            {list.hasNextPage ? (
              <button type="button" className="btn btn-secondary" onClick={() => void list.fetchNextPage()} disabled={list.isFetchingNextPage}>
                {list.isFetchingNextPage ? "Cargando…" : "Ver más"}
              </button>
            ) : (
              <p className="muted" aria-live="polite">
                {items.length === 1 ? `1 ${t.client}` : `${items.length} ${t.clients}`}
              </p>
            )}
          </div>
        </>
      )}

      {canEdit && <NewClientDialog open={creating} onClose={() => updateParams({ new: null })} />}
    </div>
  );
}
