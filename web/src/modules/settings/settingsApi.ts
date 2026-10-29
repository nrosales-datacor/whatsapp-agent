import { api } from "../../lib/api";
import type { Branding } from "../../lib/branding";
import type { Me, Role, Terminology } from "../../lib/contract";
import type { WeeklyBlock } from "./hoursDraft";

// ─────────────────────────────────────────────────────────────────────────────
// Contrato de Configuración (I1) y sus llamadas. Escrito a mano, espejo de:
//   src/modules/business/{businessSettings,locations,hours}.ts   /settings/business, /settings/locations
//   src/modules/catalog/{services,staffServices}.ts              /settings/services, /settings/service-categories,
//                                                                /settings/staff/:id/services
//   src/modules/team/{staff,timeOff,members,invitations}.ts      /settings/staff, /settings/time-off, /team/*
// Si el backend cambia la forma, cambia acá (y en ./settingsMock.ts). Montos en céntimos.
// ─────────────────────────────────────────────────────────────────────────────

// ── Negocio ─────────────────────────────────────────────────────────────────

export type ReminderChannel = "whatsapp" | "email";

export interface BusinessLegalInfo {
  legalName: string | null;
  taxId: string | null;
  billingEmail: string | null;
}

export interface BusinessSettings {
  id: string;
  slug: string;
  name: string;
  industry: string;
  plan: string;
  status: string;
  timezone: string;
  currency: string;
  country: string;
  terminology: Terminology;
  reminderChannels: ReminderChannel[];
  branding: Branding;
  brandingEditable: boolean;
  /** null para quien no edita la configuración. */
  legal: BusinessLegalInfo | null;
  updatedAt: string;
}

export interface BusinessSettingsPatch {
  name?: string;
  legalName?: string | null;
  taxId?: string | null;
  billingEmail?: string | null;
  timezone?: string;
  currency?: string;
  country?: string;
  /** Vacío = volver al default. */
  terminology?: Partial<Record<keyof Terminology, string>>;
  reminderChannels?: ReminderChannel[];
  branding?: Partial<Record<keyof Branding, string | null>>;
}

// ── Horarios y sucursales ───────────────────────────────────────────────────

export type { WeeklyBlock };

export interface LocationView {
  id: string;
  name: string;
  address: string | null;
  phone: string | null;
  timezone: string;
  active: boolean;
  position: number;
  hours: WeeklyBlock[];
}

export interface LocationInput {
  name: string;
  address?: string | null;
  phone?: string | null;
  timezone?: string;
  active?: boolean;
}

export type DeleteResult<K extends string, T> = { deleted: true } | ({ deleted: false } & Record<K, T>);

// ── Catálogo ────────────────────────────────────────────────────────────────

export interface CategoryView {
  id: string;
  name: string;
  position: number;
}

export interface ServiceView {
  id: string;
  categoryId: string | null;
  name: string;
  description: string | null;
  durationMin: number;
  bufferMin: number;
  priceCents: number;
  variablePrice: boolean;
  onlineBooking: boolean;
  active: boolean;
  position: number;
  /** Vacío = en todas las sucursales. */
  locationIds: string[];
}

export interface CatalogView {
  categories: CategoryView[];
  services: ServiceView[];
}

export interface ServiceInput {
  categoryId: string | null;
  name: string;
  description: string | null;
  durationMin: number;
  bufferMin: number;
  priceCents: number;
  variablePrice: boolean;
  onlineBooking: boolean;
  active: boolean;
  locationIds: string[];
}

// ── Equipo ──────────────────────────────────────────────────────────────────

export interface StaffWeeklyBlock extends WeeklyBlock {
  staffId: string;
  locationId: string;
}

export interface StaffView {
  id: string;
  name: string;
  color: string | null;
  active: boolean;
  position: number;
  membershipId: string | null;
  member: { name: string; email: string } | null;
  hours: StaffWeeklyBlock[];
}

export interface StaffInput {
  name: string;
  color?: string | null;
  active?: boolean;
  membershipId?: string | null;
}

export interface StaffServiceItem {
  serviceId: string;
  priceCents: number | null;
  durationMin: number | null;
}

export interface StaffServicesView {
  staffId: string;
  /** true = hace todos los servicios. */
  allServices: boolean;
  services: StaffServiceItem[];
}

export type TimeOffScope = "business" | "location" | "staff";

export interface TimeOffEntry {
  id: string;
  scope: TimeOffScope;
  locationId: string | null;
  staffId: string | null;
  /** ISO 8601. */
  startsAt: string;
  endsAt: string;
  reason: string | null;
}

export interface TimeOffInput {
  locationId: string | null;
  staffId: string | null;
  startsAt: string;
  endsAt: string;
  reason: string | null;
}

// ── Usuarios (I0.6: /team/*) ────────────────────────────────────────────────

export type MemberStatus = "active" | "invited" | "inactive";

export interface Member {
  membershipId: string;
  userId: string;
  name: string;
  email: string;
  role: Role;
  active: boolean;
  status: MemberStatus;
  allLocations: boolean;
  locationIds: string[];
  totpEnabled: boolean;
  createdAt: string;
}

export interface InviteInput {
  email: string;
  name?: string;
  role: Role;
  locationIds?: string[];
}

export interface MemberPatch {
  role?: Role;
  active?: boolean;
  locationIds?: string[];
}

// ── Claves de query ─────────────────────────────────────────────────────────

export const SETTINGS_KEYS = {
  business: ["settings", "business"] as const,
  locations: ["settings", "locations"] as const,
  catalog: ["settings", "catalog"] as const,
  staff: ["settings", "staff"] as const,
  staffServices: (staffId: string) => ["settings", "staff", staffId, "services"] as const,
  timeOff: ["settings", "time-off"] as const,
  members: ["settings", "members"] as const,
};

// ── Llamadas ────────────────────────────────────────────────────────────────

const enc = encodeURIComponent;

export const settingsApi = {
  getBusiness: () => api.get<BusinessSettings>("/settings/business"),
  updateBusiness: (patch: BusinessSettingsPatch) => api.patch<BusinessSettings>("/settings/business", patch),

  listLocations: () => api.get<LocationView[]>("/settings/locations"),
  createLocation: (input: LocationInput & { hours?: WeeklyBlock[] }) => api.post<LocationView>("/settings/locations", input),
  updateLocation: (id: string, patch: Partial<LocationInput>) => api.patch<LocationView>(`/settings/locations/${enc(id)}`, patch),
  replaceLocationHours: (id: string, hours: WeeklyBlock[]) => api.put<LocationView>(`/settings/locations/${enc(id)}/hours`, { hours }),
  deleteLocation: (id: string) => api.delete<DeleteResult<"location", LocationView>>(`/settings/locations/${enc(id)}`),

  getCatalog: () => api.get<CatalogView>("/settings/services"),
  createCategory: (name: string) => api.post<CategoryView>("/settings/service-categories", { name }),
  renameCategory: (id: string, name: string) => api.patch<CategoryView>(`/settings/service-categories/${enc(id)}`, { name }),
  deleteCategory: (id: string) => api.delete<void>(`/settings/service-categories/${enc(id)}`),
  reorderCategories: (ids: string[]) => api.put<CategoryView[]>("/settings/service-categories/order", { ids }),
  createService: (input: ServiceInput) => api.post<ServiceView>("/settings/services", input),
  updateService: (id: string, patch: Partial<ServiceInput>) => api.patch<ServiceView>(`/settings/services/${enc(id)}`, patch),
  deleteService: (id: string) => api.delete<void>(`/settings/services/${enc(id)}`),
  reorderServices: (categoryId: string | null, ids: string[]) => api.put<ServiceView[]>("/settings/services/order", { categoryId, ids }),

  listStaff: () => api.get<StaffView[]>("/settings/staff"),
  createStaff: (input: StaffInput) => api.post<StaffView>("/settings/staff", input),
  updateStaff: (id: string, patch: Partial<StaffInput>) => api.patch<StaffView>(`/settings/staff/${enc(id)}`, patch),
  deleteStaff: (id: string) => api.delete<DeleteResult<"staff", StaffView>>(`/settings/staff/${enc(id)}`),
  reorderStaff: (ids: string[]) => api.put<StaffView[]>("/settings/staff/order", { ids }),
  replaceStaffHours: (id: string, locationId: string, hours: WeeklyBlock[]) =>
    api.put<StaffView>(`/settings/staff/${enc(id)}/hours`, { locationId, hours }),
  getStaffServices: (id: string) => api.get<StaffServicesView>(`/settings/staff/${enc(id)}/services`),
  replaceStaffServices: (id: string, services: StaffServiceItem[]) =>
    api.put<StaffServicesView>(`/settings/staff/${enc(id)}/services`, { services }),

  listTimeOff: () => api.get<TimeOffEntry[]>("/settings/time-off"),
  createTimeOff: (input: TimeOffInput) => api.post<TimeOffEntry>("/settings/time-off", input),
  updateTimeOff: (id: string, patch: Partial<TimeOffInput>) => api.patch<TimeOffEntry>(`/settings/time-off/${enc(id)}`, patch),
  deleteTimeOff: (id: string) => api.delete<void>(`/settings/time-off/${enc(id)}`),

  listMembers: () => api.get<Member[]>("/team/members"),
  invite: (input: InviteInput) => api.post<Member>("/team/invitations", input),
  updateMember: (membershipId: string, patch: MemberPatch) => api.patch<Member>(`/team/members/${enc(membershipId)}`, patch),
};

/** ¿La sesión edita la configuración? (dueño y administración; el resto solo lee). */
export function canManageSettings(me: Me): boolean {
  return me.role === "owner" || me.role === "admin";
}
