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
export const MOCK_INVITATION_TOKEN = "demo";
export const MOCK_EXPIRED_RESET_TOKEN = "vencido";
export const MOCK_ADMIN_USERNAME = "admin";

/** Cuentas de prueba (las lista la pantalla de login en modo mock). */
export const MOCK_ACCOUNTS: readonly { email: string; description: string }[] = [
  { email: "duena@demo.test", description: "Dueña, plan Pro, 2 sucursales y 2 negocios" },
  { email: "basico@demo.test", description: "Dueño, plan Básico (Ventas, Reportes y Campañas con candado)" },
  { email: "sinagente@demo.test", description: "Dueña, Pro sin agente (sin WhatsApp IA)" },
  { email: "recepcion@demo.test", description: "Recepción, fija a una sucursal" },
  { email: "profesional@demo.test", description: "Profesional (Mi agenda, Mis pacientes, Mis comisiones)" },
  { email: "2fa@demo.test", description: `Dueña con 2FA (código ${MOCK_TOTP_CODE})` },
  { email: "temporal@demo.test", description: "Admin con clave temporal (cambio obligatorio)" },
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
];

const INVITATION = { email: "nuevo@demo.test", businessId: DENTAL, role: "staff" as Role };

// ── Estado (sessionStorage) ─────────────────────────────────────────────────

interface MockState {
  sessionEmail: string | null;
  businessId: string | null;
  admin: boolean;
  failedLogins: number;
  /** Cambios sobre las cuentas base: clave nueva, 2FA, cambio de clave hecho. */
  overrides: Record<string, Partial<Pick<MockUser, "totpEnabled" | "mustChangePassword">> & { password?: string }>;
  extraUsers: MockUser[];
  createdBusinesses: AdminBusiness[];
  invitationUsed: boolean;
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
    createdBusinesses: [],
    invitationUsed: false,
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
  return { ...base, ...flags };
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

const unauthorized = () => fail(401, "unauthorized", "Tu sesión venció. Ingresá de nuevo.");

const RE_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function str(body: unknown, key: string): string {
  const value = typeof body === "object" && body !== null ? (body as Record<string, unknown>)[key] : undefined;
  return typeof value === "string" ? value : "";
}

function slugify(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function allAdminBusinesses(state: MockState): AdminBusiness[] {
  const base = Object.values(BUSINESSES).map((b) => ({
    id: b.id,
    name: b.name,
    slug: b.slug,
    plan: b.plan,
    industry: b.industry,
    status: b.status,
    country: b.country,
    createdAt: b.createdAt,
  }));
  return [...state.createdBusinesses, ...base];
}

function route(req: TransportRequest, state: MockState): TransportResponse {
  const path = req.path.split("?")[0];
  const { body } = req;
  const sessionUser = state.sessionEmail ? findUser(state, state.sessionEmail) : null;
  const sessionMe = () => (sessionUser ? buildMe(sessionUser, state.businessId ?? sessionUser.memberships[0].businessId) : null);

  const invitationMatch = /^\/auth\/invitations\/([^/]+)$/.exec(path);
  if (req.method === "GET" && invitationMatch) {
    const token = decodeURIComponent(invitationMatch[1]);
    if (token !== MOCK_INVITATION_TOKEN || state.invitationUsed) {
      return fail(404, "invitation_not_found", "La invitación no existe, venció o ya se usó.");
    }
    return ok({ email: INVITATION.email, businessName: BUSINESSES[INVITATION.businessId].name, role: INVITATION.role });
  }

  switch (`${req.method} ${path}`) {
    case "GET /auth/me": {
      const me = sessionMe();
      return me ? ok(me) : unauthorized();
    }

    case "POST /auth/login": {
      const email = str(body, "email").trim().toLowerCase();
      const password = str(body, "password");
      const totpCode = str(body, "totpCode");
      if (state.failedLogins >= 5) {
        return fail(429, "too_many_attempts", "Demasiados intentos. Esperá unos minutos y probá de nuevo.");
      }
      const user = findUser(state, email);
      if (!user || password !== passwordOf(state, user.email)) {
        state.failedLogins += 1;
        return fail(401, "invalid_credentials", "El correo o la clave no coinciden.");
      }
      if (user.totpEnabled && !totpCode) return ok({ status: "totp_required" });
      if (user.totpEnabled && totpCode !== MOCK_TOTP_CODE) {
        state.failedLogins += 1;
        return fail(401, "invalid_totp", "El código no es válido. Revisá tu app de autenticación.");
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
        return fail(403, "forbidden", "No tenés acceso a ese negocio.");
      }
      state.businessId = businessId;
      return ok(buildMe(sessionUser, businessId));
    }

    case "POST /auth/password/forgot": {
      const email = str(body, "email").trim();
      if (!RE_EMAIL.test(email)) return invalid({ "body.email": "Escribí un correo válido." });
      return noContent();
    }

    case "POST /auth/password/reset": {
      const token = str(body, "token");
      const password = str(body, "password");
      if (!token || token === MOCK_EXPIRED_RESET_TOKEN) {
        return fail(400, "invalid_token", "El enlace venció o ya se usó. Pedí uno nuevo.");
      }
      if (password.length < 8) return invalid({ "body.password": "La clave debe tener al menos 8 caracteres." });
      return noContent();
    }

    case "POST /auth/password/change": {
      if (!sessionUser) return unauthorized();
      const current = str(body, "currentPassword");
      const next = str(body, "newPassword");
      if (current !== passwordOf(state, sessionUser.email)) {
        return fail(400, "invalid_password", "La clave actual no es correcta.", { "body.currentPassword": "La clave actual no es correcta." });
      }
      if (next.length < 8) return invalid({ "body.newPassword": "La clave debe tener al menos 8 caracteres." });
      if (next === current) return invalid({ "body.newPassword": "La clave nueva tiene que ser distinta de la actual." });
      state.overrides[sessionUser.email] = { ...state.overrides[sessionUser.email], password: next, mustChangePassword: false };
      return noContent();
    }

    case "POST /auth/totp/setup": {
      if (!sessionUser) return unauthorized();
      const secret = "JBSWY3DPEHPK3PXP";
      const label = encodeURIComponent(`Selyon CRM:${sessionUser.email}`);
      return ok({ secret, otpauthUrl: `otpauth://totp/${label}?secret=${secret}&issuer=Selyon%20CRM` });
    }

    case "POST /auth/totp/enable": {
      if (!sessionUser) return unauthorized();
      if (str(body, "code") !== MOCK_TOTP_CODE) {
        return fail(400, "invalid_code", "El código no es válido. Probá con el que muestra la app ahora.", { "body.code": "Código incorrecto." });
      }
      state.overrides[sessionUser.email] = { ...state.overrides[sessionUser.email], totpEnabled: true };
      return noContent();
    }

    case "POST /auth/totp/disable": {
      if (!sessionUser) return unauthorized();
      if (str(body, "password") !== passwordOf(state, sessionUser.email)) {
        return fail(400, "invalid_password", "La clave no es correcta.", { "body.password": "La clave no es correcta." });
      }
      if (str(body, "code") !== MOCK_TOTP_CODE) {
        return fail(400, "invalid_code", "El código no es válido.", { "body.code": "Código incorrecto." });
      }
      state.overrides[sessionUser.email] = { ...state.overrides[sessionUser.email], totpEnabled: false };
      return noContent();
    }

    case "POST /auth/invitations/accept": {
      const token = str(body, "token");
      const name = str(body, "name").trim();
      const password = str(body, "password");
      if (token !== MOCK_INVITATION_TOKEN || state.invitationUsed) {
        return fail(404, "invitation_not_found", "La invitación no existe, venció o ya se usó.");
      }
      const fields: Record<string, string> = {};
      if (!name) fields["body.name"] = "Escribí tu nombre.";
      if (password.length < 8) fields["body.password"] = "La clave debe tener al menos 8 caracteres.";
      if (Object.keys(fields).length > 0) return invalid(fields);
      const user: MockUser = {
        id: "7e1f0a2b-1111-4c3d-8e4f-000000000099",
        name,
        email: INVITATION.email,
        totpEnabled: false,
        mustChangePassword: false,
        memberships: [{ businessId: INVITATION.businessId, role: INVITATION.role, locationIds: [LOC_ESCAZU] }],
      };
      state.extraUsers = [...state.extraUsers.filter((u) => u.email !== user.email), user];
      state.overrides[user.email] = { password };
      state.invitationUsed = true;
      state.sessionEmail = user.email;
      state.businessId = INVITATION.businessId;
      return ok(buildMe(user, INVITATION.businessId));
    }

    // ── Superadmin ──
    case "POST /admin/login": {
      const username = str(body, "username").trim();
      const password = str(body, "password");
      const totpCode = str(body, "totpCode");
      if (username !== MOCK_ADMIN_USERNAME || password !== MOCK_PASSWORD) {
        return fail(401, "invalid_credentials", "El usuario o la clave no coinciden.");
      }
      if (!totpCode) return ok({ status: "totp_required" });
      if (totpCode !== MOCK_TOTP_CODE) return fail(401, "invalid_totp", "El código no es válido.");
      state.admin = true;
      return ok({ status: "ok", admin: { username } });
    }

    case "POST /admin/logout":
      state.admin = false;
      return noContent();

    case "GET /admin/me":
      return state.admin ? ok({ username: MOCK_ADMIN_USERNAME }) : unauthorized();

    case "GET /admin/businesses":
      return state.admin ? ok(allAdminBusinesses(state)) : unauthorized();

    case "POST /admin/businesses": {
      if (!state.admin) return unauthorized();
      const keys = ["name", "industry", "timezone", "currency", "country", "locationName", "ownerEmail", "ownerName"];
      const fields: Record<string, string> = {};
      for (const key of keys) if (!str(body, key).trim()) fields[`body.${key}`] = "Este campo es obligatorio.";
      const ownerEmail = str(body, "ownerEmail").trim();
      if (ownerEmail && !RE_EMAIL.test(ownerEmail)) fields["body.ownerEmail"] = "Escribí un correo válido.";
      if (Object.keys(fields).length > 0) return invalid(fields);
      const name = str(body, "name").trim();
      const slug = slugify(name);
      if (allAdminBusinesses(state).some((b) => b.slug === slug)) {
        return fail(409, "slug_taken", "Ya existe un negocio con ese nombre.", { "body.name": "Ya existe un negocio con ese nombre." });
      }
      const created: AdminBusiness = {
        id: `5d0a1c7e-2f4b-4b8e-8f3a-${String(100000000000 + state.createdBusinesses.length + 1)}`,
        name,
        slug,
        plan: "basic",
        industry: str(body, "industry"),
        status: "active",
        country: str(body, "country"),
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
