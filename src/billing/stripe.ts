import Stripe from "stripe";
import type { Plan, Tenant } from "../types";

// ─────────────────────────────────────────────────────────────────────────────
// Facturación por suscripción (ROADMAP C4.3). Igual que Sentry/Calendar/Embedded
// Signup: sin las env de Stripe, esto es un NO-OP total (facturacionConfigurada()
// en false) — el panel simplemente no ofrece la pestaña. Los precios reales (montos,
// moneda, ciclo) se crean en el Dashboard de Stripe; acá solo se referencian por
// Price ID (STRIPE_PRICE_BASICO / STRIPE_PRICE_PRO), nunca se hardcodean montos.
//
// Superficie propia mínima a propósito: solo creamos (a) un Checkout Session la
// primera vez que alguien se suscribe, y (b) un Customer Portal Session para todo
// lo demás (cambiar de plan, actualizar tarjeta, cancelar, ver facturas) — Stripe
// hace esa UI, no nosotros.
// ─────────────────────────────────────────────────────────────────────────────

function secretKey(): string | undefined {
  return process.env.STRIPE_SECRET_KEY?.trim() || undefined;
}
function webhookSecret(): string | undefined {
  return process.env.STRIPE_WEBHOOK_SECRET?.trim() || undefined;
}
function precioBasico(): string | undefined {
  return process.env.STRIPE_PRICE_BASICO?.trim() || undefined;
}
function precioPro(): string | undefined {
  return process.env.STRIPE_PRICE_PRO?.trim() || undefined;
}

/** true si hay lo mínimo para ofrecer facturación (secret, webhook secret y algún precio). */
export function facturacionConfigurada(): boolean {
  return !!(secretKey() && webhookSecret() && (precioBasico() || precioPro()));
}

let cliente: Stripe | null = null;
function obtenerCliente(): Stripe {
  const key = secretKey();
  if (!key) throw new Error("Facturación no está configurada (falta STRIPE_SECRET_KEY).");
  if (!cliente) cliente = new Stripe(key);
  return cliente;
}

/** Price ID configurado para un plan, o undefined si ese plan no tiene precio cargado. */
export function precioDePlan(plan: Plan): string | undefined {
  return plan === "pro" ? precioPro() : precioBasico();
}

/**
 * Plan que corresponde a un Price ID de Stripe (el que trae la suscripción del webhook).
 * Devuelve null ante un price que no coincide con ninguno de los configurados — nunca
 * adivina: el caller no debe tocar el plan del tenant en ese caso (fail-safe).
 */
export function planDePrecio(priceId: string): Plan | null {
  if (priceId === precioPro()) return "pro";
  if (priceId === precioBasico()) return "basico";
  console.error(`[billing] price "${priceId}" no coincide con STRIPE_PRICE_BASICO/STRIPE_PRICE_PRO; no se toca el plan del tenant.`);
  return null;
}

/** http para localhost (dev), https para cualquier otro host (producción, siempre TLS-terminada). */
function baseUrl(host: string): string {
  const esLocal = host.startsWith("localhost") || host.startsWith("127.0.0.1");
  return `${esLocal ? "http" : "https"}://${host}`;
}

/**
 * Crea el Checkout Session de la primera suscripción de un tenant. `host` es el
 * `req.headers.host` del pedido del panel (no hace falta una env de URL pública nueva).
 */
export async function crearCheckoutSession(tenant: Tenant, plan: Plan, host: string): Promise<string> {
  const price = precioDePlan(plan);
  if (!price) throw new Error(`No hay STRIPE_PRICE_${plan.toUpperCase()} configurado.`);
  const base = baseUrl(host);
  const trialDias = Number(process.env.STRIPE_TRIAL_DIAS ?? "0");

  const session = await obtenerCliente().checkout.sessions.create({
    mode: "subscription",
    client_reference_id: tenant.id,
    line_items: [{ price, quantity: 1 }],
    success_url: `${base}/panel?facturacion=ok`,
    cancel_url: `${base}/panel?facturacion=cancelado`,
    // El tenantId viaja en la METADATA DE LA SUSCRIPCIÓN (no solo en la sesión de
    // Checkout): así los webhooks de customer.subscription.* pueden resolver el tenant
    // sin depender de que ya hayamos guardado el stripeCustomerId (evita una carrera si
    // ese evento llega antes que checkout.session.completed).
    subscription_data: {
      metadata: { tenantId: tenant.id },
      ...(trialDias > 0 ? { trial_period_days: trialDias } : {}),
    },
  });
  if (!session.url) throw new Error("Stripe no devolvió una URL de Checkout.");
  return session.url;
}

/** Crea una sesión del Customer Portal (cambiar plan, tarjeta, cancelar, facturas). */
export async function crearPortalSession(tenant: Tenant, host: string): Promise<string> {
  if (!tenant.stripeCustomerId) throw new Error("Este negocio todavía no tiene una suscripción de Stripe.");
  const session = await obtenerCliente().billingPortal.sessions.create({
    customer: tenant.stripeCustomerId,
    return_url: `${baseUrl(host)}/panel?facturacion=ok`,
  });
  return session.url;
}

/**
 * Verifica la firma del webhook y devuelve el evento. Lanza si la firma es inválida o
 * falta la config — el caller (server.ts) responde 400 (mismo rol que firmaValida() del
 * webhook de WhatsApp, pero acá el SDK de Stripe hace la verificación).
 */
export function construirEvento(rawBody: string | Buffer, firma: string): Stripe.Event {
  const secret = webhookSecret();
  if (!secret) throw new Error("Falta STRIPE_WEBHOOK_SECRET.");
  return obtenerCliente().webhooks.constructEvent(rawBody, firma, secret);
}
