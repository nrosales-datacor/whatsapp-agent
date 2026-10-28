import type { TransportRequest, TransportResponse } from "../../lib/api";
import type { Me, OnboardingStatus, OnboardingStepId, Role } from "../../lib/contract";
import { readStorage, writeStorage } from "../../lib/storage";

// ─────────────────────────────────────────────────────────────────────────────
// Alta self-service y checklist de primeros pasos en la API simulada (VITE_MOCK_API=1),
// con la misma forma que src/modules/onboarding:
//
//   • /signup: valida, el honeypot y un correo existente responden lo mismo (202) sin
//     crear nada; un alta nueva queda PENDIENTE con un token de verificación (no hay correo:
//     el último enlace lo muestra la pantalla "Revisá tu correo" en modo demo).
//   • /signup/verify: crea la cuenta y el negocio (lo hace lib/mockApi.ts, que tiene las
//     cuentas y la sesión) y devuelve `me`; el token es de un solo uso.
//   • /onboarding: pasos detectados con lo que sabe el mock (equipo y citas de la agenda
//     simulada); horario y servicios quedan pendientes. Descartar la oculta.
// Estado en sessionStorage (cada pestaña o test arranca limpio).
// ─────────────────────────────────────────────────────────────────────────────

export interface PendingSignup {
  token: string;
  businessName: string;
  industry: string;
  country: string;
  timezone: string;
  currency: string;
  ownerName: string;
  email: string;
  password: string;
}

interface SignupMockState {
  seq: number;
  pending: PendingSignup[];
  usedTokens: string[];
  lastToken: string | null;
  dismissed: string[];
}

const STATE_KEY = "selyon.mock.signup";
export const MOCK_TRIAL_DAYS = 14;

const INDUSTRIES = [
  { id: "dental", label: "Odontología" },
  { id: "aesthetics", label: "Estética" },
  { id: "nails", label: "Uñas" },
  { id: "generic", label: "Otro rubro" },
];

function load(): SignupMockState {
  const empty: SignupMockState = { seq: 0, pending: [], usedTokens: [], lastToken: null, dismissed: [] };
  const raw = readStorage(STATE_KEY, "session");
  if (!raw) return empty;
  try {
    return { ...empty, ...(JSON.parse(raw) as Partial<SignupMockState>) };
  } catch {
    return empty;
  }
}

function save(state: SignupMockState): void {
  writeStorage(STATE_KEY, JSON.stringify(state), "session");
}

/** Último enlace de verificación "mandado" (la pantalla de modo demo lo muestra). */
export function mockLastVerificationToken(): string | null {
  const state = load();
  return state.lastToken && !state.usedTokens.includes(state.lastToken) ? state.lastToken : null;
}

/** ¿Este correo y clave son de un alta pendiente de confirmar? (el login responde `email_not_verified`). */
export function isPendingSignupLogin(email: string, password: string): boolean {
  const e = email.trim().toLowerCase();
  return load().pending.some((p) => p.email === e && p.password === password);
}

function ok(data: unknown, status = 200): TransportResponse {
  return { status, payload: { ok: true, data } };
}

function fail(status: number, code: string, error: string, fields?: Record<string, string>): TransportResponse {
  return { status, payload: { ok: false, error, code, ...(fields ? { fields } : {}) } };
}

function str(body: unknown, key: string): string {
  const value = typeof body === "object" && body !== null ? (body as Record<string, unknown>)[key] : undefined;
  return typeof value === "string" ? value : "";
}

const RE_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const BLOCKED_DOMAINS = ["example.com", "mailinator.com", "yopmail.com"];
const ACCEPTED = () => ok({ status: "verification_sent" }, 202);

export interface SignupMockContext {
  /** ¿El correo ya tiene cuenta en el mock? */
  emailExists(email: string): boolean;
  /** Crea la cuenta, el negocio en prueba y la sesión; devuelve `me`. */
  createAccount(signup: PendingSignup): Me;
  /** Sesión actual (para /onboarding), o null. */
  session: {
    businessId: string;
    role: Role;
    modules: string[];
    /** ¿El negocio es nuevo (alta self-service) y muestra la checklist? */
    onboarding: boolean;
    staffCount: () => number;
    appointmentCount: () => number;
  } | null;
}

/** Responde una ruta de /signup* u /onboarding*, o null si no es suya. */
export function routeSignupMock(req: TransportRequest, ctx: SignupMockContext): TransportResponse | null {
  const path = req.path.split("?")[0];
  if (!path.startsWith("/signup") && !path.startsWith("/onboarding")) return null;
  const state = load();
  const res = route(req.method, path, req.body, state, ctx);
  save(state);
  return res;
}

function route(method: string, path: string, body: unknown, state: SignupMockState, ctx: SignupMockContext): TransportResponse {
  switch (`${method} ${path}`) {
    case "GET /signup/options":
      return ok({ industries: INDUSTRIES, trialDays: MOCK_TRIAL_DAYS });

    case "POST /signup": {
      if (str(body, "website").trim()) return ACCEPTED();
      const value = (key: string) => str(body, key).trim();
      const email = value("email").toLowerCase();
      const fields: Record<string, string> = {};
      if (!value("businessName")) fields["body.businessName"] = "Campo obligatorio.";
      if (!value("ownerName")) fields["body.ownerName"] = "Campo obligatorio.";
      if (!INDUSTRIES.some((i) => i.id === value("industry"))) fields["body.industry"] = "Rubro inválido.";
      if (!RE_EMAIL.test(email)) fields["body.email"] = "Escribí un correo válido.";
      else if (BLOCKED_DOMAINS.includes(email.split("@")[1])) fields["body.email"] = "Escribí un correo válido.";
      if (str(body, "password").length < 8) fields["body.password"] = "La clave tiene que tener al menos 8 caracteres.";
      if (Object.keys(fields).length > 0) return fail(400, "validation_error", "Datos inválidos: revisá los campos marcados.", fields);
      // Correo con cuenta: misma respuesta, sin crear nada (el aviso iría por correo).
      if (ctx.emailExists(email)) return ACCEPTED();
      state.seq += 1;
      const token = `verificar-${state.seq}`;
      state.pending = [
        ...state.pending.filter((p) => p.email !== email),
        {
          token,
          businessName: value("businessName"),
          industry: value("industry"),
          country: value("country").toUpperCase() || "CR",
          timezone: value("timezone") || "America/Costa_Rica",
          currency: value("currency").toUpperCase() || "CRC",
          ownerName: value("ownerName"),
          email,
          password: str(body, "password"),
        },
      ];
      state.lastToken = token;
      return ACCEPTED();
    }

    case "POST /signup/resend": {
      const email = str(body, "email").trim().toLowerCase();
      const pending = state.pending.find((p) => p.email === email);
      if (pending) {
        state.seq += 1;
        pending.token = `verificar-${state.seq}`;
        state.lastToken = pending.token;
      }
      return { status: 204, payload: undefined };
    }

    case "POST /signup/verify": {
      const token = str(body, "token");
      const pending = state.pending.find((p) => p.token === token);
      if (!pending || state.usedTokens.includes(token)) {
        return fail(400, "invalid_token", "El enlace no es válido o venció. Pedí uno nuevo desde la pantalla de ingreso.");
      }
      state.usedTokens.push(token);
      state.pending = state.pending.filter((p) => p !== pending);
      return ok(ctx.createAccount(pending));
    }

    case "GET /onboarding":
    case "POST /onboarding/dismiss": {
      const s = ctx.session;
      if (!s) return fail(401, "unauthorized", "Tu sesión no es válida o venció. Iniciá sesión de nuevo.");
      if (s.role !== "owner" && s.role !== "admin") return fail(403, "forbidden_role", "No tenés permiso para esta acción.");
      if (method === "POST" && !state.dismissed.includes(s.businessId)) state.dismissed.push(s.businessId);
      return ok(onboardingOf(state, s));
    }
  }
  return fail(404, "not_found", "Ruta inexistente en el mock.");
}

function onboardingOf(state: SignupMockState, s: NonNullable<SignupMockContext["session"]>): OnboardingStatus {
  const dismissed = !s.onboarding || state.dismissed.includes(s.businessId);
  const done: Record<OnboardingStepId, boolean> = {
    hours: false,
    services: false,
    team: s.staffCount() > 0,
    whatsapp: false,
    first_appointment: s.appointmentCount() > 0,
  };
  const ids: OnboardingStepId[] = ["hours", "services", "team", ...(s.modules.includes("whatsapp") ? (["whatsapp"] as const) : []), "first_appointment"];
  const steps = ids.map((id) => ({ id, done: done[id] }));
  const completed = steps.every((x) => x.done);
  return { visible: !dismissed && !completed, dismissed, completed, steps };
}
