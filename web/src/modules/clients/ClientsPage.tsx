import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useUpsell } from "../../app/layout/upsell";
import { capitalize, getSection, terminologyOf } from "../../app/navigation";
import { useSession } from "../../app/session";
import { errorMessage } from "../../lib/api";
import { formatCents } from "../../lib/money";
import EmptyState from "../../ui/EmptyState";
import ErrorState from "../../ui/ErrorState";
import Icon from "../../ui/Icons";
import PageHeader from "../../ui/PageHeader";
import { useToast } from "../../ui/Toast";
import {
  BASIC_SORTS,
  CLIENT_STATUSES,
  downloadClientsCsv,
  EMPTY_FILTERS,
  useClientFormOptions,
  useClientList,
  useClientStatusCounts,
  useClientTags,
  type ClientFilters,
  type ClientSort,
  type ClientStatus,
} from "./clientsApi";
import { hasCrm, isManager, STATUS_LABELS } from "./crmApi";
import { formatDay, formatPhone } from "./format";
import ImportClientsDialog from "./ImportClientsDialog";
import NewClientDialog from "./NewClientDialog";
import { StatusBadge, VipMark } from "./StatusBadge";
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

const SORT_LABELS: Record<ClientSort, string> = {
  name: "Nombre",
  last_visit: "Última visita",
  total_spent: "Gasto total",
  visit_count: "Visitas",
};

const CHIP_LABELS: Record<ClientStatus, string> = {
  new: "Nuevos",
  active: "Activos",
  vip: "VIP",
  at_risk: "En riesgo",
  inactive: "Inactivos",
};

const isStatus = (v: string): v is ClientStatus => (CLIENT_STATUSES as readonly string[]).includes(v);

/** Filtros desde la URL (`?q=&status=&tag=&from=&to=&staff=&location=&vip=`). */
function filtersFromParams(params: URLSearchParams): ClientFilters {
  const vip = params.get("vip");
  return {
    q: params.get("q") ?? "",
    statuses: (params.get("status") ?? "").split(",").filter(isStatus),
    tags: params.getAll("tag").filter(Boolean),
    lastVisitFrom: params.get("from") ?? "",
    lastVisitTo: params.get("to") ?? "",
    preferredStaffId: params.get("staff") ?? "",
    preferredLocationId: params.get("location") ?? "",
    vip: vip === "true" || vip === "false" ? vip : "",
  };
}

/** ¿Hay algún filtro del CRM puesto (además de la búsqueda)? */
function hasCrmFilters(f: ClientFilters): boolean {
  return f.statuses.length > 0 || f.tags.length > 0 || Boolean(f.lastVisitFrom || f.lastVisitTo || f.preferredStaffId || f.preferredLocationId || f.vip);
}

/**
 * Clientes (/clients): buscador, lista con "Ver más" y alta. En el plan Pro (CRM completo):
 * chips por estado con su cantidad, filtros (etiquetas, última visita, preferidos, VIP),
 * orden por gasto y visitas, columna de estado, e Importar / Exportar (dueño y admin). En el
 * Básico, eso se ve con candado y abre el aviso del plan Pro. Búsqueda, orden y filtros
 * viven en la URL para volver desde una ficha sin perderlos; `?new=1` abre el alta.
 */
export default function ClientsPage() {
  const me = useSession();
  const t = terminologyOf(me);
  const title = getSection("clients").label(t, me.role);
  const { showUpsell } = useUpsell();
  const { showToast } = useToast();
  const [params, setParams] = useSearchParams();
  const crm = hasCrm(me);
  const manager = isManager(me.role);
  const filters = useMemo(() => filtersFromParams(params), [params]);
  const effectiveFilters = crm ? filters : { ...EMPTY_FILTERS, q: filters.q };
  const rawSort = params.get("sort") as ClientSort | null;
  const sort: ClientSort = rawSort && rawSort in SORT_LABELS && (crm || BASIC_SORTS.includes(rawSort)) ? rawSort : "name";
  const creating = params.get("new") === "1";
  const importing = params.get("import") === "1";
  const canEdit = canEditClients(me.role);
  const searchId = useId();
  const sortId = useId();
  // El panel arranca abierto si la URL trae filtros del panel (el estado va en los chips).
  const [filtersOpen, setFiltersOpen] = useState(() => crm && activeFilterCount({ ...filters, statuses: [] }) > 0);
  const [exporting, setExporting] = useState(false);

  // Lo que se escribe se aplica a la URL (y a la consulta) después de una pausa corta.
  const q = filters.q;
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
  function updateParams(changes: Record<string, string | string[] | null>) {
    const next = new URLSearchParams(paramsRef.current);
    for (const [key, value] of Object.entries(changes)) {
      next.delete(key);
      if (Array.isArray(value)) for (const v of value) next.append(key, v);
      else if (value !== null && value !== "") next.set(key, value);
    }
    setParams(next, { replace: true });
  }

  const list = useClientList(me.business.id, effectiveFilters, sort);
  const counts = useClientStatusCounts(me.business.id, effectiveFilters, crm);
  const items = list.data?.pages.flatMap((p) => p.items) ?? [];
  const searching = q.trim() !== "";
  const filtering = crm && hasCrmFilters(filters);
  const tz = me.business.timezone;
  const showSpend = crm && me.modules.includes("sales");
  // La ficha vuelve a esta misma búsqueda, filtros y orden con "Volver".
  const listState: ClientListState = { listSearch: params.toString() };

  function toggleStatus(status: ClientStatus | null) {
    if (!crm) return showUpsell("Los estados de clientes");
    const next = status === null ? [] : filters.statuses.includes(status) ? filters.statuses.filter((s) => s !== status) : [...filters.statuses, status];
    updateParams({ status: next.length ? next.join(",") : null });
  }

  function clearFilters() {
    updateParams({ status: null, tag: null, from: null, to: null, staff: null, location: null, vip: null });
  }

  async function exportCsv() {
    if (!crm) return showUpsell("Exportar a CSV");
    setExporting(true);
    try {
      await downloadClientsCsv(effectiveFilters);
      showToast(`Listo: descargamos tus ${t.clients} en CSV.`);
    } catch (error) {
      showToast(errorMessage(error, "No pudimos exportar. Probá de nuevo."));
    } finally {
      setExporting(false);
    }
  }

  return (
    <div className="page">
      <PageHeader title={title}>
        {manager && (
          <>
            <button type="button" className="btn btn-secondary" onClick={() => (crm ? updateParams({ import: "1" }) : showUpsell("Importar desde CSV"))}>
              <Icon id={crm ? "upload" : "lock"} size={16} />
              Importar
            </button>
            <button type="button" className="btn btn-secondary" onClick={() => void exportCsv()} disabled={exporting}>
              <Icon id={crm ? "download" : "lock"} size={16} />
              {exporting ? "Exportando…" : "Exportar"}
            </button>
          </>
        )}
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
          <select id={sortId} className="input select" value={sort} onChange={(e) => updateParams({ sort: e.target.value === "name" ? null : e.target.value })}>
            {(crm ? (Object.keys(SORT_LABELS) as ClientSort[]) : BASIC_SORTS).map((s) => (
              <option key={s} value={s}>
                {SORT_LABELS[s]}
              </option>
            ))}
          </select>
        </div>
        <button
          type="button"
          className={"btn btn-secondary clients-filter-toggle" + (filtering ? " active" : "")}
          aria-expanded={crm ? filtersOpen : undefined}
          aria-controls={crm ? "clients-filters" : undefined}
          onClick={() => (crm ? setFiltersOpen((o) => !o) : showUpsell("Los filtros de clientes"))}
        >
          <Icon id={crm ? "filter" : "lock"} size={16} />
          Filtros
          {filtering && <span className="badge">{activeFilterCount(filters)}</span>}
        </button>
      </div>

      {crm && filtersOpen && <FiltersPanel filters={filters} onChange={updateParams} onClear={clearFilters} />}

      {crm ? (
        <div className="clients-chips" role="group" aria-label="Filtrar por estado">
          <button type="button" className="clients-chip" aria-pressed={filters.statuses.length === 0} onClick={() => toggleStatus(null)}>
            Todos
            {counts.data && <span className="clients-chip-count">{counts.data.total}</span>}
          </button>
          {CLIENT_STATUSES.map((status) => (
            <button
              key={status}
              type="button"
              className={`clients-chip clients-chip-${status}`}
              aria-pressed={filters.statuses.includes(status)}
              onClick={() => toggleStatus(status)}
            >
              {CHIP_LABELS[status]}
              {counts.data && <span className="clients-chip-count">{counts.data[status]}</span>}
            </button>
          ))}
        </div>
      ) : (
        <button type="button" className="clients-crm-teaser" onClick={() => showUpsell("Los estados y filtros de clientes")}>
          <Icon id="lock" size={14} />
          Estados (nuevo, VIP, en riesgo…), filtros, importar y exportar: plan Pro
        </button>
      )}

      {list.isPending ? (
        <div className="clients-loading" role="status">
          <div className="spinner" aria-hidden="true" />
          <span>Cargando {t.clients}…</span>
        </div>
      ) : list.isError && items.length === 0 ? (
        <ErrorState message={`No pudimos cargar tus ${t.clients}.`} onRetry={() => void list.refetch()} />
      ) : items.length === 0 ? (
        filtering ? (
          <EmptyState
            icon="filter"
            title={`No hay ${t.clients} con estos filtros`}
            help="Probá con menos filtros o con otros estados."
            action={{ label: "Limpiar filtros", onClick: clearFilters }}
          />
        ) : searching ? (
          <EmptyState icon="search" title={`No encontramos ${t.clients} con «${q.trim()}»`} help="Probá con otra parte del nombre, del teléfono o del correo." />
        ) : (
          <EmptyState
            icon="users"
            title={`Todavía no tenés ${t.clients}`}
            help={
              me.role === "staff"
                ? `Acá vas a ver a los ${t.clients} que atendiste o que tienen una ${t.appointment} con vos.`
                : `Acá vas a ver a cada ${t.client} con su teléfono, su última visita y su historial. Se crean solos cuando agendan por WhatsApp, o los podés cargar vos.`
            }
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
                  {crm && (
                    <th scope="col" className="clients-col-status">
                      Estado
                    </th>
                  )}
                  <th scope="col">Última visita</th>
                  <th scope="col" className="clients-col-num">
                    Visitas
                  </th>
                  {showSpend && (
                    <th scope="col" className="clients-col-num clients-col-spend">
                      Gasto
                    </th>
                  )}
                </tr>
              </thead>
              <tbody>
                {items.map((c) => (
                  <tr key={c.id}>
                    <td>
                      <span className="clients-row-name">
                        <Link to={`/clients/${c.id}`} state={listState} className="clients-row-link">
                          {c.name}
                        </Link>
                        {c.isVip && <VipMark />}
                      </span>
                      <span className="clients-row-sub">
                        {crm && c.status && <StatusBadge status={c.status} />} {formatPhone(c.phone) || c.email || "Sin teléfono"}
                      </span>
                      {c.tags.length > 0 && (
                        <span className="clients-row-tags">
                          {c.tags.slice(0, 3).map((tag) => (
                            <span key={tag} className="clients-row-tag">
                              {tag}
                            </span>
                          ))}
                          {c.tags.length > 3 && <span className="clients-row-tag">+{c.tags.length - 3}</span>}
                        </span>
                      )}
                    </td>
                    <td className="clients-col-phone tnum">{formatPhone(c.phone) || <span className="muted">—</span>}</td>
                    {crm && <td className="clients-col-status">{c.status && <StatusBadge status={c.status} />}</td>}
                    <td className="tnum">{c.lastVisitAt ? formatDay(c.lastVisitAt, tz) : <span className="muted">Nunca</span>}</td>
                    <td className="clients-col-num tnum">{c.visitCount}</td>
                    {showSpend && <td className="clients-col-num clients-col-spend tnum">{formatCents(c.totalSpentCents, me.business.currency)}</td>}
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
      {manager && crm && <ImportClientsDialog open={importing} onClose={() => updateParams({ import: null })} />}
    </div>
  );
}

function activeFilterCount(f: ClientFilters): number {
  return (
    (f.statuses.length > 0 ? 1 : 0) +
    (f.tags.length > 0 ? 1 : 0) +
    (f.lastVisitFrom || f.lastVisitTo ? 1 : 0) +
    (f.preferredStaffId ? 1 : 0) +
    (f.preferredLocationId ? 1 : 0) +
    (f.vip ? 1 : 0)
  );
}

// ── Panel de filtros (CRM del Pro) ──────────────────────────────────────────

interface FiltersPanelProps {
  filters: ClientFilters;
  onChange: (changes: Record<string, string | string[] | null>) => void;
  onClear: () => void;
}

function FiltersPanel({ filters, onChange, onClear }: FiltersPanelProps) {
  const me = useSession();
  const t = terminologyOf(me);
  const tags = useClientTags(me.business.id, true);
  const options = useClientFormOptions(me.business.id);
  const ids = { from: useId(), to: useId(), staff: useId(), location: useId(), vip: useId() };
  const tagList = useMemo(() => {
    const known = tags.data ?? [];
    // Una etiqueta del filtro que ya no está en uso se sigue mostrando (para poder quitarla).
    const extra = filters.tags.filter((tag) => !known.some((k) => k.tag === tag)).map((tag) => ({ tag, count: 0 }));
    return [...known, ...extra];
  }, [tags.data, filters.tags]);

  return (
    <section id="clients-filters" className="card clients-filters" aria-label="Filtros">
      <div className="clients-filters-grid">
        <fieldset className="field clients-filter-tags">
          <legend>Etiquetas</legend>
          {tags.isPending ? (
            <p className="muted">Cargando…</p>
          ) : tagList.length === 0 ? (
            <p className="muted">Todavía no hay etiquetas.</p>
          ) : (
            <div className="clients-tag-options">
              {tagList.map(({ tag, count }) => {
                const checked = filters.tags.includes(tag);
                return (
                  <label key={tag} className={"clients-tag-option" + (checked ? " checked" : "")}>
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => onChange({ tag: checked ? filters.tags.filter((x) => x !== tag) : [...filters.tags, tag] })}
                    />
                    {tag}
                    {count > 0 && <span className="muted"> · {count}</span>}
                  </label>
                );
              })}
            </div>
          )}
        </fieldset>

        <div className="field clients-filter-range">
          <span className="field-label">Última visita</span>
          <div className="clients-range">
            <label htmlFor={ids.from} className="visually-hidden">
              Última visita desde
            </label>
            <input id={ids.from} type="date" className="input" value={filters.lastVisitFrom} max={filters.lastVisitTo || undefined} onChange={(e) => onChange({ from: e.target.value })} />
            <span aria-hidden="true">a</span>
            <label htmlFor={ids.to} className="visually-hidden">
              Última visita hasta
            </label>
            <input id={ids.to} type="date" className="input" value={filters.lastVisitTo} min={filters.lastVisitFrom || undefined} onChange={(e) => onChange({ to: e.target.value })} />
          </div>
        </div>

        <div className="field">
          <label htmlFor={ids.staff} className="field-label">
            {capitalize(t.staffMember)} preferido
          </label>
          <select id={ids.staff} className="input select" value={filters.preferredStaffId} onChange={(e) => onChange({ staff: e.target.value })}>
            <option value="">Cualquiera</option>
            {(options.data?.staff ?? []).map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </div>

        <div className="field">
          <label htmlFor={ids.location} className="field-label">
            {capitalize(t.location)} preferida
          </label>
          <select id={ids.location} className="input select" value={filters.preferredLocationId} onChange={(e) => onChange({ location: e.target.value })}>
            <option value="">Cualquiera</option>
            {(options.data?.locations ?? []).map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
        </div>

        <div className="field">
          <label htmlFor={ids.vip} className="field-label">
            VIP
          </label>
          <select id={ids.vip} className="input select" value={filters.vip} onChange={(e) => onChange({ vip: e.target.value })}>
            <option value="">Todos</option>
            <option value="true">Solo VIP</option>
            <option value="false">Sin VIP</option>
          </select>
        </div>
      </div>
      <div className="clients-filters-actions">
        <span className="muted">Estado: {filters.statuses.length ? filters.statuses.map((s) => STATUS_LABELS[s]).join(", ") : "todos"} (con los chips de abajo).</span>
        <button type="button" className="link-button" onClick={onClear} disabled={!hasCrmFilters(filters)}>
          Limpiar filtros
        </button>
      </div>
    </section>
  );
}
