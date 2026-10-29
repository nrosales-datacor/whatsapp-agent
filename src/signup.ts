import { z } from "zod";
import { recordAudit, userActor } from "./platform/audit/auditLog";
import { hashPassword } from "./platform/auth/password";
import { withSystem, type Executor } from "./platform/db/scope";
import { HttpError } from "./platform/http/errors";
import { publicBaseUrl } from "./platform/http/publicUrl";
import { reply, route } from "./platform/http/router";
import type { Route } from "./platform/http/routeTypes";
import { getClientIp } from "./platform/net/clientIp";
import { createBusiness, INDUSTRIES, isValidTimeZone, PLANS } from "./modules/business";
import {
  createSelfServiceOwner,
  emailHasAccount,
  guardCredentialAttempt,
  NewPasswordSchema,
  noticeExistingAccount,
  normalizeEmail,
  recordCredentialFailure,
} from "./modules/team";
import { PROVISIONING_STEPS } from "./provisioning";

// ─────────────────────────────────────────────────────────────────────────────
// Alta self-service (I6.7): un negocio se registra solo desde /panel/signup. Vive en la
// composición (como el alta del superadmin en src/admin) porque junta business (el
// negocio con la plantilla del rubro), catalog y sales (pasos del alta) y team (la cuenta
// dueña), y ninguno de esos módulos puede importar a los otros.
//
//   GET  /auth/signup/config  { enabled, trialDays } (público: el login muestra o no el link)
//   POST /auth/signup         alta → 202 { status: "verification_sent" }
//
// Detrás de `SIGNUP_ENABLED` (apagada por defecto: AUDIT-v2 pide un gate de seguridad y
// legal antes de abrir el modelo self-service). Apagada, el alta responde 404 como una
// ruta que no existe.
//
//   • El resultado es el MISMO negocio que da de alta el superadmin (createBusiness con
//     PROVISIONING_STEPS: sucursal con horario, plantilla del rubro, catálogo y métodos de
//     pago), con el plan elegido, el cobro en `trial` y `trial_ends_at` = hoy +
//     SIGNUP_TRIAL_DAYS. Al vencer sin suscripción pasa a pago pendiente (barrido de
//     billing); nadie lo pausa solo.
//   • La cuenta dueña nace con su clave y SIN verificar: no entra hasta confirmar el correo
//     (link de 48 h). Todo en UNA transacción con el correo encolado (outbox).
//   • No es un oráculo de cuentas: con un correo que ya tiene cuenta no se crea nada, la
//     respuesta es idéntica y a esa cuenta le llega un aviso por correo. scrypt corre igual
//     en los dos casos (mismo tiempo de respuesta).
//   • Tope por IP: cada alta cuenta como un "fallo" del par (IP, alta) en el rate limit de
//     credenciales → a partir de la 5.ª desde la misma IP, espera progresiva (429). El tope
//     general por IP (presupuesto de scrypt) también aplica.
// ─────────────────────────────────────────────────────────────────────────────

type Env = Record<string, string | undefined>;

/** ¿Está abierta el alta self-service? (`SIGNUP_ENABLED=1|true|yes`). */
export function signupEnabled(env: Env = process.env): boolean {
  return ["1", "true", "yes", "on"].includes(env.SIGNUP_ENABLED?.trim().toLowerCase() ?? "");
}

/** Días de prueba gratis del alta (SIGNUP_TRIAL_DAYS, 1–90; default 14). */
export function signupTrialDays(env: Env = process.env): number {
  const n = Number(env.SIGNUP_TRIAL_DAYS?.trim() || NaN);
  return Number.isInteger(n) && n >= 1 && n <= 90 ? n : 14;
}

const Name = z.string().trim().min(1).max(120);

export const SignupBody = z.object({
  businessName: Name,
  industry: z.enum(INDUSTRIES),
  country: z
    .string()
    .trim()
    .transform((s) => s.toUpperCase())
    .pipe(z.string().regex(/^[A-Z]{2}$/, "País inválido (código ISO de 2 letras, ej. CR).")),
  currency: z
    .string()
    .trim()
    .transform((s) => s.toUpperCase())
    .pipe(z.string().regex(/^[A-Z]{3}$/, "Moneda inválida (código ISO de 3 letras, ej. CRC).")),
  timezone: z.string().trim().refine(isValidTimeZone, "Zona horaria inválida (ej. America/Costa_Rica)."),
  plan: z.enum(PLANS),
  ownerName: Name,
  email: z.email("Escribí un correo válido.").max(320),
  password: NewPasswordSchema,
  acceptTerms: z.literal(true, "Tenés que aceptar los términos y el aviso de privacidad."),
});

export type SignupInput = z.output<typeof SignupBody>;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Nombre de la primera sucursal de un alta self-service (se cambia en Configuración). */
export const FIRST_LOCATION_NAME = "Principal";

/**
 * Registra el negocio y su cuenta dueña (o le avisa a la cuenta que ya existe). Devuelve
 * el id del negocio creado, o null si el correo ya tenía cuenta. El llamador responde
 * igual en los dos casos.
 */
export async function signUp(db: Executor, input: SignupInput, options: { ip: string; now?: Date; trialDays?: number }): Promise<string | null> {
  const email = normalizeEmail(input.email);
  guardCredentialAttempt(options.ip, "signup", options.ip);
  recordCredentialFailure(options.ip, "signup", options.ip);
  // Los links del correo necesitan la base pública: se resuelve antes de tocar nada.
  publicBaseUrl();
  const passwordHash = await hashPassword(input.password);
  const now = options.now ?? new Date();
  const trialDays = options.trialDays ?? signupTrialDays();

  return withSystem(db, async (tx) => {
    const existing = await emailHasAccount(tx, email);
    if (existing) {
      if (existing.active) await noticeExistingAccount(tx, existing);
      return null;
    }
    const { business } = await createBusiness(
      tx,
      {
        name: input.businessName,
        industry: input.industry,
        timezone: input.timezone,
        currency: input.currency,
        country: input.country,
        locationName: FIRST_LOCATION_NAME,
        plan: input.plan,
        billingStatus: "trial",
        trialEndsAt: new Date(now.getTime() + trialDays * DAY_MS),
      },
      PROVISIONING_STEPS,
    );
    const userId = await createSelfServiceOwner(tx, {
      businessId: business.id,
      businessName: business.name,
      email,
      name: input.ownerName,
      passwordHash,
    });
    await recordAudit(tx, business.id, "business_signed_up", userActor(userId), { industry: business.industry, plan: business.plan, trialDays });
    return business.id;
  });
}

const signupDisabled = () => new HttpError(404, "Recurso no encontrado.", "not_found");

export interface SignupRouteDeps {
  db: Executor;
  /** Default: `SIGNUP_ENABLED` del entorno (se relee en cada request). */
  enabled?: () => boolean;
}

export function signupRoutes({ db, enabled = () => signupEnabled() }: SignupRouteDeps): Route[] {
  return [
    route({ method: "GET", path: "/auth/signup/config", auth: "public" }, () => ({ enabled: enabled(), trialDays: signupTrialDays() })),

    route({ method: "POST", path: "/auth/signup", auth: "public", body: SignupBody }, async ({ req, body, log }) => {
      if (!enabled()) throw signupDisabled();
      const businessId = await signUp(db, body, { ip: getClientIp(req) });
      if (businessId) log.info("business_signed_up", { businessId });
      return reply(202, { status: "verification_sent" as const });
    }),
  ];
}
