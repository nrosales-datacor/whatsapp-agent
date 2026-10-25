import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../lib/api";
import type { ClientStatus } from "../clients/clientsApi";

// ─────────────────────────────────────────────────────────────────────────────
// Campañas (/api/panel/campaigns/*, I6.1; módulo "campaigns", dueño y admin). Tipos escritos
// a mano como espejo de src/modules/campaigns/{service,segment}.ts; si el backend cambia la
// forma, cambia acá y en ./campaignsMock.ts.
// ─────────────────────────────────────────────────────────────────────────────

export type CampaignStatus = "draft" | "scheduled" | "sending" | "completed" | "cancelled";
export type CampaignSendStatus = "pending" | "processing" | "sent" | "failed" | "skipped";

/** Segmento: los filtros del CRM más dos propios. Todo combinado con Y; vacío = todos los que aceptaron. */
export interface CampaignSegment {
  statuses?: ClientStatus[];
  tags?: string[];
  vip?: boolean;
  preferredLocationId?: string;
  preferredStaffId?: string;
  /** Última visita hace AL MENOS estos días. */
  lastVisitMinDays?: number;
  /** Última visita hace COMO MUCHO estos días. */
  lastVisitMaxDays?: number;
  /** "Te toca de nuevo": su último servicio completado fue hace al menos N meses. */
  lapsedService?: { serviceId: string; months: number };
  /** Sin quien ya tiene una cita próxima (default true). */
  excludeUpcoming?: boolean;
}

export interface SendCounts {
  total: number;
  pending: number;
  sent: number;
  failed: number;
  skipped: number;
}

export interface CampaignSummary {
  id: string;
  name: string;
  message: string;
  segment: CampaignSegment;
  status: CampaignStatus;
  scheduledFor: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  totalRecipients: number;
  counts: SendCounts;
}

export interface CampaignDetail extends CampaignSummary {
  results: { replied: number; appointments: number; clientsBooked: number };
  recipients: { clientId: string; name: string; status: CampaignSendStatus; error: string | null; sentAt: string | null }[];
}

export interface MarketingChannelStatus {
  connected: number;
  withTemplate: number;
}

export interface CampaignsOverview {
  consent: { clients: number; consented: number; optedOut: number };
  channels: MarketingChannelStatus;
}

export interface AudiencePreview {
  matched: number;
  eligible: number;
  withoutConsent: number;
  optedOut: number;
  withoutPhone: number;
  sample: { id: string; name: string }[];
  channels: MarketingChannelStatus;
}

export interface CampaignInput {
  name: string;
  message: string;
  segment: CampaignSegment;
}

/** Tope del mensaje (va en la variable {{2}} de la plantilla de marketing). */
export const MAX_MESSAGE = 900;

export const STATUS_LABELS: Record<CampaignStatus, string> = {
  draft: "Borrador",
  scheduled: "Programada",
  sending: "Enviando",
  completed: "Enviada",
  cancelled: "Cancelada",
};

export const SEND_STATUS_LABELS: Record<CampaignSendStatus, string> = {
  pending: "Pendiente",
  processing: "Enviando",
  sent: "Enviada",
  failed: "Falló",
  skipped: "Omitida",
};

export const campaignKeys = {
  all: ["campaigns"] as const,
  list: ["campaigns", "list"] as const,
  overview: ["campaigns", "overview"] as const,
  detail: (id: string) => ["campaigns", "detail", id] as const,
  preview: (segment: CampaignSegment) => ["campaigns", "preview", JSON.stringify(segment)] as const,
};

const path = (id: string) => `/campaigns/${encodeURIComponent(id)}`;

export const campaignsApi = {
  create: (input: CampaignInput) => api.post<CampaignDetail>("/campaigns", input),
  update: (id: string, patch: Partial<CampaignInput>) => api.patch<CampaignDetail>(path(id), patch),
  remove: (id: string) => api.delete<void>(path(id)),
  launch: (id: string, scheduledFor: string | null) => api.post<CampaignDetail>(`${path(id)}/launch`, { scheduledFor }),
  cancel: (id: string) => api.post<CampaignDetail>(`${path(id)}/cancel`),
  preview: (segment: CampaignSegment) => api.post<AudiencePreview>("/campaigns/preview", { segment }),
};

export function useCampaigns() {
  return useQuery({ queryKey: campaignKeys.list, queryFn: () => api.get<CampaignSummary[]>("/campaigns") });
}

export function useCampaignsOverview() {
  return useQuery({ queryKey: campaignKeys.overview, queryFn: () => api.get<CampaignsOverview>("/campaigns/overview") });
}

/** Detalle; mientras se manda (o está programada), se refresca solo. */
export function useCampaign(id: string) {
  return useQuery({
    queryKey: campaignKeys.detail(id),
    queryFn: () => api.get<CampaignDetail>(path(id)),
    refetchInterval: (query) => (query.state.data?.status === "sending" || query.state.data?.status === "scheduled" ? 3_000 : false),
  });
}

/** Vista previa del segmento (se pide de nuevo al cambiar los filtros). */
export function useAudiencePreview(segment: CampaignSegment, enabled = true) {
  return useQuery({
    queryKey: campaignKeys.preview(segment),
    queryFn: () => campaignsApi.preview(segment),
    placeholderData: (previous) => previous,
    enabled,
  });
}

/** Deja la campaña en la caché y refresca la lista. */
export function useCampaignStore() {
  const qc = useQueryClient();
  return (campaign: CampaignDetail | null | undefined) => {
    if (campaign) qc.setQueryData(campaignKeys.detail(campaign.id), campaign);
    void qc.invalidateQueries({ queryKey: campaignKeys.list });
  };
}

export function useCampaignMutation<T>(fn: (input: T) => Promise<CampaignDetail>) {
  const store = useCampaignStore();
  return useMutation({ mutationFn: fn, onSuccess: store });
}

/** Resumen corto del segmento para la lista y el detalle. */
export function segmentSummary(segment: CampaignSegment, labels: { status: (s: ClientStatus) => string; service?: (id: string) => string | undefined }): string {
  const parts: string[] = [];
  if (segment.statuses?.length) parts.push(segment.statuses.map(labels.status).join(" o "));
  if (segment.vip === true) parts.push("VIP");
  if (segment.tags?.length) parts.push(`etiqueta ${segment.tags.join(" o ")}`);
  if (segment.lastVisitMinDays) parts.push(`última visita hace ${segment.lastVisitMinDays}+ días`);
  if (segment.lastVisitMaxDays) parts.push(`última visita en los últimos ${segment.lastVisitMaxDays} días`);
  if (segment.lapsedService) {
    const name = labels.service?.(segment.lapsedService.serviceId) ?? "un servicio";
    parts.push(`${name} hace ${segment.lapsedService.months}+ meses`);
  }
  if (segment.preferredLocationId) parts.push("sucursal preferida");
  if (segment.preferredStaffId) parts.push("profesional preferido");
  return parts.length ? parts.join(" · ") : "Todos los que aceptaron promociones";
}
