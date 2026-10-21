import type { Branding } from "./branding";

// ─────────────────────────────────────────────────────────────────────────────
// Tipos del contrato de identidad de la API del panel (/api/panel/auth/* y /admin/*,
// I0.6). Escritos a mano mientras los esquemas Zod del backend no se compartan con el
// front (PLAN-GESTION.md §2): espejo de src/modules/team/{routes,me,invitations}.ts y
// src/admin/routes.ts. Si el backend cambia la forma, cambia acá (y en lib/mockApi.ts).
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
  /** Profesional vinculado a esta cuenta (su carril en "Mi agenda"), o null. */
  staffId?: string | null;
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

/** `GET /auth/invitations/:token`. */
export interface Invitation {
  email: string;
  businessName: string;
  role: Role;
  /** true = la persona ya tiene cuenta: acepta con su clave actual (y su código si tiene 2FA), sin nombre. */
  hasAccount: boolean;
}

/** `POST /auth/invitations/accept` → `Me` (la sesión queda en el negocio que invitó). */
export interface AcceptInvitationInput {
  token: string;
  /** Obligatorio para una cuenta nueva; una cuenta que ya existe conserva su nombre. */
  name?: string;
  /** Cuenta nueva: la clave que elige. Cuenta existente: su clave actual. */
  password: string;
  /** Solo cuenta existente con 2FA (si falta, 400 `totp_required`). */
  totpCode?: string;
}

// ── Superadmin ──────────────────────────────────────────────────────────────

/** `GET /admin/me`. */
export interface AdminMe {
  username: string;
  totpEnabled: boolean;
}

/** Mismo esquema de dos pasos que el login del panel. */
export type AdminLoginResult = { status: "ok"; me: AdminMe } | { status: "totp_required" };

export interface AdminLoginInput {
  username: string;
  password: string;
  totpCode?: string;
}

/** Fila de `GET /admin/businesses` (los más nuevos primero) y respuesta del alta (201). */
export interface AdminBusiness {
  id: string;
  name: string;
  slug: string;
  industry: string;
  plan: string;
  status: string;
  currency: string;
  country: string;
  timezone: string;
  locationCount: number;
  /** ISO 8601. */
  createdAt: string;
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
