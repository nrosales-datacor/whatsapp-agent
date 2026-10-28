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

// ── Plan (I2) ───────────────────────────────────────────────────────────────

/** Recursos con cupo por plan. */
export type PlanResource = "locations" | "staff" | "users";

/** Límites del plan (null = sin tope). Espejo de `PlanLimitsView` en src/platform/plan/planHooks.ts. */
export interface PlanLimits {
  locations: number | null;
  staff: number | null;
  users: number | null;
  /** Conversaciones del agente por mes. */
  aiConversations: number | null;
}

/** Uso actual frente a los límites. */
export interface PlanUsage {
  /** `YYYY-MM`. */
  month: string;
  locations: number;
  staff: number;
  users: number;
  /** null = todavía no se mide (sin el módulo WhatsApp). */
  aiConversations: number | null;
}

export type ClientsTier = "basic" | "full";
export type BillingStatus = "trial" | "active" | "past_due" | "cancelled";

/** Vencimientos del cobro (fechas ISO 8601). Espejo de `PlanBillingView` en src/platform/plan/planHooks.ts. */
export interface PlanBilling {
  /** Fin de la prueba del alta self-service (null = sin vencimiento automático). */
  trialEndsAt: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  pastDueSince: string | null;
  /** Cuándo se pausa la cuenta si no se paga, o null. */
  pauseAt: string | null;
  /** ¿Se puede pagar en línea? (Stripe configurado). */
  onlinePayments: boolean;
  hasSubscription: boolean;
  /** ¿Puede abrir "Gestionar pago"? (tiene cliente en Stripe). */
  canManage: boolean;
}

/** `me.plan`: lo que el panel necesita del plan para mostrar u ocultar lo del Pro. */
export interface MePlan {
  id: Plan;
  /** "Básico", "Pro" o "Pro sin agente". */
  label: string;
  clientsTier: ClientsTier;
  modules: string[];
  /** Funciones del plan que no son un módulo (p. ej. "branding": marca propia). */
  features: string[];
  billingStatus: BillingStatus | string;
  /** Vencimientos y cobro en línea (I6): avisos de prueba y de pago atrasado, botones de pago. */
  billing: PlanBilling;
  limits: PlanLimits;
  usage: PlanUsage;
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
  /** Plan del negocio: nombre, nivel de clientes, límites y uso del mes. */
  plan: MePlan;
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
  /** "Básico", "Pro" o "Pro sin agente". */
  planLabel: string;
  modules: string[];
  /** `active` | `paused` | `closed`. */
  status: string;
  billingStatus: BillingStatus | string;
  currency: string;
  country: string;
  timezone: string;
  locationCount: number;
  /** ISO 8601. */
  createdAt: string;
}

/** Límites efectivos que ve el superadmin (incluye el tope interno de gasto de LLM, USD/mes). */
export interface AdminPlanLimits extends PlanLimits {
  aiLlmUsd: number | null;
}

export type AdminLimitOverrides = Partial<Record<keyof AdminPlanLimits, number | null>>;

/** Entrada del rastro de auditoría de un negocio. */
export interface AuditEntry {
  id: string;
  action: string;
  actor: string;
  details: Record<string, unknown>;
  /** ISO 8601. */
  createdAt: string;
}

/** `GET /admin/businesses/:id` (y la respuesta de cambiar plan, pausar y reactivar). */
export interface AdminBusinessDetail {
  business: AdminBusiness;
  clientsTier: ClientsTier;
  limits: AdminPlanLimits;
  /** Lo contratado encima del plan: módulos sueltos y cupos. */
  overrides: { modules: Partial<Record<string, boolean>>; limits: AdminLimitOverrides };
  usage: PlanUsage;
  audit: AuditEntry[];
  /** Cobro en línea (Stripe) y vencimientos (I6). */
  stripe?: AdminStripeInfo;
}

/** `PATCH /admin/businesses/:id/plan`: `extraModules` y `limits` reemplazan lo contratado. */
export interface PlanChangeInput {
  plan?: Plan;
  extraModules?: Partial<Record<string, boolean>>;
  limits?: AdminLimitOverrides;
  billingStatus?: BillingStatus;
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

// ── Cobro en línea y alta self-service (I6) ─────────────────────────────────

/** Cobro en línea de un negocio en el superadmin. Espejo de `AdminStripeView` (src/modules/billing/admin.ts). */
export interface AdminStripeInfo {
  configured: boolean;
  customerId: string | null;
  subscriptionId: string | null;
  /** Estado crudo de la suscripción en Stripe (`active`, `past_due`, `canceled`…). */
  subscriptionStatus: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  pastDueSince: string | null;
  pauseAt: string | null;
  trialEndsAt: string | null;
  billingPaused: boolean;
  dashboardUrl: string | null;
}

/** `GET /billing/status` (solo el dueño). Espejo de `BillingStatusView` (src/modules/billing/checkout.ts). */
export interface BillingAccount {
  onlinePayments: boolean;
  plans: { id: Plan; label: string; available: boolean }[];
  extras: { locations: boolean; staff: boolean };
  plan: Plan;
  planLabel: string;
  billingStatus: string;
  trialEndsAt: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  pastDueSince: string | null;
  pauseAt: string | null;
  hasSubscription: boolean;
  canManage: boolean;
  paused: boolean;
  pausedForBilling: boolean;
}

/** `POST /billing/checkout`. */
export interface CheckoutInput {
  plan: Plan;
  extraLocations?: number;
  extraStaff?: number;
}

/** `GET /signup/options`. */
export interface SignupOptions {
  industries: { id: string; label: string }[];
  trialDays: number;
}

/** `POST /signup` (público). `website` es el honeypot: siempre vacío. */
export interface SignupInput {
  businessName: string;
  industry: string;
  country: string;
  timezone: string;
  currency: string;
  ownerName: string;
  email: string;
  password: string;
  website: string;
}

export type OnboardingStepId = "hours" | "services" | "team" | "whatsapp" | "first_appointment";

/** `GET /onboarding` (dueño y admin). */
export interface OnboardingStatus {
  visible: boolean;
  dismissed: boolean;
  completed: boolean;
  steps: { id: OnboardingStepId; done: boolean }[];
}
