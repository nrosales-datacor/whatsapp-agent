import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { eq } from "drizzle-orm";

// ─────────────────────────────────────────────────────────────────────────────
// Rutas de Stripe del panel (I6.6) por HTTP, con la base como `app_runtime` y un doble de
// la API de Stripe: solo el dueño (admin, recepción y profesional → 403), sin Stripe
// configurado `configured: false` y 503 en checkout/portal, el Checkout sale con el precio
// de la opción y el negocio en la metadata, 409 si ya hay una suscripción viva (se cambia
// desde el Portal) y el Portal solo para quien ya es cliente de Stripe.
// ─────────────────────────────────────────────────────────────────────────────

process.env.TRUST_PROXY = "loopback";
process.env.PANEL_SESSION_SECRET = "test-billing-access-session-secret-0123";
process.env.TOKENS_ENCRYPTION_KEY = "e".repeat(64);
process.env.PANEL_LOGIN_RATE_LIMIT_MAX_IP = "500";
process.env.PUBLIC_BASE_URL = "https://app.example.test";
const STRIPE_ENV = {
  STRIPE_SECRET_KEY: "sk_test_dummy",
  STRIPE_WEBHOOK_SECRET: "whsec_dummy",
  STRIPE_PRICE_BASIC: "price_basic",
  STRIPE_PRICE_PRO: "price_pro",
};

const { createAppHandler } = await import("../../src/app");
const { businesses } = await import("../../src/modules/business/schema");
const { withSystem } = await import("../../src/platform/db/scope");
const { createEphemeralDb } = await import("../helpers/pgliteDb");
const { Browser, startTestServer } = await import("../helpers/panelClient");
const { createTestBusiness, createTestMember } = await import("../helpers/identityFixtures");
type CheckoutInput = import("../../src/modules/billing/stripe").CheckoutInput;
type StripeGateway = import("../../src/modules/billing").StripeGateway;

const base = await createEphemeralDb();
const { db } = base;
let app: Awaited<ReturnType<typeof startTestServer>>;

const checkouts: CheckoutInput[] = [];
const portals: { customerId: string; returnUrl: string }[] = [];
const gateway: StripeGateway = {
  async createCheckoutSession(input) {
    checkouts.push(input);
    return { url: "https://checkout.stripe.test/c/1" };
  },
  async createPortalSession(input) {
    portals.push(input);
    return { url: "https://billing.stripe.test/p/1" };
  },
  async retrieveSubscription() {
    throw new Error("no se usa en estas rutas");
  },
};

before(async () => {
  await base.client.exec("SET ROLE app_runtime");
  app = await startTestServer(createAppHandler({ db, role: "all", stripeGateway: () => gateway }));
});

after(async () => {
  await app?.close();
  await base.close();
});

const API = "/api/panel";

function withStripe<T>(fn: () => Promise<T>): Promise<T> {
  Object.assign(process.env, STRIPE_ENV);
  return fn().finally(() => {
    for (const key of Object.keys(STRIPE_ENV)) delete process.env[key];
  });
}

async function memberOf(businessId: string, role: "owner" | "admin" | "front_desk" | "staff") {
  const member = await createTestMember(db, { businessId, role });
  const b = new Browser(app.baseUrl);
  assert.equal((await b.post(`${API}/auth/login`, { email: member.email, password: member.password })).status, 200);
  return b;
}

test("solo el dueño: admin, recepción y profesional → 403; sin sesión → 401", async () => {
  const biz = await createTestBusiness(db);
  await withStripe(async () => {
    for (const role of ["admin", "front_desk", "staff"] as const) {
      const b = await memberOf(biz.businessId, role);
      assert.equal((await b.get(`${API}/billing/status`)).status, 403, role);
      assert.equal((await b.post(`${API}/billing/checkout`, { option: "pro" })).status, 403, role);
      assert.equal((await b.post(`${API}/billing/portal`)).status, 403, role);
    }
    assert.equal((await new Browser(app.baseUrl).get(`${API}/billing/status`)).status, 401);
  });
  assert.equal(checkouts.length, 0);
});

test("sin Stripe configurado: el estado lo dice y checkout/portal → 503 billing_not_configured", async () => {
  const biz = await createTestBusiness(db);
  const owner = await memberOf(biz.businessId, "owner");
  const status = await owner.get(`${API}/billing/status`);
  assert.equal(status.status, 200);
  assert.equal(status.body.data.configured, false);
  assert.deepEqual(status.body.data.options, []);
  for (const res of [await owner.post(`${API}/billing/checkout`, { option: "pro" }), await owner.post(`${API}/billing/portal`)]) {
    assert.equal(res.status, 503);
    assert.equal(res.body.code, "billing_not_configured");
  }
});

test("checkout: precio de la opción, negocio en la metadata y vuelta a Configuración › Plan; opción sin precio → 400", async () => {
  const biz = await createTestBusiness(db, { plan: "basic" });
  const owner = await memberOf(biz.businessId, "owner");
  await withStripe(async () => {
    const status = await owner.get(`${API}/billing/status`);
    assert.equal(status.body.data.configured, true);
    assert.deepEqual(
      status.body.data.options.map((o: { id: string }) => o.id),
      ["basic", "pro"],
      "Pro sin agente no se ofrece sin su precio",
    );
    assert.equal(status.body.data.subscribed, false);
    assert.equal(status.body.data.canManage, false);

    const res = await owner.post(`${API}/billing/checkout`, { option: "pro" });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.url, "https://checkout.stripe.test/c/1");
    const input = checkouts.at(-1)!;
    assert.equal(input.priceId, "price_pro");
    assert.equal(input.businessId, biz.businessId);
    assert.equal(input.option, "pro");
    assert.equal(input.successUrl, "https://app.example.test/panel/settings/plan?billing=ok");
    assert.equal(input.cancelUrl, "https://app.example.test/panel/settings/plan?billing=cancelled");

    const missing = await owner.post(`${API}/billing/checkout`, { option: "pro_no_agent" });
    assert.equal(missing.status, 400);
    assert.equal(missing.body.code, "option_not_available");
    assert.equal((await owner.post(`${API}/billing/checkout`, { option: "gratis" })).status, 400);
  });
});

test("con suscripción viva: checkout → 409 (se cambia desde el Portal); portal con el cliente de Stripe del negocio", async () => {
  const biz = await createTestBusiness(db);
  const owner = await memberOf(biz.businessId, "owner");
  await withStripe(async () => {
    assert.equal((await owner.post(`${API}/billing/portal`)).body.code, "not_subscribed");
    await withSystem(db, (tx) =>
      tx.update(businesses).set({ stripeCustomerId: "cus_123", stripeSubscriptionId: "sub_123", billingStatus: "active" }).where(eq(businesses.id, biz.businessId)),
    );
    const status = await owner.get(`${API}/billing/status`);
    assert.equal(status.body.data.subscribed, true);
    assert.equal(status.body.data.canManage, true);
    const again = await owner.post(`${API}/billing/checkout`, { option: "basic" });
    assert.equal(again.status, 409);
    assert.equal(again.body.code, "already_subscribed");
    const portal = await owner.post(`${API}/billing/portal`);
    assert.equal(portal.status, 200);
    assert.equal(portal.body.data.url, "https://billing.stripe.test/p/1");
    assert.deepEqual(portals.at(-1), { customerId: "cus_123", returnUrl: "https://app.example.test/panel/settings/plan" });
  });
});

test("el plan de `me` trae el fin de la prueba", async () => {
  const biz = await createTestBusiness(db);
  const ends = new Date(Date.now() + 3 * 86_400_000);
  await withSystem(db, (tx) => tx.update(businesses).set({ billingStatus: "trial", trialEndsAt: ends }).where(eq(businesses.id, biz.businessId)));
  const owner = await memberOf(biz.businessId, "owner");
  const me = await owner.get(`${API}/auth/me`);
  assert.equal(me.body.data.plan.trialEndsAt, ends.toISOString());
  assert.equal(me.body.data.plan.billingStatus, "trial");
});
