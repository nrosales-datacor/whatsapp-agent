import assert from "node:assert/strict";
import { test } from "node:test";
import { billingPauseReason, readStripeConfig, signStripePayload, verifyStripeEvent } from "../../src/modules/billing";
import { billingStatusOf, planFromItems, readInvoice, readSubscription } from "../../src/modules/billing/stripeSync";
import type { Business } from "../../src/modules/business";
import { checkEmailDomain, emailDomainOf } from "../../src/modules/onboarding";

// ─────────────────────────────────────────────────────────────────────────────
// Piezas puras del cobro en línea y del alta (I6): lectura defensiva de los objetos de
// Stripe (forma nueva y vieja de la API), mapeo de estados y precios, configuración,
// decisión del barrido, firma del webhook y el chequeo del dominio del correo.
// ─────────────────────────────────────────────────────────────────────────────

const PRICES = { basic: "price_b", pro: "price_p", extraLocation: "price_l", extraStaff: "price_s" };

test("readSubscription: período en los ítems (API nueva) o en la suscripción (vieja); cliente expandido o id", () => {
  const nueva = readSubscription({
    id: "sub_1",
    customer: { id: "cus_1", object: "customer" },
    status: "active",
    cancel_at_period_end: false,
    metadata: { businessId: "5D0A1C7E-2F4B-4B8E-8F3A-6C1D2E3F4A01" },
    items: { data: [{ price: { id: "price_p" }, quantity: 1, current_period_end: 1_900_000_000 }, { price: "price_l", quantity: 2, current_period_end: 1_900_000_100 }] },
  });
  assert.equal(nueva?.customerId, "cus_1");
  assert.equal(nueva?.businessId, "5d0a1c7e-2f4b-4b8e-8f3a-6c1d2e3f4a01");
  assert.equal(nueva?.currentPeriodEnd?.getTime(), 1_900_000_100_000, "el fin más lejano de los ítems");
  assert.deepEqual(nueva?.items, [{ priceId: "price_p", quantity: 1 }, { priceId: "price_l", quantity: 2 }]);

  const vieja = readSubscription({ id: "sub_2", customer: "cus_2", status: "past_due", current_period_end: 1_800_000_000, items: { data: [{ plan: { id: "price_b" } }] }, metadata: { businessId: "no-es-uuid" } });
  assert.equal(vieja?.currentPeriodEnd?.getTime(), 1_800_000_000_000);
  assert.equal(vieja?.businessId, null, "un id que no es uuid no se usa");
  assert.deepEqual(vieja?.items, [{ priceId: "price_b", quantity: 1 }]);

  const cancelando = readSubscription({ id: "sub_3", customer: "cus_3", status: "active", cancel_at: 1_700_000_000, items: { data: [] } });
  assert.equal(cancelando?.cancelAtPeriodEnd, true, "cancel_at (API nueva) también cuenta como cancelar al final");
  assert.equal(readSubscription({ status: "active" }), null);
});

test("readInvoice: suscripción en parent.subscription_details (nueva) o en invoice.subscription (vieja)", () => {
  assert.deepEqual(readInvoice({ customer: "cus_1", parent: { subscription_details: { subscription: "sub_1", metadata: {} } } }), {
    subscriptionId: "sub_1",
    customerId: "cus_1",
    businessId: null,
  });
  assert.equal(readInvoice({ customer: "cus_1", subscription: { id: "sub_9" } }).subscriptionId, "sub_9");
  assert.equal(readInvoice({ customer: "cus_1" }).subscriptionId, null);
});

test("estados de Stripe → cobro; precios → plan y cupos (un precio desconocido no adivina)", () => {
  assert.equal(billingStatusOf("active"), "active");
  assert.equal(billingStatusOf("trialing"), "trial");
  for (const s of ["past_due", "unpaid", "paused"]) assert.equal(billingStatusOf(s), "past_due");
  assert.equal(billingStatusOf("canceled"), "cancelled");
  assert.equal(billingStatusOf("incomplete"), null);
  assert.equal(billingStatusOf("incomplete_expired"), null);

  assert.deepEqual(planFromItems([{ priceId: "price_p", quantity: 1 }, { priceId: "price_l", quantity: 2 }, { priceId: "price_s", quantity: 3 }], PRICES), {
    plan: "pro",
    extraLocations: 2,
    extraStaff: 3,
  });
  assert.equal(planFromItems([{ priceId: "price_b", quantity: 1 }], PRICES).plan, "basic");
  assert.equal(planFromItems([{ priceId: "price_otro", quantity: 1 }], PRICES).plan, null);
});

test("config: sin clave, sin secreto o sin ningún precio de plan → apagado", () => {
  const full = { STRIPE_SECRET_KEY: "sk_test_x", STRIPE_WEBHOOK_SECRET: "whsec_x", STRIPE_PRICE_PRO: "price_p" };
  assert.ok(readStripeConfig(full));
  assert.equal(readStripeConfig({ ...full, STRIPE_SECRET_KEY: " " }), null);
  assert.equal(readStripeConfig({ ...full, STRIPE_WEBHOOK_SECRET: undefined }), null);
  assert.equal(readStripeConfig({ ...full, STRIPE_PRICE_PRO: undefined }), null);
  assert.equal(readStripeConfig(full)?.prices.basic, null);
});

test("barrido: pausa por atraso con la gracia vencida, prueba vencida sin suscripción o período cancelado cumplido", () => {
  const now = new Date("2026-11-20T12:00:00Z");
  const day = 86_400_000;
  const row = (over: Partial<Business>) => ({ status: "active", billingStatus: "active", pastDueSince: null, trialEndsAt: null, currentPeriodEnd: null, stripeSubscriptionStatus: null, ...over }) as Business;
  const env = { BILLING_PAST_DUE_GRACE_DAYS: "3" };
  assert.equal(billingPauseReason(row({ billingStatus: "past_due", pastDueSince: new Date(now.getTime() - 2 * day) }), now, env), null);
  assert.equal(billingPauseReason(row({ billingStatus: "past_due", pastDueSince: new Date(now.getTime() - 4 * day) }), now, env), "past_due_grace_expired");
  assert.equal(billingPauseReason(row({ billingStatus: "past_due", pastDueSince: null }), now, env), null, "atraso manual: no se pausa solo");
  assert.equal(billingPauseReason(row({ billingStatus: "trial", trialEndsAt: new Date(now.getTime() - 1) }), now, env), "trial_expired");
  assert.equal(billingPauseReason(row({ billingStatus: "trial", trialEndsAt: new Date(now.getTime() - 1), stripeSubscriptionStatus: "trialing" }), now, env), null);
  assert.equal(billingPauseReason(row({ billingStatus: "cancelled", currentPeriodEnd: new Date(now.getTime() - 1) }), now, env), "subscription_ended");
  assert.equal(billingPauseReason(row({ billingStatus: "cancelled", currentPeriodEnd: new Date(now.getTime() + day) }), now, env), null);
  assert.equal(billingPauseReason(row({ status: "paused", billingStatus: "trial", trialEndsAt: new Date(0) }), now, env), null);
});

test("firma del webhook: la del secreto vale; otro secreto, otro cuerpo o vencida, no", () => {
  const payload = JSON.stringify({ id: "evt_1", type: "invoice.paid", created: 1, data: { object: { id: "in_1" } } });
  const event = verifyStripeEvent(Buffer.from(payload), signStripePayload(payload, "whsec_a"), "whsec_a");
  assert.equal(event.id, "evt_1");
  assert.throws(() => verifyStripeEvent(Buffer.from(payload), signStripePayload(payload, "whsec_b"), "whsec_a"));
  assert.throws(() => verifyStripeEvent(Buffer.from(`${payload} `), signStripePayload(payload, "whsec_a"), "whsec_a"));
  const old = Math.floor(Date.now() / 1000) - 3600;
  assert.throws(() => verifyStripeEvent(Buffer.from(payload), signStripePayload(payload, "whsec_a", old), "whsec_a"), "fuera de la tolerancia de 5 min");
});

test("dominio del correo: forma, reservados, descartables, MX, MX implícito (A) y DNS que falla abierto", async () => {
  assert.equal(emailDomainOf("Ana@Clinica.CR"), "clinica.cr");
  for (const bad of ["ana@localhost", "ana@10.0.0.1", "ana@[1.2.3.4]", "ana@-x.com", "sin-arroba"]) assert.equal(emailDomainOf(bad), null, bad);

  const notFound = () => Promise.reject(Object.assign(new Error("nf"), { code: "ENOTFOUND" }));
  const noData = () => Promise.reject(Object.assign(new Error("nd"), { code: "ENODATA" }));
  const check = (email: string, resolver: { resolveMx: (d: string) => Promise<{ exchange: string; priority: number }[]>; resolveAddresses: (d: string) => Promise<string[]> }) =>
    checkEmailDomain(email, { resolver, dnsCheck: true, timeoutMs: 50 });

  assert.deepEqual(await check("a@yopmail.com", { resolveMx: async () => [{ exchange: "mx", priority: 1 }], resolveAddresses: notFound }), { ok: false, problem: "disposable" });
  assert.deepEqual(await check("a@algo.local", { resolveMx: notFound, resolveAddresses: notFound }), { ok: false, problem: "reserved" });
  assert.deepEqual(await check("a@ok.cr", { resolveMx: async () => [{ exchange: "mx.ok.cr", priority: 1 }], resolveAddresses: notFound }), { ok: true });
  assert.deepEqual(await check("a@solo-a.cr", { resolveMx: noData, resolveAddresses: async () => ["1.2.3.4"] }), { ok: true }, "MX implícito");
  assert.deepEqual(await check("a@nada.cr", { resolveMx: notFound, resolveAddresses: notFound }), { ok: false, problem: "no_mail_server" });
  assert.deepEqual(await check("a@lento.cr", { resolveMx: () => new Promise(() => {}), resolveAddresses: notFound }), { ok: true }, "timeout: falla abierto");
  assert.deepEqual(await checkEmailDomain("a@cualquiera.cr", { dnsCheck: false }), { ok: true });
});
