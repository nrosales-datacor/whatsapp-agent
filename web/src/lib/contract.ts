import type { Branding } from "./branding";

// ─────────────────────────────────────────────────────────────────────────────
// Tipos del contrato de identidad de la API del panel (/api/panel/auth/* y /admin/*,
// I0.6). Escritos a mano mientras los esquemas Zod del backend no se compartan con el
// front (PLAN-GESTION.md §2). Si el backend cambia la forma, cambia acá.
//
// Lo marcado "asumido" no estaba en el contrato acordado: es la forma más probable y el
// panel la trata con tolerancia (campos opcionales).
// ─────────────────────────────────────────────────────────────────────────────

export type Role = "owner" | "admin" | "front_desk" | "staff";
export type Plan = "basic" | "pro";

/** Terminología del negocio. Espejo de `Terminology` en src/modules/business/settings.ts. */
export interface Terminology {
  client: string;
  clients: string;
  staffMember: string;
  staff: string;
  appointment: string;
  appointments: string;
  location: string;
  locations: string;
}

export const DEFAULT_TERMINOLOGY: Terminology = {
  client: "cliente",
  clients: "clientes",
  staffMember: "profesional",
  staff: "profesionales",
  appointment: "cita",
  appointments: "citas",
  location: "sucursal",
  locations: "sucursales",
};

export interface MeUser {
  id: string;
  name: string;
  email: string;
  mustChangePassword: boolean;
  totpEnabled: boolean;
}

export interface MeBusiness {
  id: string;
  name: string;
  slug: string;
  plan: Plan;
  industry: string;
  currency: string;
  timezone: string;
  /** Puede venir parcial: el panel completa con DEFAULT_TERMINOLOGY. */
  terminology: Partial<Terminology>;
  branding: Branding;
}

export interface LocationRef {
  id: string;
  name: string;
}

export interface Membership {
  businessId: string;
  businessName: string;
  role: Role;
}

/** Sesión del usuario en el negocio activo (`GET /auth/me`). */
export interface Me {
  user: MeUser;
  business: MeBusiness;
  role: Role;
  /** Sucursales a las que el usuario tiene acceso en el negocio activo. */
  locations: LocationRef[];
  allLocations: boolean;
  memberships: Membership[];
  /** Módulos habilitados por el plan (y los extras) del negocio activo. */
  modules: string[];
}

export type LoginResult = { status: "ok"; me: Me } | { status: "totp_required" };

export interface LoginInput {
  email: string;
  password: string;
  totpCode?: string;
}

export interface TotpSetup {
  secret: string;
  otpauthUrl: string;
}

export interface Invitation {
  email: string;
  businessName: string;
  role: Role;
}

// ── Superadmin ──────────────────────────────────────────────────────────────

/** Asumido: `GET /admin/me` devuelve al menos el usuario del superadmin. */
export interface AdminMe {
  username: string;
}

/** Asumido: mismo esquema de dos pasos que el login del panel. */
export type AdminLoginResult = { status: "ok"; admin?: AdminMe } | { status: "totp_required" };

export interface AdminLoginInput {
  username: string;
  password: string;
  totpCode?: string;
}

/** Asumido: fila de `GET /admin/businesses` (los campos opcionales se muestran si vienen). */
export interface AdminBusiness {
  id: string;
  name: string;
  slug?: string;
  plan?: string;
  industry?: string;
  status?: string;
  country?: string;
  createdAt?: string;
}

export interface CreateBusinessInput {
  name: string;
  industry: string;
  timezone: string;
  currency: string;
  country: string;
  locationName: string;
  ownerEmail: string;
  ownerName: string;
}
