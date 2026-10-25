import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { SETTINGS_KEYS, settingsApi } from "../settings/settingsApi";

// ─────────────────────────────────────────────────────────────────────────────
// Contrato de la Agenda y del Inicio básico (I1) y sus llamadas. Escrito a mano, espejo de
// src/modules/scheduling/{appointments,availability,home,routes}.ts; si el backend cambia
// la forma, cambia acá y en ./schedulingMock.ts. Instantes en ISO 8601 (UTC), montos en
// céntimos.
// ─────────────────────────────────────────────────────────────────────────────

export type AppointmentStatus = "pending" | "confirmed" | "completed" | "cancelled" | "no_show";
export type AppointmentChannel = "whatsapp_ai" | "panel" | "phone" | "walk_in" | "web";
/** Canales que el equipo elige al cargar una cita. */
export type PanelChannel = "panel" | "phone" | "walk_in";

export interface AppointmentLine {
  id: string;
  serviceId: string | null;
  name: string;
  durationMin: number;
  priceCents: number;
  position: number;
}

export interface Appointment {
  id: string;
  locationId: string;
  clientId: string;
  staffId: string;
  startsAt: string;
  /** Fin de lo que ocupa al profesional (incluye el buffer del último servicio). */
  endsAt: string;
  status: AppointmentStatus;
  channel: AppointmentChannel;
  totalCents: number;
  notes: string | null;
  /** Campos personalizados de la cita (CRM del Pro), por clave. */
  customData: Record<string, unknown>;
  createdBy: string | null;
  confirmedAt: string | null;
  cancelledAt: string | null;
  cancellationReason: string | null;
  createdAt: string;
  updatedAt: string;
  client: { id: string; name: string; phone: string | null; email: string | null } | null;
  staff: { id: string; name: string; color: string | null } | null;
  location: { id: string; name: string; timezone: string } | null;
  services: AppointmentLine[];
}

export interface SlotStaff {
  id: string;
  name: string;
  color: string | null;
  endsAt: string;
  durationMin: number;
  totalCents: number;
}

export interface Slot {
  startsAt: string;
  staff: SlotStaff[];
}

export interface AvailabilityResult {
  date: string;
  timezone: string;
  locationId: string;
  slots: Slot[];
}

export interface ClientHistoryPage {
  items: Appointment[];
  nextCursor: string | null;
}

export interface HomeToday {
  date: string;
  timezone: string;
  locationId: string | null;
  generatedAt: string;
  today: { total: number; byStatus: Record<AppointmentStatus, number> };
  upcoming: Appointment[];
  unconfirmed: Appointment[];
  noShowsToday: Appointment[];
  aiBookings: { count: number; recent: Appointment[] };
  /** null hasta que llegue WhatsApp IA (I2). */
  conversationsWaiting: number | null;
}

export interface NewAppointmentInput {
  locationId: string;
  clientId: string;
  serviceIds: string[];
  /** Un profesional o "any" (el primero libre). */
  staffId: string | "any";
  startsAt: string;
  channel?: PanelChannel;
  notes?: string | null;
  /** Campos personalizados de la cita (solo con el CRM completo). */
  customData?: Record<string, unknown>;
  allowOutsideHours?: boolean;
}

export interface AvailabilityParams {
  locationId: string;
  date: string;
  serviceIds: string[];
  staffId: string | "any";
  excludeAppointmentId?: string;
}

// ── Claves de query ─────────────────────────────────────────────────────────

export const scheduleKeys = {
  all: ["scheduling"] as const,
  range: (from: string, to: string, staffId: string | null) => ["scheduling", "appointments", from, to, staffId] as const,
  detail: (id: string) => ["scheduling", "appointment", id] as const,
  availability: (p: AvailabilityParams) =>
    ["scheduling", "availability", p.locationId, p.date, p.serviceIds.join(","), p.staffId, p.excludeAppointmentId ?? ""] as const,
  clientHistory: (clientId: string) => ["scheduling", "client-history", clientId] as const,
  home: ["scheduling", "home"] as const,
};

const enc = encodeURIComponent;

export const schedulingApi = {
  listAppointments: (from: string, to: string, staffId?: string | null) => {
    const params = new URLSearchParams({ from, to });
    if (staffId) params.set("staffId", staffId);
    return api.get<Appointment[]>(`/appointments?${params.toString()}`);
  },
  getAppointment: (id: string) => api.get<Appointment>(`/appointments/${enc(id)}`),
  availability: (p: AvailabilityParams) => {
    const params = new URLSearchParams({ locationId: p.locationId, date: p.date, serviceIds: p.serviceIds.join(","), staffId: p.staffId });
    if (p.excludeAppointmentId) params.set("excludeAppointmentId", p.excludeAppointmentId);
    return api.get<AvailabilityResult>(`/availability?${params.toString()}`);
  },
  create: (input: NewAppointmentInput) => api.post<Appointment>("/appointments", input),
  updateNotes: (id: string, notes: string | null) => api.patch<Appointment>(`/appointments/${enc(id)}`, { notes }),
  updateCustomData: (id: string, customData: Record<string, unknown>) => api.patch<Appointment>(`/appointments/${enc(id)}`, { customData }),
  confirm: (id: string) => api.post<Appointment>(`/appointments/${enc(id)}/confirm`),
  complete: (id: string) => api.post<Appointment>(`/appointments/${enc(id)}/complete`),
  noShow: (id: string) => api.post<Appointment>(`/appointments/${enc(id)}/no-show`),
  cancel: (id: string, reason: string | null) => api.post<Appointment>(`/appointments/${enc(id)}/cancel`, { reason }),
  reschedule: (id: string, startsAt: string, staffId?: string) =>
    api.post<Appointment>(`/appointments/${enc(id)}/reschedule`, staffId ? { startsAt, staffId } : { startsAt }),
  assign: (id: string, staffId: string) => api.post<Appointment>(`/appointments/${enc(id)}/assign`, { staffId }),
  clientHistory: (clientId: string, cursor: string | null) => {
    const params = new URLSearchParams({ limit: "10" });
    if (cursor) params.set("cursor", cursor);
    return api.get<ClientHistoryPage>(`/clients/${enc(clientId)}/appointments?${params.toString()}`);
  },
  home: () => api.get<HomeToday>("/home/today"),
};

// ── Hooks ───────────────────────────────────────────────────────────────────

/** Citas que empiezan en [from, to) (la sucursal viaja en X-Location-Id). */
export function useAppointments(from: string, to: string, staffId: string | null = null) {
  return useQuery({
    queryKey: scheduleKeys.range(from, to, staffId),
    queryFn: () => schedulingApi.listAppointments(from, to, staffId),
    placeholderData: (previous) => previous,
  });
}

export function useAppointment(id: string | null) {
  return useQuery({
    queryKey: scheduleKeys.detail(id ?? ""),
    queryFn: () => schedulingApi.getAppointment(id as string),
    enabled: Boolean(id),
  });
}

export function useAvailability(params: AvailabilityParams | null) {
  return useQuery({
    queryKey: params ? scheduleKeys.availability(params) : ["scheduling", "availability", "off"],
    queryFn: () => schedulingApi.availability(params as AvailabilityParams),
    enabled: Boolean(params && params.serviceIds.length > 0 && params.locationId && params.date),
  });
}

/** Sucursales (con horario), profesionales (con horario) y servicios: lo que pinta la agenda. */
export function useAgendaSetup() {
  const locations = useQuery({ queryKey: SETTINGS_KEYS.locations, queryFn: settingsApi.listLocations, staleTime: 60_000 });
  const staff = useQuery({ queryKey: SETTINGS_KEYS.staff, queryFn: settingsApi.listStaff, staleTime: 60_000 });
  const catalog = useQuery({ queryKey: SETTINGS_KEYS.catalog, queryFn: settingsApi.getCatalog, staleTime: 60_000 });
  return { locations, staff, catalog };
}

export function useClientHistory(clientId: string) {
  return useInfiniteQuery({
    queryKey: scheduleKeys.clientHistory(clientId),
    queryFn: ({ pageParam }) => schedulingApi.clientHistory(clientId, pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
  });
}

export function useHomeToday() {
  return useQuery({ queryKey: scheduleKeys.home, queryFn: schedulingApi.home, refetchInterval: 60_000 });
}

/** Después de cualquier cambio de una cita: la cita en caché y todo lo de la agenda se refresca. */
export function useAppointmentStore() {
  const qc = useQueryClient();
  return (appointment: Appointment) => {
    qc.setQueryData(scheduleKeys.detail(appointment.id), appointment);
    void qc.invalidateQueries({
      queryKey: scheduleKeys.all,
      predicate: (q) => !(q.queryKey[1] === "appointment" && q.queryKey[2] === appointment.id),
    });
  };
}

export function useCreateAppointment() {
  const store = useAppointmentStore();
  return useMutation({ mutationFn: schedulingApi.create, onSuccess: store });
}
