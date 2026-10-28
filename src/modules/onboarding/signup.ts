import { z } from "zod";
import { hashPassword } from "../../platform/auth/password";
import type { SessionClaims } from "../../platform/auth/sessionToken";
import { recordAudit, userActor } from "../../platform/audit/auditLog";
import { hasPgCode, PG_UNIQUE_VIOLATION } from "../../platform/db/errors";
import { withSystem, type Executor } from "../../platform/db/scope";
import { queueEmail } from "../../platform/email/enqueue";
import { signupExistingAccountEmail } from "../../platform/email/templates";
import { tooManyAttempts, ValidationError } from "../../platform/http/errors";
import { publicBaseUrl, publicUrl } from "../../platform/http/publicUrl";
import { log } from "../../platform/observability/log";
import { startTrial, trialDays } from "../billing";
import {
  createBusiness,
  INDUSTRIES,
  invalidateBusinessContext,
  isValidTimeZone,
  listIndustryTemplates,
  type ProvisioningSteps,
} from "../business";
import {
  createUnverifiedOwner,
  findAccountByEmail,
  NewPasswordSchema,
  normalizeEmail,
  resendEmailVerification,
  sendEmailVerification,
  verifyEmailToken,
} from "../team";
import { checkEmailDomain, emailDomainMessage, type EmailDomainOptions } from "./emailDomain";
import { hitLimit, signupLimits } from "./rateLimit";

// ─────────────────────────────────────────────────────────────────────────────
// Alta self-service (PLAN-GESTION.md §7, I6): una dueña crea su negocio desde
// /panel/signup sin pasar por nosotros.
//
//   POST /signup          → crea el negocio con la plantilla del rubro, su primera sucursal
//                           (horario default), los métodos de pago, la dueña con el correo
//                           SIN verificar y la prueba de TRIAL_DAYS días; manda el enlace de
//                           verificación. Responde SIEMPRE lo mismo (202 "revisá tu correo"):
//                           si el correo ya tiene cuenta no se crea nada y el aviso va al
//                           correo ("ya tenés una cuenta"), así la API no revela qué correos
//                           existen. La clave se hashea en todos los caminos (mismo costo).
//   POST /signup/verify   → consume el enlace, verifica el correo, reinicia la prueba desde
//                           hoy y deja la sesión iniciada (devuelve `me`).
//   POST /signup/resend   → reenvía el enlace (204 siempre).
//
// Anti-abuso sin CAPTCHA:
//   • honeypot (`website`): un campo oculto que una persona no ve ni completa; si viene con
//     algo, se responde igual que un alta y no se hace nada;
//   • rate limit por IP y por correo (./rateLimit.ts), en el alta y en el reenvío;
//   • dominio del correo válido: con forma de dominio público, no descartable y con
//     servidor de correo (./emailDomain.ts);
//   • y la cuenta no sirve para nada hasta verificar el correo (modules/team).
// ─────────────────────────────────────────────────────────────────────────────

/** Nombre de la primera sucursal del alta (se renombra en Configuración › Sucursales). */
export const FIRST_LOCATION_NAME = "Principal";

const Name = z.string().trim().min(1, "Campo obligatorio.").max(120);

export const SignupInput = z.object({
  businessName: Name,
  industry: z.enum(INDUSTRIES),
  country: z
    .string()
    .trim()
    .transform((s) => s.toUpperCase())
    .pipe(z.string().regex(/^[A-Z]{2}$/, "País inválido (código ISO de 2 letras, ej. CR).")),
  timezone: z.string().trim().refine(isValidTimeZone, "Zona horaria inválida (ej. America/Costa_Rica)."),
  currency: z
    .string()
    .trim()
    .transform((s) => s.toUpperCase())
    .pipe(z.string().regex(/^[A-Z]{3}$/, "Moneda inválida (código ISO de 3 letras, ej. CRC).")),
  ownerName: Name,
  email: z.email("Escribí un correo válido.").max(254),
  password: NewPasswordSchema,
  // Honeypot: oculto en el formulario. Una persona lo deja vacío.
  website: z.string().max(500).optional(),
});

export type SignupInputValue = z.output<typeof SignupInput>;

export const VerifyInput = z.object({ token: z.string().min(1).max(200) });
export const ResendInput = z.object({ email: z.string().trim().min(1).max(320) });

export interface SignupDeps {
  /** Pasos del alta que viven en otros módulos (catálogo y métodos de pago: src/provisioning.ts). */
  provisioning: ProvisioningSteps;
  /** Chequeo del dominio del correo (los tests inyectan el resolver DNS). */
  emailDomain?: EmailDomainOptions;
  now?: () => Date;
}

/** Opciones del formulario: rubros con su nombre (de las plantillas) y días de prueba. */
export function signupOptions() {
  return {
    industries: listIndustryTemplates().map((t) => ({ id: t.industry, label: t.label })),
    trialDays: trialDays(),
  };
}

function enforce(key: string, limit: number, windowMs: number): void {
  const check = hitLimit(key, limit, windowMs);
  if (!check.allowed) throw tooManyAttempts(check.retryAfterSec);
}

/** Respuesta única del alta (exista o no el correo, pase o no el honeypot). */
export interface SignupAccepted {
  status: "verification_sent";
}

const ACCEPTED: SignupAccepted = { status: "verification_sent" };

export async function signup(db: Executor, input: SignupInputValue & { ip: string }, deps: SignupDeps): Promise<SignupAccepted> {
  if (input.website && input.website.trim() !== "") {
    log.warn("signup_honeypot", {});
    return ACCEPTED;
  }
  const email = normalizeEmail(input.email);
  const limits = signupLimits();
  enforce(`signup:ip:${input.ip}`, limits.signupPerIp, limits.windowMs);
  enforce(`signup:email:${email}`, limits.signupPerEmail, limits.windowMs);

  const domain = await checkEmailDomain(email, deps.emailDomain);
  if (!domain.ok) throw new ValidationError({ "body.email": emailDomainMessage(domain.problem) });

  // Los links de los correos se resuelven ANTES de mirar si el correo existe: sin
  // PUBLIC_BASE_URL en producción falla igual para todos (no es un oráculo).
  publicBaseUrl();
  // Mismo costo de CPU exista o no la cuenta.
  const passwordHash = await hashPassword(input.password);
  const now = (deps.now ?? (() => new Date()))();

  const existing = await findAccountByEmail(db, email);
  if (existing) {
    await notifyExistingAccount(db, existing);
    return ACCEPTED;
  }

  let businessId: string;
  try {
    businessId = await withSystem(db, async (tx) => {
      const { business } = await createBusiness(
        tx,
        {
          name: input.businessName,
          industry: input.industry,
          timezone: input.timezone,
          currency: input.currency,
          country: input.country,
          locationName: FIRST_LOCATION_NAME,
        },
        deps.provisioning,
      );
      const { userId } = await createUnverifiedOwner(tx, { businessId: business.id, email, name: input.ownerName, passwordHash, now });
      const actor = userActor(userId);
      await recordAudit(tx, business.id, "business_created", actor, { industry: business.industry, plan: business.plan, source: "self_service" });
      await startTrial(tx, business.id, actor, now);
      await sendEmailVerification(tx, {
        userId,
        email,
        name: input.ownerName,
        businessId: business.id,
        businessName: business.name,
        trialDays: trialDays(),
      });
      return business.id;
    });
  } catch (error) {
    // Dos altas simultáneas con el mismo correo: la segunda choca con el índice único y
    // responde lo mismo (sin crear nada).
    if (hasPgCode(error, PG_UNIQUE_VIOLATION)) return ACCEPTED;
    throw error;
  }
  invalidateBusinessContext(businessId);
  log.info("signup_business_created", { businessId });
  return ACCEPTED;
}

/** El correo ya tiene cuenta: si está pendiente de verificar, se le reenvía el enlace; si no, el aviso. */
async function notifyExistingAccount(db: Executor, account: Awaited<ReturnType<typeof findAccountByEmail>> & object): Promise<void> {
  if (!account.active) return;
  if (account.unverified) {
    await resendEmailVerification(db, account.email, { trialDays: trialDays() });
    return;
  }
  const content = signupExistingAccountEmail({
    userName: account.name,
    loginUrl: publicUrl("/panel/login"),
    resetUrl: publicUrl("/panel/forgot-password"),
  });
  await withSystem(db, (tx) => queueEmail(tx, { to: account.email, ...content, tags: { kind: "signup_existing_account" } }));
}

/**
 * Verifica el correo con el enlace y devuelve los claims de la sesión. La prueba se
 * reinicia desde hoy (los días empiezan a contar cuando la cuenta se puede usar).
 */
export async function verifySignup(db: Executor, token: string, deps: Pick<SignupDeps, "now"> = {}): Promise<SessionClaims> {
  const now = (deps.now ?? (() => new Date()))();
  const claims = await verifyEmailToken(db, token, async (tx, { userId, businessId }) => {
    // Solo si sigue en la prueba del alta (si el superadmin ya lo pasó a otro estado, se respeta).
    await startTrial(tx, businessId, userActor(userId), now, { onlyIfInTrial: true });
  });
  invalidateBusinessContext(claims.businessId);
  return claims;
}

/** Reenvío del enlace (204 siempre, con rate limit por IP y por correo). */
export async function resendVerification(db: Executor, input: { email: string; ip: string }): Promise<void> {
  const email = normalizeEmail(input.email);
  const limits = signupLimits();
  enforce(`resend:ip:${input.ip}`, limits.resendPerIp, limits.windowMs);
  enforce(`resend:email:${email}`, limits.resendPerEmail, limits.windowMs);
  publicBaseUrl();
  await resendEmailVerification(db, email, { trialDays: trialDays() });
}
