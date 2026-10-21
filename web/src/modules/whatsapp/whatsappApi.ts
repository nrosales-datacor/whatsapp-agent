import { useCallback } from "react";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient, type InfiniteData } from "@tanstack/react-query";
import { api } from "../../lib/api";

// ─────────────────────────────────────────────────────────────────────────────
// Endpoints de WhatsApp IA (/api/panel/whatsapp/*, I2), todos del módulo "whatsapp".
// Tipos escritos a mano como espejo del contrato acordado con el backend mientras los
// esquemas Zod no se compartan con el front; si el backend cambia la forma, cambia acá y
// en ./whatsappMock.ts.
//
// Refresco: la bandeja se vuelve a pedir cada LIST_REFRESH_MS y el chat abierto cada
// CHAT_REFRESH_MS, solo con la pestaña visible (TanStack pausa los intervalos en segundo
// plano). Una notificación push con el panel abierto también refresca (app/push.tsx).
// ─────────────────────────────────────────────────────────────────────────────

export type ConversationStatus = "open" | "attended";
export type ConversationFilter = ConversationStatus | "all";
export type ConversationMode = "bot" | "human";
export type MessageDirection = "in" | "out";
export type MessageAuthor = "client" | "bot" | "human";
export type MediaType = "image" | "audio";

export interface ConversationClient {
  id: string;
  name: string | null;
  phone: string | null;
}

/** Fila de `GET /whatsapp/conversations` (y `conversation` del detalle). */
export interface ConversationSummary {
  id: string;
  client: ConversationClient;
  lastMessage: { text: string; at: string; direction: MessageDirection } | null;
  unread: number;
  mode: ConversationMode;
  status: ConversationStatus;
  /** Ventana de 24 h de WhatsApp abierta: se puede escribir texto libre. */
  windowOpen: boolean;
  nextAppointment: { id: string; startsAt: string } | null;
}

export interface ConversationPage {
  items: ConversationSummary[];
  nextCursor: string | null;
}

export interface Message {
  id: string;
  direction: MessageDirection;
  by: MessageAuthor;
  text: string;
  mediaUrl?: string | null;
  mediaType?: MediaType | null;
  /** ISO 8601. */
  at: string;
}

/** `GET /whatsapp/conversations/:id?before=`: los mensajes más nuevos primero por página. */
export interface ConversationDetail {
  conversation: ConversationSummary;
  messages: Message[];
  /** Cursor para pedir los mensajes anteriores (null = no hay más). */
  nextBefore: string | null;
}

export interface WhatsappSummary {
  conversationsWaiting: number;
  openConversations: number;
  conversationsThisWeek: number;
  bookingsByAgentThisWeek: number;
  handoffsThisWeek: number;
}

export interface WhatsappMetrics {
  conversations: number;
  resolvedWithoutHuman: number;
  bookingsByAgent: number;
  handoffs: number;
  /** Costo del modelo de IA en millonésimas de dólar. */
  aiCostMicros: number;
  byDay: { date: string; conversations: number; bookings: number }[];
}

export type Register = "vos" | "tu" | "usted";

export interface KnowledgeSection {
  id: string;
  title: string;
  items: string[];
}

export interface FaqEntry {
  question: string;
  answer: string;
}

export interface AgentSettings {
  tone: string;
  register: Register;
  instructions: string;
  knowledge: KnowledgeSection[];
  faq: FaqEntry[];
  /** Textos fijos del agente (saludo, aviso al pasar a una persona…), por clave. */
  texts: Record<string, string>;
}

export type ChannelStatus = "connected" | "token_expired" | "disconnected";

export interface ChannelTemplates {
  reminder: string;
  reopen: string;
  marketing: string;
}

export interface Channel {
  id: string;
  phoneNumber: string;
  displayName: string;
  locationId: string | null;
  status: ChannelStatus;
  templates: ChannelTemplates;
}

export interface SignupConfig {
  appId: string;
  configId: string;
  graphVersion: string;
}

export interface ChannelPatch {
  locationId: string | null;
  templates: ChannelTemplates;
}

export const LIST_REFRESH_MS = 15_000;
export const CHAT_REFRESH_MS = 5_000;
const SUMMARY_REFRESH_MS = 60_000;

export const whatsappKeys = {
  all: ["whatsapp"] as const,
  lists: ["whatsapp", "conversations"] as const,
  list: (status: ConversationFilter, q: string) => ["whatsapp", "conversations", status, q] as const,
  detail: (id: string) => ["whatsapp", "conversation", id] as const,
  summary: ["whatsapp", "summary"] as const,
  metrics: (from: string, to: string) => ["whatsapp", "metrics", from, to] as const,
  settings: ["whatsapp", "settings"] as const,
  channels: ["whatsapp", "channels"] as const,
};

const conversationPath = (id: string) => `/whatsapp/conversations/${encodeURIComponent(id)}`;

function listPath(status: ConversationFilter, q: string, cursor: string | null): string {
  const params = new URLSearchParams({ status });
  if (q.trim()) params.set("q", q.trim());
  if (cursor) params.set("cursor", cursor);
  return `/whatsapp/conversations?${params.toString()}`;
}

export const whatsappApi = {
  send: (id: string, text: string) => api.post<unknown>(`${conversationPath(id)}/messages`, { text }),
  setMode: (id: string, mode: ConversationMode) => api.post<unknown>(`${conversationPath(id)}/mode`, { mode }),
  setStatus: (id: string, status: ConversationStatus) => api.post<unknown>(`${conversationPath(id)}/status`, { status }),
  markRead: (id: string) => api.post<unknown>(`${conversationPath(id)}/read`),
  reopen: (id: string) => api.post<unknown>(`${conversationPath(id)}/reopen`),
  settings: () => api.get<AgentSettings>("/whatsapp/settings"),
  saveSettings: (settings: AgentSettings) => api.patch<AgentSettings>("/whatsapp/settings", settings),
  channels: () => api.get<Channel[]>("/whatsapp/channels"),
  signupConfig: () => api.get<SignupConfig>("/whatsapp/channels/signup-config"),
  connect: (code: string) => api.post<unknown>("/whatsapp/channels/connect", { code }),
  testChannel: (id: string) => api.post<unknown>(`/whatsapp/channels/${encodeURIComponent(id)}/test`),
  updateChannel: (id: string, patch: ChannelPatch) => api.patch<Channel>(`/whatsapp/channels/${encodeURIComponent(id)}`, patch),
};

/** Bandeja paginada ("Ver más" pide la página siguiente con el cursor). */
export function useConversationList(status: ConversationFilter, q: string) {
  return useInfiniteQuery({
    queryKey: whatsappKeys.list(status, q.trim()),
    queryFn: ({ pageParam }) => api.get<ConversationPage>(listPath(status, q, pageParam)),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    placeholderData: (previous) => previous,
    refetchInterval: LIST_REFRESH_MS,
  });
}

/**
 * Chat de una conversación. La primera página son los mensajes más nuevos; "Ver mensajes
 * anteriores" pide la siguiente con `before`. El refresco periódico vuelve a pedir las
 * páginas en orden (TanStack recalcula cada cursor desde la página nueva), así no quedan
 * huecos cuando llegan mensajes.
 */
export function useConversation(id: string) {
  return useInfiniteQuery({
    queryKey: whatsappKeys.detail(id),
    queryFn: ({ pageParam }) =>
      api.get<ConversationDetail>(pageParam ? `${conversationPath(id)}?before=${encodeURIComponent(pageParam)}` : conversationPath(id)),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextBefore,
    refetchInterval: CHAT_REFRESH_MS,
  });
}

export function useWhatsappSummary() {
  return useQuery({ queryKey: whatsappKeys.summary, queryFn: () => api.get<WhatsappSummary>("/whatsapp/summary"), refetchInterval: SUMMARY_REFRESH_MS });
}

export function useWhatsappMetrics(from: string, to: string) {
  return useQuery({
    queryKey: whatsappKeys.metrics(from, to),
    queryFn: () => api.get<WhatsappMetrics>(`/whatsapp/metrics?${new URLSearchParams({ from, to }).toString()}`),
    placeholderData: (previous) => previous,
  });
}

export function useAgentSettings() {
  return useQuery({ queryKey: whatsappKeys.settings, queryFn: whatsappApi.settings });
}

export function useChannels() {
  return useQuery({ queryKey: whatsappKeys.channels, queryFn: whatsappApi.channels });
}

/**
 * Aplica un cambio a la conversación en todas las cachés (lista y chat) sin esperar al
 * próximo refresco, y después revalida la bandeja y el resumen del Inicio.
 */
export function useConversationUpdater() {
  const qc = useQueryClient();
  return useCallback((id: string, change: Partial<ConversationSummary>, options: { refetchDetail?: boolean } = {}) => {
    qc.setQueriesData<InfiniteData<ConversationPage>>({ queryKey: whatsappKeys.lists }, (data) =>
      data
        ? { ...data, pages: data.pages.map((p) => ({ ...p, items: p.items.map((c) => (c.id === id ? { ...c, ...change } : c)) })) }
        : data,
    );
    qc.setQueryData<InfiniteData<ConversationDetail>>(whatsappKeys.detail(id), (data) =>
      data ? { ...data, pages: data.pages.map((p) => ({ ...p, conversation: { ...p.conversation, ...change } })) } : data,
    );
    void qc.invalidateQueries({ queryKey: whatsappKeys.lists });
    void qc.invalidateQueries({ queryKey: whatsappKeys.summary });
    if (options.refetchDetail) void qc.invalidateQueries({ queryKey: whatsappKeys.detail(id) });
  }, [qc]);
}

/** Guarda la configuración del agente. `onSaved` corre aunque el formulario se vuelva a montar. */
export function useSaveAgentSettings(onSaved?: () => void) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: whatsappApi.saveSettings,
    // Si el backend no devolviera la configuración, queda la que se mandó.
    onSuccess: (saved, sent) => {
      qc.setQueryData(whatsappKeys.settings, saved ?? sent);
      onSaved?.();
    },
  });
}
