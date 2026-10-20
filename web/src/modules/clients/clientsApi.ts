import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../lib/api";

// ─────────────────────────────────────────────────────────────────────────────
// Endpoints de clientes (/api/panel/clients*, I1). Tipos escritos a mano como espejo de
// src/modules/clients/{search,service,routes}.ts mientras los esquemas Zod no se
// compartan con el front; si el backend cambia la forma, cambia acá y en ./clientsMock.ts.
// ─────────────────────────────────────────────────────────────────────────────

export type ClientChannel = "whatsapp" | "email";
export type ClientSort = "name" | "last_visit";

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
  vip: boolean;
  marketingConsentAt: string | null;
  marketingOptOutAt: string | null;
  visitCount: number;
  firstVisitAt: string | null;
  lastVisitAt: string | null;
  totalSpentCents: number;
  anonymized: boolean;
  createdAt: string;
  updatedAt: string;
  guardian: ClientRef | null;
  dependents: ClientRef[];
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
}

/** `GET /clients/form-options`: todas las sucursales y profesionales del negocio. */
export interface ClientFormOptions {
  locations: { id: string; name: string; active: boolean }[];
  staff: { id: string; name: string; active: boolean }[];
}

export const PAGE_SIZE = 50;

export const clientKeys = {
  all: (businessId: string) => ["clients", businessId] as const,
  list: (businessId: string, q: string, sort: ClientSort) => ["clients", businessId, "list", q, sort] as const,
  detail: (businessId: string, id: string) => ["clients", businessId, "detail", id] as const,
  options: (businessId: string) => ["clients", businessId, "form-options"] as const,
};

function listPath(q: string, sort: ClientSort, cursor: string | null, limit = PAGE_SIZE): string {
  const params = new URLSearchParams({ sort, limit: String(limit) });
  if (q.trim()) params.set("q", q.trim());
  if (cursor) params.set("cursor", cursor);
  return `/clients?${params.toString()}`;
}

export const searchClients = (q: string, limit = 8) => api.get<ClientPage>(listPath(q, "name", null, limit));

/** Lista paginada ("Ver más" pide la página siguiente con el cursor). */
export function useClientList(businessId: string, q: string, sort: ClientSort) {
  return useInfiniteQuery({
    queryKey: clientKeys.list(businessId, q.trim(), sort),
    queryFn: ({ pageParam }) => api.get<ClientPage>(listPath(q, sort, pageParam)),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    placeholderData: (previous) => previous,
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
