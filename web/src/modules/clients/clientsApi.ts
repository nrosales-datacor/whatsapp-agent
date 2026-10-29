import { keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, API_PREFIX, ApiError, IS_MOCK_API, messageForCode } from "../../lib/api";

// ─────────────────────────────────────────────────────────────────────────────
// Endpoints de clientes (/api/panel/clients*, I1 + CRM del Pro en I3). Tipos escritos a
// mano como espejo de src/modules/clients/{search,service,routes,importer}.ts mientras los
// esquemas Zod no se compartan con el front; si el backend cambia la forma, cambia acá y en
// ./clientsMock.ts.
// ─────────────────────────────────────────────────────────────────────────────

export type ClientChannel = "whatsapp" | "email";
export type ClientSort = "name" | "last_visit" | "total_spent" | "visit_count";
/** Orden de la ficha básica (los dos planes); los demás son del CRM completo. */
export const BASIC_SORTS: readonly ClientSort[] = ["name", "last_visit"];
export const CLIENT_STATUSES = ["new", "active", "vip", "at_risk", "inactive"] as const;
export type ClientStatus = (typeof CLIENT_STATUSES)[number];

/** Fila de `GET /clients`. */
export interface ClientSummary {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  tags: string[];
  visitCount: number;
  /** ISO 8601. */
  lastVisitAt: string | null;
  totalSpentCents: number;
  /** Estado calculado; null sin el CRM completo (Básico). */
  status: ClientStatus | null;
  /** VIP manual o por reglas; null sin el CRM completo. */
  isVip: boolean | null;
}

export interface ClientPage {
  items: ClientSummary[];
  nextCursor: string | null;
}

export interface ClientRef {
  id: string;
  name: string;
}

/** `GET /clients/:id` (y respuesta de PATCH y anonimizar). */
export interface ClientDetail {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  /** "AAAA-MM-DD". */
  birthDate: string | null;
  guardianId: string | null;
  notes: string | null;
  tags: string[];
  source: string | null;
  preferredLocationId: string | null;
  preferredStaffId: string | null;
  preferredChannel: ClientChannel | null;
  /** VIP manual. */
  vip: boolean;
  /** Campos personalizados (`clave → valor`). */
  customData: Record<string, unknown>;
  marketingConsentAt: string | null;
  marketingOptOutAt: string | null;
  visitCount: number;
  firstVisitAt: string | null;
  lastVisitAt: string | null;
  totalSpentCents: number;
  anonymized: boolean;
  anonymizedAt: string | null;
  createdAt: string;
  updatedAt: string;
  guardian: ClientRef | null;
  dependents: ClientRef[];
  /** Estado calculado; null sin el CRM completo. */
  status: ClientStatus | null;
  /** VIP manual o por reglas; null sin el CRM completo. */
  isVip: boolean | null;
}

/** Alta (`POST /clients`): solo `name` es obligatorio; "" o null = sin dato. */
export interface NewClientInput {
  name: string;
  phone?: string | null;
  email?: string | null;
}

/** Edición (`PATCH /clients/:id`): solo las claves presentes cambian. */
export interface ClientPatch {
  name?: string;
  phone?: string | null;
  email?: string | null;
  birthDate?: string | null;
  notes?: string | null;
  tags?: string[];
  preferredLocationId?: string | null;
  preferredStaffId?: string | null;
  preferredChannel?: ClientChannel | null;
  guardianId?: string | null;
  /** CRM del Pro. */
  vip?: boolean;
  /** CRM del Pro: solo las claves que cambian; null borra. */
  customData?: Record<string, unknown>;
}

/** Filtros de la lista (CRM del Pro, salvo `q`). Espejo de `ClientFiltersQuery`. */
export interface ClientFilters {
  q: string;
  statuses: ClientStatus[];
  tags: string[];
  /** "AAAA-MM-DD" o "". */
  lastVisitFrom: string;
  lastVisitTo: string;
  preferredStaffId: string;
  preferredLocationId: string;
  /** "" = todos. */
  vip: "" | "true" | "false";
}

export const EMPTY_FILTERS: ClientFilters = {
  q: "",
  statuses: [],
  tags: [],
  lastVisitFrom: "",
  lastVisitTo: "",
  preferredStaffId: "",
  preferredLocationId: "",
  vip: "",
};

/** Cantidad por estado con los filtros (`GET /clients/status-counts`). */
export type ClientStatusCounts = Record<ClientStatus, number> & { total: number };

/** `GET /clients/form-options`: todas las sucursales y profesionales del negocio. */
export interface ClientFormOptions {
  locations: { id: string; name: string; active: boolean }[];
  staff: { id: string; name: string; active: boolean }[];
}

export const PAGE_SIZE = 50;

export const clientKeys = {
  all: (businessId: string) => ["clients", businessId] as const,
  list: (businessId: string, query: string) => ["clients", businessId, "list", query] as const,
  counts: (businessId: string, query: string) => ["clients", businessId, "counts", query] as const,
  tags: (businessId: string) => ["clients", businessId, "tags"] as const,
  detail: (businessId: string, id: string) => ["clients", businessId, "detail", id] as const,
  options: (businessId: string) => ["clients", businessId, "form-options"] as const,
};

/** Filtros → query string (sin los vacíos). */
export function filtersQuery(filters: Partial<ClientFilters>): URLSearchParams {
  const params = new URLSearchParams();
  if (filters.q?.trim()) params.set("q", filters.q.trim());
  if (filters.statuses?.length) params.set("status", filters.statuses.join(","));
  for (const tag of filters.tags ?? []) params.append("tag", tag);
  if (filters.lastVisitFrom) params.set("lastVisitFrom", filters.lastVisitFrom);
  if (filters.lastVisitTo) params.set("lastVisitTo", filters.lastVisitTo);
  if (filters.preferredStaffId) params.set("preferredStaffId", filters.preferredStaffId);
  if (filters.preferredLocationId) params.set("preferredLocationId", filters.preferredLocationId);
  if (filters.vip) params.set("vip", filters.vip);
  return params;
}

function listPath(filters: Partial<ClientFilters>, sort: ClientSort, cursor: string | null, limit = PAGE_SIZE): string {
  const params = filtersQuery(filters);
  params.set("sort", sort);
  params.set("limit", String(limit));
  if (cursor) params.set("cursor", cursor);
  return `/clients?${params.toString()}`;
}

export const searchClients = (q: string, limit = 8) => api.get<ClientPage>(listPath({ q }, "name", null, limit));

/** Lista paginada ("Ver más" pide la página siguiente con el cursor). */
export function useClientList(businessId: string, filters: Partial<ClientFilters>, sort: ClientSort) {
  return useInfiniteQuery({
    queryKey: clientKeys.list(businessId, listPath(filters, sort, null)),
    queryFn: ({ pageParam }) => api.get<ClientPage>(listPath(filters, sort, pageParam)),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    placeholderData: (previous) => previous,
  });
}

/** Chips de estado: cantidad por estado con los demás filtros (CRM del Pro). */
export function useClientStatusCounts(businessId: string, filters: Partial<ClientFilters>, enabled: boolean) {
  const query = filtersQuery({ ...filters, statuses: [] }).toString();
  return useQuery({
    queryKey: clientKeys.counts(businessId, query),
    queryFn: () => api.get<ClientStatusCounts>(`/clients/status-counts${query ? `?${query}` : ""}`),
    enabled,
    placeholderData: keepPreviousData,
  });
}

/** Etiquetas en uso (para el filtro). */
export function useClientTags(businessId: string, enabled: boolean) {
  return useQuery({
    queryKey: clientKeys.tags(businessId),
    queryFn: () => api.get<{ tag: string; count: number }[]>("/clients/tags"),
    enabled,
    staleTime: 60_000,
  });
}

// ── Exportar ────────────────────────────────────────────────────────────────

function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/**
 * Descarga el CSV de clientes con los filtros (`GET /clients/export.csv`). Un error del
 * backend (JSON) se lanza como `ApiError`. En modo mock, el archivo lo arma el mock.
 */
export async function downloadClientsCsv(filters: Partial<ClientFilters>): Promise<void> {
  const query = filtersQuery(filters).toString();
  const path = `/clients/export.csv${query ? `?${query}` : ""}`;
  if (IS_MOCK_API) {
    const { mockTransport } = await import("../../lib/mockApi");
    const res = await mockTransport({ method: "GET", path, headers: {}, body: undefined });
    const payload = res.payload as { ok: boolean; data?: { filename: string; content: string }; error?: string; code?: string };
    if (!payload.ok || !payload.data) {
      const code = payload.code ?? "http_error";
      throw new ApiError(res.status, payload.error ?? messageForCode(code), code, {}, path);
    }
    saveBlob(new Blob([payload.data.content], { type: "text/csv;charset=utf-8" }), payload.data.filename);
    return;
  }
  let res: Response;
  try {
    res = await fetch(API_PREFIX + path, { credentials: "same-origin" });
  } catch {
    throw new ApiError(0, messageForCode("network_error"), "network_error", {}, path);
  }
  if (!res.ok || !(res.headers.get("content-type") ?? "").startsWith("text/csv")) {
    let body: { error?: string; code?: string } = {};
    try {
      body = (await res.json()) as typeof body;
    } catch {
      // sin cuerpo JSON
    }
    const code = body.code ?? "http_error";
    throw new ApiError(res.status, body.error ?? messageForCode(code), code, {}, path);
  }
  const filename = /filename="([^"]+)"/.exec(res.headers.get("content-disposition") ?? "")?.[1] ?? "clientes.csv";
  saveBlob(await res.blob(), filename);
}

// ── Importar ────────────────────────────────────────────────────────────────

export type ImportAction = "create" | "update" | "skip" | "error";

/** `POST /clients/import`. */
export interface ImportRequest {
  csv: string;
  hasHeader?: boolean | null;
  mapping?: Record<string, string | null> | null;
  onExisting?: "update" | "skip";
  commit?: boolean;
}

/** Respuesta de `POST /clients/import` (vista previa o importación). */
export interface ImportReport {
  delimiter: string;
  hasHeader: boolean;
  columns: { index: number; header: string | null; samples: string[] }[];
  mapping: Record<string, string | null>;
  fields: { id: string; label: string }[];
  totalRows: number;
  summary: Record<ImportAction, number>;
  preview: { row: number; action: ImportAction; name: string | null; phone: string | null; email: string | null; errors: string[] }[];
  errors: { row: number; messages: string[] }[];
  committed: boolean;
}

export function useImportClients(businessId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: ImportRequest) => api.post<ImportReport>("/clients/import", input),
    onSuccess: (report) => {
      if (report.committed) void qc.invalidateQueries({ queryKey: clientKeys.all(businessId) });
    },
  });
}

export function useClient(businessId: string, id: string) {
  return useQuery({ queryKey: clientKeys.detail(businessId, id), queryFn: () => api.get<ClientDetail>(`/clients/${encodeURIComponent(id)}`) });
}

export function useClientFormOptions(businessId: string) {
  return useQuery({
    queryKey: clientKeys.options(businessId),
    queryFn: () => api.get<ClientFormOptions>("/clients/form-options"),
    staleTime: 5 * 60_000,
  });
}

export function useCreateClient(businessId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: NewClientInput) => api.post<ClientDetail>("/clients", input),
    onSuccess: () => void qc.invalidateQueries({ queryKey: [...clientKeys.all(businessId), "list"] }),
  });
}

/** Deja la ficha nueva en la caché y refresca las listas (y las fichas vinculadas: responsable y menores). */
function useStoreDetail(businessId: string) {
  const qc = useQueryClient();
  return (detail: ClientDetail) => {
    qc.setQueryData(clientKeys.detail(businessId, detail.id), detail);
    void qc.invalidateQueries({
      queryKey: clientKeys.all(businessId),
      predicate: (query) => !(query.queryKey[2] === "detail" && query.queryKey[3] === detail.id),
    });
  };
}

export function useUpdateClient(businessId: string, id: string) {
  const store = useStoreDetail(businessId);
  return useMutation({
    mutationFn: (patch: ClientPatch) => api.patch<ClientDetail>(`/clients/${encodeURIComponent(id)}`, patch),
    onSuccess: store,
  });
}

export function useAnonymizeClient(businessId: string, id: string) {
  const store = useStoreDetail(businessId);
  return useMutation({
    mutationFn: (confirmation: string) => api.post<ClientDetail>(`/clients/${encodeURIComponent(id)}/anonymize`, { confirmation }),
    onSuccess: store,
  });
}
