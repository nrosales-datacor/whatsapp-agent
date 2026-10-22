import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../lib/api";
import type { Me } from "../../lib/contract";
import type { ClientStatus } from "./clientsApi";

// ─────────────────────────────────────────────────────────────────────────────
// CRM de clientes del plan Pro (I3): campos personalizados (`/settings/custom-fields`) y
// reglas del estado del cliente (`/settings/client-rules`). Espejo escrito a mano de
// src/modules/business/{customFields,statusRules,clientRules}.ts; si el backend cambia la
// forma, cambia acá y en ./clientsMock.ts.
// ─────────────────────────────────────────────────────────────────────────────

/** ¿El plan trae el CRM completo de clientes? (`me.plan.clientsTier`). */
export function hasCrm(me: Me): boolean {
  return me.plan.clientsTier === "full";
}

/** Dueño y administración: los que editan Configuración, importan y exportan. */
export function isManager(role: string): boolean {
  return role === "owner" || role === "admin";
}

// ── Estado ──────────────────────────────────────────────────────────────────

export const STATUS_LABELS: Record<ClientStatus, string> = {
  new: "Nuevo",
  active: "Activo",
  vip: "VIP",
  at_risk: "En riesgo",
  inactive: "Inactivo",
};

/** Qué significa cada estado (ayuda de los chips y de la ficha). */
export const STATUS_HELP: Record<ClientStatus, string> = {
  new: "Vino por primera vez hace poco (o todavía no vino).",
  active: "Viene con normalidad.",
  vip: "VIP marcado a mano o por sus visitas o su gasto.",
  at_risk: "Hace rato que no vuelve: buen momento para escribirle.",
  inactive: "Hace mucho que no viene.",
};

// ── Campos personalizados ───────────────────────────────────────────────────

export type CustomFieldEntity = "client" | "appointment";
export type CustomFieldType = "text" | "long_text" | "number" | "date" | "boolean" | "select" | "multi_select";

export const FIELD_TYPE_LABELS: Record<CustomFieldType, string> = {
  text: "Texto corto",
  long_text: "Texto largo",
  number: "Número",
  date: "Fecha",
  boolean: "Sí / no",
  select: "Una opción",
  multi_select: "Varias opciones",
};

/** Cambios de tipo que no rompen lo ya cargado (espejo del backend). */
export const COMPATIBLE_TYPES: Record<CustomFieldType, CustomFieldType[]> = {
  text: ["long_text"],
  long_text: ["text"],
  number: [],
  date: [],
  boolean: [],
  select: ["multi_select"],
  multi_select: [],
};

export const hasOptions = (type: CustomFieldType) => type === "select" || type === "multi_select";

export interface CustomField {
  id: string;
  entity: CustomFieldEntity;
  key: string;
  label: string;
  type: CustomFieldType;
  options: string[];
  required: boolean;
  position: number;
  active: boolean;
}

export interface NewCustomFieldInput {
  entity: CustomFieldEntity;
  label: string;
  type: CustomFieldType;
  options?: string[];
  required?: boolean;
}

export interface CustomFieldPatch {
  label?: string;
  type?: CustomFieldType;
  options?: string[];
  required?: boolean;
  active?: boolean;
}

export const crmKeys = {
  fields: (businessId: string, entity: CustomFieldEntity, all: boolean) => ["crm", businessId, "custom-fields", entity, all] as const,
  allFields: (businessId: string) => ["crm", businessId, "custom-fields"] as const,
  rules: (businessId: string) => ["crm", businessId, "client-rules"] as const,
};

/** Definiciones de una entidad (activas; con `includeInactive`, también las desactivadas para Configuración). */
export function useCustomFields(businessId: string, entity: CustomFieldEntity, options: { includeInactive?: boolean; enabled?: boolean } = {}) {
  const all = Boolean(options.includeInactive);
  return useQuery({
    queryKey: crmKeys.fields(businessId, entity, all),
    queryFn: () => api.get<CustomField[]>(`/settings/custom-fields?entity=${entity}${all ? "&includeInactive=1" : ""}`),
    enabled: options.enabled ?? true,
    staleTime: 60_000,
  });
}

export function useCustomFieldMutations(businessId: string) {
  const qc = useQueryClient();
  const refresh = () => void qc.invalidateQueries({ queryKey: crmKeys.allFields(businessId) });
  return {
    create: useMutation({ mutationFn: (input: NewCustomFieldInput) => api.post<CustomField>("/settings/custom-fields", input), onSuccess: refresh }),
    update: useMutation({
      mutationFn: ({ id, patch }: { id: string; patch: CustomFieldPatch }) => api.patch<CustomField>(`/settings/custom-fields/${encodeURIComponent(id)}`, patch),
      onSuccess: refresh,
    }),
    archive: useMutation({ mutationFn: (id: string) => api.delete<CustomField>(`/settings/custom-fields/${encodeURIComponent(id)}`), onSuccess: refresh }),
    reorder: useMutation({
      mutationFn: (input: { entity: CustomFieldEntity; ids: string[] }) => api.put<CustomField[]>("/settings/custom-fields/order", input),
      onSettled: refresh,
    }),
  };
}

// ── Reglas del estado ───────────────────────────────────────────────────────

export type AtRiskMode = "fixed" | "frequency";

export interface ClientStatusRules {
  newDays: number;
  vipMinVisits: number | null;
  vipMinSpentCents: number | null;
  atRiskMode: AtRiskMode;
  atRiskAfterDays: number;
  atRiskFrequencyFactor: number;
  inactiveAfterDays: number;
}

/** `GET /settings/client-rules`. */
export interface ClientRulesView {
  rules: ClientStatusRules;
  /** Las de la plantilla del rubro ("Restaurar las del rubro"). */
  industryDefaults: ClientStatusRules;
  industry: string;
}

export function useClientRules(businessId: string) {
  return useQuery({ queryKey: crmKeys.rules(businessId), queryFn: () => api.get<ClientRulesView>("/settings/client-rules") });
}

export function useSaveClientRules(businessId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (rules: ClientStatusRules) => api.put<ClientRulesView>("/settings/client-rules", rules),
    onSuccess: (view) => {
      qc.setQueryData(crmKeys.rules(businessId), view);
      // El estado de la lista y de las fichas cambia con las reglas.
      void qc.invalidateQueries({ queryKey: ["clients", businessId] });
    },
  });
}
