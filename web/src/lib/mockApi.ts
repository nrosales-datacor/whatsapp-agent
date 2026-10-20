import type { TransportRequest, TransportResponse } from "./api";
import type { AdminBusiness, LocationRef, Me, MeBusiness, Role } from "./contract";
import { readStorage, writeStorage } from "./storage";

// ─────────────────────────────────────────────────────────────────────────────
// API simulada para desarrollar y testear el panel sin backend (VITE_MOCK_API=1).
// Responde con el MISMO sobre y los mismos códigos que el contrato de identidad (I0.6),
// así el cliente de lib/api.ts y las pantallas recorren el camino real. El estado (sesión,
// claves cambiadas, negocios creados) vive en sessionStorage: sobrevive a un recargo de
// la pestaña y cada pestaña o test arranca limpio.
//
// Solo se carga con VITE_MOCK_API=1 (import dinámico desde lib/api.ts): no viaja en el
// build normal. Los datos son ficticios.
// ─────────────────────────────────────────────────────────────────────────────

export const MOCK_PASSWORD = "demo1234";
export const MOCK_TOTP_CODE = "123456";
/** Invitación a una cuenta nueva (elige nombre y clave). */
export const MOCK_INVITATION_TOKEN = "demo";
/** Invitación a una cuenta que ya existe y tiene 2FA (confirma con su clave y su código). */
export const MOCK_EXISTING_INVITATION_TOKEN = "cuenta-existente";
export const MOCK_EXPIRED_RESET_TOKEN = "vencido";
export const MOCK_ADMIN_USERNAME = "admin";
const MOCK_ADMIN_ME = { username: MOCK_ADMIN_USERNAME, totpEnabled: true };

/** Cuentas de prueba (las lista la pantalla de login en modo mock). */
export const MOCK_ACCOUNTS: readonly { email: string; description: string }[] = [
  { email: "duena@demo.test", description: "Dueña, plan Pro, 2 sucursales y 2 negocios" },
  { email: "basico@demo.test", description: "Dueño, plan Básico (Ventas, Reportes y Campañas con candado)" },
  { email: "sinagente@demo.test", description: "Dueña, Pro sin agente (sin WhatsApp IA)" },
  { email: "recepcion@demo.test", description: "Recepción, fija a una sucursal" },
  { email: "profesional@demo.test", description: "Profesional (Mi agenda, Mis pacientes, Mis comisiones)" },
  { email: "2fa@demo.test", description: `Dueña con 2FA (código ${MOCK_TOTP_CODE})` },
  { email: "temporal@demo.test", description: "Admin con clave temporal (cambio obligatorio)" },
  { email: "sinnegocio@demo.test", description: "Cuenta sin ningún negocio activo (no entra)" },
];

const LATENCY_MS = 250;

const PRO_MODULES = ["scheduling", "clients", "sales", "commissions", "reports", "whatsapp", "campaigns"];
const BASIC_MODULES = ["scheduling", "clients", "whatsapp"];

interface MockBusiness extends MeBusiness {
  locations: LocationRef[];
  modules: string[];
  status: string;
  country: string;
  createdAt: string;
}

const LOC_ESCAZU = "0b3c6f2e-6a1d-4c39-9a51-3f0f8c2a1e01";
const LOC_HEREDIA = "0b3c6f2e-6a1d-4c39-9a51-3f0f8c2a1e02";

const BUSINESSES: Record<string, MockBusiness> = {
  "5d0a1c7e-2f4b-4b8e-8f3a-6c1d2e3f4a01": {
    id: "5d0a1c7e-2f4b-4b8e-8f3a-6c1d2e3f4a01",
    name: "Clínica Dental Sonrisa",
    slug: "clinica-dental-sonrisa",
    plan: "pro",
    industry: "dental",
    currency: "CRC",
    timezone: "America/Costa_Rica",
    terminology: { client: "paciente", clients: "pacientes" },
    branding: {},
    locations: [
      { id: LOC_ESCAZU, name: "Escazú" },
      { id: LOC_HEREDIA, name: "Heredia" },
    ],
    modules: PRO_MODULES,
    status: "active",
    country: "CR",
    createdAt: "2026-09-02T15:00:00.000Z",
  },
  "5d0a1c7e-2f4b-4b8e-8f3a-6c1d2e3f4a02": {
    id: "5d0a1c7e-2f4b-4b8e-8f3a-6c1d2e3f4a02",
    name: "Estética Aurora",
    slug: "estetica-aurora",
    plan: "basic",
    industry: "aesthetics",
    currency: "CRC",
    timezone: "America/Costa_Rica",
    terminology: {},
    branding: { accentColor: "#7A3FF2", headerColor: "#1E1B2E" },
    locations: [{ id: "0b3c6f2e-6a1d-4c39-9a51-3f0f8c2a1e03", name: "Sabana" }],
    modules: BASIC_MODULES,
    status: "active",
    country: "CR",
    createdAt: "2026-09-20T15:00:00.000Z",
  },
  "5d0a1c7e-2f4b-4b8e-8f3a-6c1d2e3f4a03": {
    id: "5d0a1c7e-2f4b-4b8e-8f3a-6c1d2e3f4a03",
    name: "Uñas Bella",
    slug: "unas-bella",
    plan: "pro",
    industry: "nails",
    currency: "USD",
    timezone: "America/Panama",
    terminology: { staffMember: "estilista", staff: "estilistas" },
    branding: { accentColor: "#C7513B", headerColor: "#2A2A2E" },
    locations: [{ id: "0b3c6f2e-6a1d-4c39-9a51-3f0f8c2a1e04", name: "Obarrio" }],
    modules: PRO_MODULES.filter((m) => m !== "whatsapp"),
    status: "active",
    country: "PA",
    createdAt: "2026-10-01T15:00:00.000Z",
  },
};

const [DENTAL, AESTHETICS, NAILS] = Object.keys(BUSINESSES);

interface MockMembership {
  businessId: string;
  role: Role;
  /** Sin valor = todas las sucursales. */
  locationIds?: string[];
}

interface MockUser {
  id: string;
  name: string;
  email: string;
  totpEnabled: boolean;
  mustChangePassword: boolean;
  memberships: MockMembership[];
}

const BASE_USERS: MockUser[] = [
  {
    id: "7e1f0a2b-1111-4c3d-8e4f-000000000001",
    name: "Daniela Mora",
    email: "duena@demo.test",
    totpEnabled: false,
    mustChangePassword: false,
    memberships: [
      { businessId: DENTAL, role: "owner" },
      { businessId: AESTHETICS, role: "owner" },
    ],
  },
  {
    id: "7e1f0a2b-1111-4c3d-8e4f-000000000002",
    name: "Andrés Solís",
    email: "basico@demo.test",
    totpEnabled: false,
    mustChangePassword: false,
    memberships: [{ businessId: AESTHETICS, role: "owner" }],
  },
  {
    id: "7e1f0a2b-1111-4c3d-8e4f-000000000003",
    name: "Valeria Quesada",
    email: "sinagente@demo.test",
    totpEnabled: false,
    mustChangePassword: false,
    memberships: [{ businessId: NAILS, role: "owner" }],
  },
  {
    id: "7e1f0a2b-1111-4c3d-8e4f-000000000004",
    name: "Lucía Vargas",
    email: "recepcion@demo.test",
    totpEnabled: false,
    mustChangePassword: false,
    memberships: [{ businessId: DENTAL, role: "front_desk", locationIds: [LOC_ESCAZU] }],
  },
  {
    id: "7e1f0a2b-1111-4c3d-8e4f-000000000005",
    name: "Carlos Rojas",
    email: "profesional@demo.test",
    totpEnabled: false,
    mustChangePassword: false,
    memberships: [{ businessId: DENTAL, role: "staff", locationIds: [LOC_HEREDIA] }],
  },
  {
    id: "7e1f0a2b-1111-4c3d-8e4f-000000000006",
    name: "Sofía Jiménez",
    email: "2fa@demo.test",
    totpEnabled: true,
    mustChangePassword: false,
    memberships: [{ businessId: DENTAL, role: "owner" }],
  },
  {
    id: "7e1f0a2b-1111-4c3d-8e4f-000000000007",
    name: "Mario Castro",
    email: "temporal@demo.test",
    totpEnabled: false,
    mustChangePassword: true,
    memberships: [{ businessId: DENTAL, role: "admin" }],
  },
  {
    id: "7e1f0a2b-1111-4c3d-8e4f-000000000008",
    name: "Ramón Ureña",
    email: "sinnegocio@demo.test",
    totpEnabled: false,
    mustChangePassword: false,
    memberships: [],
  },
];

interface MockInvitation extends MockMembership {
  email: string;
  /** Id de la cuenta que se crea al aceptar (solo invitaciones a una cuenta nueva). */
  newUserId?: string;
}

const INVITATIONS: Record<string, MockInvitation> = {
  [MOCK_INVITATION_TOKEN]: {
    email: "nuevo@demo.test",
    businessId: DENTAL,
    role: "staff",
    locationIds: [LOC_ESCAZU],
    newUserId: "7e1f0a2b-1111-4c3d-8e4f-000000000099",
  },
  // Sofía (2fa@demo.test) ya entra a la clínica; la suman a Estética Aurora.
  [MOCK_EXISTING_INVITATION_TOKEN]: { email: "2fa@demo.test", businessId: AESTHETICS, role: "admin" },
};

// ── Estado (sessionStorage) ─────────────────────────────────────────────────

interface MockState {
  sessionEmail: string | null;
  businessId: string | null;
  admin: boolean;
  failedLogins: number;
  /** Cambios sobre las cuentas base: clave nueva, 2FA, cambio de clave hecho. */
  overrides: Record<string, Partial<Pick<MockUser, "totpEnabled" | "mustChangePassword">> & { password?: string }>;
  extraUsers: MockUser[];
  /** Membresías que se sumaron al aceptar una invitación con una cuenta existente. */
  addedMemberships: Record<string, MockMembership[]>;
  /** Cuentas que ya generaron el secreto de 2FA (`/auth/totp/setup`) y falta confirmarlo. */
  totpSetupDone: string[];
  createdBusinesses: AdminBusiness[];
  usedInvitations: string[];
}

const STATE_KEY = "selyon.mock.state";

function emptyState(): MockState {
  return {
    sessionEmail: null,
    businessId: null,
    admin: false,
    failedLogins: 0,
    overrides: {},
    extraUsers: [],
    addedMemberships: {},
    totpSetupDone: [],
    createdBusinesses: [],
    usedInvitations: [],
  };
}

function loadState(): MockState {
  const raw = readStorage(STATE_KEY, "session");
  if (!raw) return emptyState();
  try {
    return { ...emptyState(), ...(JSON.parse(raw) as Partial<MockState>) };
  } catch {
    return emptyState();
  }
}

function saveState(state: MockState): void {
  writeStorage(STATE_KEY, JSON.stringify(state), "session");
}

function findUser(state: MockState, email: string): MockUser | null {
  const normalized = email.trim().toLowerCase();
  const base = [...BASE_USERS, ...state.extraUsers].find((u) => u.email === normalized);
  if (!base) return null;
  const { password: _password, ...flags } = state.overrides[base.email] ?? {};
  return { ...base, ...flags, memberships: [...base.memberships, ...(state.addedMemberships[base.email] ?? [])] };
}

function setOverride(state: MockState, email: string, change: MockState["overrides"][string]): void {
  state.overrides[email] = { ...state.overrides[email], ...change };
}

function passwordOf(state: MockState, email: string): string {
  return state.overrides[email]?.password ?? MOCK_PASSWORD;
}

function buildMe(user: MockUser, businessId: string): Me {
  const membership = user.memberships.find((m) => m.businessId === businessId) ?? user.memberships[0];
  const b = BUSINESSES[membership.businessId];
  const all = membership.locationIds === undefined;
  return {
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      mustChangePassword: user.mustChangePassword,
      totpEnabled: user.totpEnabled,
    },
    business: {
      id: b.id,
      name: b.name,
      slug: b.slug,
      plan: b.plan,
      industry: b.industry,
      currency: b.currency,
      timezone: b.timezone,
      terminology: b.terminology,
      branding: b.branding,
    },
    role: membership.role,
    locations: all ? b.locations : b.locations.filter((l) => membership.locationIds?.includes(l.id)),
    allLocations: all,
    memberships: user.memberships.map((m) => ({
      businessId: m.businessId,
      businessName: BUSINESSES[m.businessId].name,
      role: m.role,
    })),
    modules: b.modules,
  };
}

// ── Respuestas ──────────────────────────────────────────────────────────────

function ok(data: unknown, status = 200): TransportResponse {
  return { status, payload: { ok: true, data } };
}

function noContent(): TransportResponse {
  return { status: 204, payload: undefined };
}

function fail(status: number, code: string, error: string, fields?: Record<string, string>): TransportResponse {
  return { status, payload: { ok: false, error, code, ...(fields ? { fields } : {}) } };
}

function invalid(fields: Record<string, string>): TransportResponse {
  return fail(400, "validation_error", "Datos inválidos: revisá los campos marcados.", fields);
}

const unauthorized = () => fail(401, "unauthorized", "Tu sesión no es válida o venció. Iniciá sesión de nuevo.");
const invalidCredentials = () => fail(401, "invalid_credentials", "Correo o clave incorrectos.");
const invalidPassword = () => fail(400, "invalid_password", "La clave actual no es correcta.");
const invalidCode = () => fail(400, "invalid_code", "El código no es correcto.");
const invalidInvitation = (status: 400 | 404) =>
  fail(status, "invalid_token", "La invitación no es válida o venció. Pedile a quien te invitó que te la mande de nuevo.");

const INDUSTRIES = ["generic", "dental", "aesthetics", "nails"];

const RE_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function str(body: unknown, key: string): string {
  const value = typeof body === "object" && body !== null ? (body as Record<string, unknown>)[key] : undefined;
  return typeof value === "string" ? value : "";
}

function slugify(name: string): string {
  const slug = name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "negocio";
}

/** `GET /admin/businesses`: los más nuevos primero. */
function allAdminBusinesses(state: MockState): AdminBusiness[] {
  const base: AdminBusiness[] = Object.values(BUSINESSES).map((b) => ({
    id: b.id,
    name: b.name,
    slug: b.slug,
    industry: b.industry,
    plan: b.plan,
    status: b.status,
    currency: b.currency,
    country: b.country,
    timezone: b.timezone,
    locationCount: b.locations.length,
    createdAt: b.createdAt,
  }));
  return [...state.createdBusinesses, ...base].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** UUID ficticio y estable (sin `crypto.randomUUID`, que pide contexto seguro). */
function mockId(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

/** Invitación vigente del token, o null. */
function pendingInvitation(state: MockState, token: string): MockInvitation | null {
  const invitation = INVITATIONS[token];
  if (!invitation || state.usedInvitations.includes(token)) return null;
  return invitation;
}

function route(req: TransportRequest, state: MockState): TransportResponse {
  const path = req.path.split("?")[0];
  const { body } = req;
  const sessionUser = state.sessionEmail ? findUser(state, state.sessionEmail) : null;
  const sessionMe = () => (sessionUser ? buildMe(sessionUser, state.businessId ?? sessionUser.memberships[0].businessId) : null);

  const invitationMatch = /^\/auth\/invitations\/([^/]+)$/.exec(path);
  if (req.method === "GET" && invitationMatch) {
    const invitation = pendingInvitation(state, decodeURIComponent(invitationMatch[1]));
    if (!invitation) return invalidInvitation(404);
    return ok({
      email: invitation.email,
      businessName: BUSINESSES[invitation.businessId].name,
      role: invitation.role,
      hasAccount: findUser(state, invitation.email) !== null,
    });
  }

  switch (`${req.method} ${path}`) {
    case "GET /auth/me": {
      const me = sessionMe();
      return me ? ok(me) : unauthorized();
    }

    case "POST /auth/login": {
      const email = str(body, "email").trim().toLowerCase();
      const password = str(body, "password");
      const totpCode = str(body, "totpCode").trim();
      if (state.failedLogins >= 5) {
        return fail(429, "too_many_attempts", "Demasiados intentos. Probá de nuevo en unos minutos.");
      }
      const user = findUser(state, email);
      if (!user || password !== passwordOf(state, user.email)) {
        state.failedLogins += 1;
        return invalidCredentials();
      }
      if (user.totpEnabled && !totpCode) return ok({ status: "totp_required" });
      // Código equivocado: el mismo `invalid_credentials` (no revela qué parte falló).
      if (user.totpEnabled && totpCode !== MOCK_TOTP_CODE) {
        state.failedLogins += 1;
        return invalidCredentials();
      }
      if (user.memberships.length === 0) {
        return fail(
          403,
          "no_active_business",
          "Tu cuenta no tiene acceso a ningún negocio activo. Hablá con quien administra tu negocio.",
        );
      }
      state.failedLogins = 0;
      state.sessionEmail = user.email;
      state.businessId = user.memberships[0].businessId;
      return ok({ status: "ok", me: buildMe(user, state.businessId) });
    }

    case "POST /auth/logout":
      state.sessionEmail = null;
      state.businessId = null;
      return noContent();

    case "POST /auth/switch-business": {
      if (!sessionUser) return unauthorized();
      const businessId = str(body, "businessId");
      if (!sessionUser.memberships.some((m) => m.businessId === businessId)) {
        return fail(403, "business_forbidden", "No tenés acceso a ese negocio.");
      }
      state.businessId = businessId;
      return ok(buildMe(sessionUser, businessId));
    }

    case "POST /auth/password/forgot": {
      // Misma respuesta exista o no la cuenta (no revela qué correos están registrados).
      if (!str(body, "email").trim()) return invalid({ "body.email": "Campo obligatorio." });
      return noContent();
    }

    case "POST /auth/password/reset": {
      const token = str(body, "token");
      const password = str(body, "password");
      if (password.length < 8) return invalid({ "body.password": "La clave tiene que tener al menos 8 caracteres." });
      if (!token || token === MOCK_EXPIRED_RESET_TOKEN) {
        return fail(400, "invalid_token", "El enlace no es válido o venció. Pedí uno nuevo.");
      }
      return noContent();
    }

    case "POST /auth/password/change": {
      if (!sessionUser) return unauthorized();
      const current = str(body, "currentPassword");
      const next = str(body, "newPassword");
      if (next.length < 8) return invalid({ "body.newPassword": "La clave tiene que tener al menos 8 caracteres." });
      if (current !== passwordOf(state, sessionUser.email)) return invalidPassword();
      if (next === current) return invalid({ "body.newPassword": "La clave nueva tiene que ser distinta de la actual." });
      setOverride(state, sessionUser.email, { password: next, mustChangePassword: false });
      return noContent();
    }

    case "POST /auth/totp/setup": {
      if (!sessionUser) return unauthorized();
      if (sessionUser.totpEnabled) return fail(409, "totp_already_enabled", "El segundo factor ya está activo.");
      if (!state.totpSetupDone.includes(sessionUser.email)) state.totpSetupDone.push(sessionUser.email);
      const secret = "JBSWY3DPEHPK3PXP";
      const label = encodeURIComponent(`Selyon CRM:${sessionUser.email}`);
      return ok({ secret, otpauthUrl: `otpauth://totp/${label}?secret=${secret}&issuer=Selyon%20CRM` });
    }

    case "POST /auth/totp/enable": {
      if (!sessionUser) return unauthorized();
      if (sessionUser.totpEnabled) return fail(409, "totp_already_enabled", "El segundo factor ya está activo.");
      if (!state.totpSetupDone.includes(sessionUser.email)) {
        return fail(400, "totp_not_setup", "Primero generá el código para tu app autenticadora.");
      }
      if (str(body, "code").trim() !== MOCK_TOTP_CODE) return invalidCode();
      setOverride(state, sessionUser.email, { totpEnabled: true });
      state.totpSetupDone = state.totpSetupDone.filter((e) => e !== sessionUser.email);
      return noContent();
    }

    case "POST /auth/totp/disable": {
      if (!sessionUser) return unauthorized();
      if (!sessionUser.totpEnabled) return fail(409, "totp_not_enabled", "El segundo factor no está activo.");
      if (str(body, "password") !== passwordOf(state, sessionUser.email)) return invalidPassword();
      if (str(body, "code").trim() !== MOCK_TOTP_CODE) return invalidCode();
      setOverride(state, sessionUser.email, { totpEnabled: false });
      return noContent();
    }

    case "POST /auth/invitations/accept": {
      const token = str(body, "token");
      const password = str(body, "password");
      const invitation = pendingInvitation(state, token);
      if (!invitation) return invalidInvitation(400);
      const membership: MockMembership = {
        businessId: invitation.businessId,
        role: invitation.role,
        ...(invitation.locationIds ? { locationIds: invitation.locationIds } : {}),
      };
      const existing = findUser(state, invitation.email);

      if (!existing) {
        // Cuenta nueva: elige nombre y clave.
        const name = str(body, "name").trim();
        const fields: Record<string, string> = {};
        if (!name) fields["body.name"] = "Campo obligatorio.";
        if (password.length < 8) fields["body.password"] = "La clave tiene que tener al menos 8 caracteres.";
        if (Object.keys(fields).length > 0) return invalid(fields);
        const user: MockUser = {
          id: invitation.newUserId ?? mockId(state.extraUsers.length + 1),
          name,
          email: invitation.email,
          totpEnabled: false,
          mustChangePassword: false,
          memberships: [membership],
        };
        state.extraUsers = [...state.extraUsers.filter((u) => u.email !== user.email), user];
        setOverride(state, user.email, { password });
        state.usedInvitations.push(token);
        state.sessionEmail = user.email;
        state.businessId = invitation.businessId;
        return ok(buildMe(user, invitation.businessId));
      }

      // Cuenta existente: confirma con su clave (y su 2FA). Nunca se le cambia la clave acá.
      if (password !== passwordOf(state, existing.email)) {
        return fail(400, "invalid_password", "La clave no es correcta: usá la clave con la que ya entrás.");
      }
      if (existing.totpEnabled) {
        const totpCode = str(body, "totpCode").trim();
        if (!totpCode) {
          return fail(400, "totp_required", "Tu cuenta tiene segundo factor: ingresá el código de tu app autenticadora.");
        }
        if (totpCode !== MOCK_TOTP_CODE) return invalidCode();
      }
      if (!existing.memberships.some((m) => m.businessId === invitation.businessId)) {
        state.addedMemberships[existing.email] = [...(state.addedMemberships[existing.email] ?? []), membership];
      }
      state.usedInvitations.push(token);
      state.sessionEmail = existing.email;
      state.businessId = invitation.businessId;
      const user = findUser(state, existing.email);
      return user ? ok(buildMe(user, invitation.businessId)) : invalidInvitation(400);
    }

    // ── Superadmin ──
    case "POST /admin/login": {
      const username = str(body, "username").trim();
      const password = str(body, "password");
      const totpCode = str(body, "totpCode").trim();
      if (username !== MOCK_ADMIN_USERNAME || password !== MOCK_PASSWORD) {
        return fail(401, "invalid_credentials", "Usuario, clave o código incorrectos.");
      }
      if (!totpCode) return ok({ status: "totp_required" });
      if (totpCode !== MOCK_TOTP_CODE) return fail(401, "invalid_credentials", "Usuario, clave o código incorrectos.");
      state.admin = true;
      return ok({ status: "ok", me: MOCK_ADMIN_ME });
    }

    case "POST /admin/logout":
      state.admin = false;
      return noContent();

    case "GET /admin/me":
      return state.admin ? ok(MOCK_ADMIN_ME) : unauthorized();

    case "GET /admin/businesses":
      return state.admin ? ok(allAdminBusinesses(state)) : unauthorized();

    case "POST /admin/businesses": {
      if (!state.admin) return unauthorized();
      const value = (key: string) => str(body, key).trim();
      const fields: Record<string, string> = {};
      for (const key of ["name", "locationName", "ownerName"]) if (!value(key)) fields[`body.${key}`] = "Campo obligatorio.";
      if (!INDUSTRIES.includes(value("industry"))) fields["body.industry"] = "Rubro inválido.";
      if (!value("timezone")) fields["body.timezone"] = "Zona horaria inválida (ej. America/Costa_Rica).";
      if (!/^[A-Z]{3}$/.test(value("currency").toUpperCase())) {
        fields["body.currency"] = "Moneda inválida (código ISO de 3 letras, ej. CRC).";
      }
      if (!/^[A-Z]{2}$/.test(value("country").toUpperCase())) {
        fields["body.country"] = "País inválido (código ISO de 2 letras, ej. CR).";
      }
      if (!RE_EMAIL.test(value("ownerEmail"))) fields["body.ownerEmail"] = "Correo inválido.";
      if (Object.keys(fields).length > 0) return invalid(fields);
      // El slug sale del nombre; si ya existe, se le suma -2, -3…
      const base = slugify(value("name"));
      const taken = new Set(allAdminBusinesses(state).map((b) => b.slug));
      let slug = base;
      for (let n = 2; taken.has(slug); n++) slug = `${base}-${n}`;
      const created: AdminBusiness = {
        id: mockId(100 + state.createdBusinesses.length),
        name: value("name"),
        slug,
        industry: value("industry"),
        plan: "basic",
        status: "active",
        currency: value("currency").toUpperCase(),
        country: value("country").toUpperCase(),
        timezone: value("timezone"),
        locationCount: 1,
        createdAt: new Date().toISOString(),
      };
      state.createdBusinesses = [created, ...state.createdBusinesses];
      return ok(created, 201);
    }
  }

  return fail(404, "not_found", "Ruta inexistente en el mock.");
}

/** Transporte simulado: misma firma que el de red (ver lib/api.ts). */
export async function mockTransport(req: TransportRequest): Promise<TransportResponse> {
  await new Promise((resolve) => window.setTimeout(resolve, LATENCY_MS));
  const state = loadState();
  const res = route(req, state);
  saveState(state);
  if (import.meta.env.DEV) {
    console.debug(`[mock] ${req.method} ${req.path} → ${res.status}`, { location: req.headers["X-Location-Id"] ?? "todas" });
  }
  return res;
}
