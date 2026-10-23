import type { Plan } from "../business";

// ─────────────────────────────────────────────────────────────────────────────
// Configuración del cobro en línea (Stripe) y de los vencimientos (PLAN-GESTION.md §7, I6).
// Todo sale del entorno y se lee en cada uso (`env` inyectable en los tests): cambiar un
// precio no pide tocar código, y sin las variables de Stripe el cobro en línea queda
// APAGADO (cada endpoint responde 503 `billing_not_configured` con un mensaje claro) y el
// cobro manual del superadmin sigue igual.
//
//   STRIPE_SECRET_KEY        clave secreta (sk_live_… / sk_test_…): Checkout y Portal.
//   STRIPE_WEBHOOK_SECRET    secreto de firma del endpoint (whsec_…): /webhook/stripe.
//   STRIPE_PRICE_BASIC       Price ID mensual del plan Básico.
//   STRIPE_PRICE_PRO         Price ID mensual del plan Pro (incluye la base de cupos).
//   STRIPE_PRICE_EXTRA_LOCATION  (opcional) Price ID por sucursal extra del Pro (por cantidad).
//   STRIPE_PRICE_EXTRA_STAFF     (opcional) Price ID por profesional extra del Pro (por cantidad).
//
// Los montos, la moneda y el ciclo se definen en el Dashboard de Stripe: acá solo se
// referencian por Price ID, nunca se escriben montos en el código.
//
//   TRIAL_DAYS                    días de prueba del alta self-service (default 14).
//   BILLING_PAST_DUE_GRACE_DAYS   días de gracia con el pago atrasado antes de pausar (default 7).
// ─────────────────────────────────────────────────────────────────────────────

type Env = Record<string, string | undefined>;

export interface StripeConfig {
  secretKey: string;
  webhookSecret: string;
  prices: {
    basic: string | null;
    pro: string | null;
    extraLocation: string | null;
    extraStaff: string | null;
  };
}

function value(env: Env, name: string): string | null {
  return env[name]?.trim() || null;
}

/** Entero ≥ 0 del entorno, con un tope (vacío o inválido = default). */
function intFromEnv(env: Env, name: string, fallback: number, max: number): number {
  const raw = env[name]?.trim();
  const n = raw ? Number(raw) : NaN;
  return Number.isInteger(n) && n >= 0 && n <= max ? n : fallback;
}

/**
 * Configuración de Stripe, o null si falta lo mínimo para cobrar en línea: la clave, el
 * secreto del webhook y al menos un precio de plan.
 */
export function readStripeConfig(env: Env = process.env): StripeConfig | null {
  const secretKey = value(env, "STRIPE_SECRET_KEY");
  const webhookSecret = value(env, "STRIPE_WEBHOOK_SECRET");
  const prices = {
    basic: value(env, "STRIPE_PRICE_BASIC"),
    pro: value(env, "STRIPE_PRICE_PRO"),
    extraLocation: value(env, "STRIPE_PRICE_EXTRA_LOCATION"),
    extraStaff: value(env, "STRIPE_PRICE_EXTRA_STAFF"),
  };
  if (!secretKey || !webhookSecret || (!prices.basic && !prices.pro)) return null;
  return { secretKey, webhookSecret, prices };
}

/** Secreto de firma del webhook (alcanza con él para verificar eventos). */
export function readStripeWebhookSecret(env: Env = process.env): string | null {
  return value(env, "STRIPE_WEBHOOK_SECRET");
}

/** Price ID del plan, o null si ese plan no tiene precio cargado. */
export function priceOfPlan(config: StripeConfig, plan: Plan): string | null {
  return plan === "pro" ? config.prices.pro : config.prices.basic;
}

/** Plan de un Price ID (null si no es ninguno de los configurados: nunca se adivina). */
export function planOfPrice(config: Pick<StripeConfig, "prices">, priceId: string): Plan | null {
  if (config.prices.pro && priceId === config.prices.pro) return "pro";
  if (config.prices.basic && priceId === config.prices.basic) return "basic";
  return null;
}

/** ¿La clave es de modo prueba? (los links al Dashboard llevan `/test`). */
export function isStripeTestMode(config: Pick<StripeConfig, "secretKey">): boolean {
  return config.secretKey.startsWith("sk_test_") || config.secretKey.startsWith("rk_test_");
}

export const DEFAULT_TRIAL_DAYS = 14;
export const DEFAULT_PAST_DUE_GRACE_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Días de prueba del alta self-service (TRIAL_DAYS, 1–90; default 14). */
export function trialDays(env: Env = process.env): number {
  const days = intFromEnv(env, "TRIAL_DAYS", DEFAULT_TRIAL_DAYS, 90);
  return days === 0 ? DEFAULT_TRIAL_DAYS : days;
}

/** Gracia con el pago atrasado antes de pausar (BILLING_PAST_DUE_GRACE_DAYS, 0–60; default 7). */
export function pastDueGraceDays(env: Env = process.env): number {
  return intFromEnv(env, "BILLING_PAST_DUE_GRACE_DAYS", DEFAULT_PAST_DUE_GRACE_DAYS, 60);
}

/** Fin de una prueba que empieza en `from`. */
export function trialEndFrom(from: Date, env: Env = process.env): Date {
  return new Date(from.getTime() + trialDays(env) * DAY_MS);
}

/** Cuándo se pausa un negocio con el pago atrasado desde `since`. */
export function pauseDateFor(since: Date, env: Env = process.env): Date {
  return new Date(since.getTime() + pastDueGraceDays(env) * DAY_MS);
}

/** Corte del barrido: lo atrasado desde ANTES de esto ya agotó la gracia. */
export function pastDueCutoff(now: Date, env: Env = process.env): Date {
  return new Date(now.getTime() - pastDueGraceDays(env) * DAY_MS);
}
