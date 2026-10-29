import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { and, desc, eq } from "drizzle-orm";

// ─────────────────────────────────────────────────────────────────────────────
// Pausa por falta de pago (I6) por HTTP contra la app real, con la base como `app_runtime`
// y un doble de la API de Stripe: el reloj de la gracia (Stripe, prueba vencida, cancelación;
// no el cobro manual), el barrido que pausa al cumplirse, el ingreso de la dueña solo para
// pagar (las rutas del cobro con el negocio pausado), la reactivación al pagar y lo que hace
// el superadmin (pausar a mano, reactivar reinicia la gracia).
// ─────────────────────────────────────────────────────────────────────────────

process.env.TRUST_PROXY = "loopback";
process.env.PANEL_SESSION_SECRET = "test-billing-pause-session-secret-0123";
process.env.TOKENS_ENCRYPTION_KEY = "e".repeat(64);
process.env.PANEL_LOGIN_RATE_LIMIT_MAX_IP = "500";
const WEBHOOK_SECRET = "whsec_test_pause_0123456789";
process.env.STRIPE_SECRET_KEY = "sk_test_dummy";
process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;
process.env.STRIPE_PRICE_BASIC = "price_basic";
process.env.STRIPE_PRICE_PRO = "price_pro";
delete process.env.BILLING_GRACE_DAYS;

const { createAppHandler } = await import("../../src/app");
const billing = await import("../../src/modules/billing");
const { businesses } = await import("../../src/modules/business/schema");
const { invalidateBusinessContext } = await import("../../src/modules/business");
const { auditLog } = await import("../../src/platform/db/schema");
const { withSystem } = await import("../../src/platform/db/scope");
const { createEphemeralDb } = await import("../helpers/pgliteDb");
const { Browser, startTestServer } = await import("../helpers/panelClient");
const { createTestBusiness, createTestMember } = await import("../helpers/identityFixtures");
type SubscriptionSnapshot = import("../../src/modules/billing").SubscriptionSnapshot;
type StripeGateway = import("../../src/modules/billing").StripeGateway;

const API = "/api/panel";
const DAY = 24 * 60 * 60 * 1000;

const base = await createEphemeralDb();
const { db } = base;
let app: Awaited<ReturnType<typeof startTestServer>>;

const subscriptions = new Map<string, SubscriptionSnapshot>();
const gateway: StripeGateway = {
  async createCheckoutSession() {
    return { url: "https://checkout.stripe.test/s" };
  },
  async createPortalSession() {
    return { url: "https://billing.stripe.test/p" };
  },
  async retrieveSubscription(id) {
    const sub = subscriptions.get(id);
    if (!sub) throw new Error(`no existe la suscripción ${id}`);
    return sub;
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

let seq = 0;
const nextId = (prefix: string) => `${prefix}_${Date.now()}_${++seq}`;

/** Manda un evento de Stripe firmado. */
async function send(type: string, object: Record<string, unknown>) {
  const body = JSON.stringify({ id: nextId("evt"), object: "event", type, data: { object } });
  const res = await fetch(`${app.baseUrl}/webhook/stripe`, {
    method: "POST",
    headers: { "content-type": "application/json", "stripe-signature": billing.signStripePayload(body, WEBHOOK_SECRET) },
    body,
  });
  assert.equal(res.status, 200, await res.text());
}

/** Deja la suscripción de Stripe en `status` y avisa por el webhook. */
async function stripeSays(sub: SubscriptionSnapshot, status: string) {
  sub.status = status;
  subscriptions.set(sub.id, sub);
  await send("customer.subscription.updated", { id: sub.id, customer: sub.customerId });
}

async function subscribed(businessId: string): Promise<SubscriptionSnapshot> {
  const sub: SubscriptionSnapshot = { id: nextId("sub"), customerId: nextId("cus"), status: "active", priceId: "price_pro", trialEnd: null, metadata: { businessId } };
  subscriptions.set(sub.id, sub);
  await send("customer.subscription.created", { id: sub.id, customer: sub.customerId, metadata: { businessId } });
  return sub;
}

async function rowOf(businessId: string) {
  const [row] = await withSystem(db, (tx) => tx.select().from(businesses).where(eq(businesses.id, businessId)));
  return row;
}

async function auditOf(businessId: string, action: string) {
  return withSystem(db, (tx) =>
    tx.select().from(auditLog).where(and(eq(auditLog.businessId, businessId), eq(auditLog.action, action))).orderBy(desc(auditLog.createdAt)),
  );
}

async function loginAs(email: string, password: string) {
  const b = new Browser(app.baseUrl);
  const res = await b.post(`${API}/auth/login`, { email, password });
  return { b, res };
}

async function ownerOf(businessId: string) {
  const owner = await createTestMember(db, { businessId, role: "owner" });
  return { ...owner, password: owner.password! };
}

test("graceDays: default 7, BILLING_GRACE_DAYS entero ≥ 0, inválido → default", () => {
  assert.equal(billing.graceDays({}), 7);
  assert.equal(billing.graceDays({ BILLING_GRACE_DAYS: "3" }), 3);
  assert.equal(billing.graceDays({ BILLING_GRACE_DAYS: "0" }), 0);
  assert.equal(billing.graceDays({ BILLING_GRACE_DAYS: "-1" }), 7);
  assert.equal(billing.graceDays({ BILLING_GRACE_DAYS: "2.5" }), 7);
  assert.equal(billing.graceDays({ BILLING_GRACE_DAYS: "x" }), 7);
});

test("Stripe no cobra: corre la gracia (me.plan.pausesAt), el barrido pausa al cumplirse y la dueña entra solo a pagar", async () => {
  const biz = await createTestBusiness(db, { plan: "pro" });
  const owner = await ownerOf(biz.businessId);
  const sub = await subscribed(biz.businessId);
  const { b } = await loginAs(owner.email, owner.password);

  await stripeSays(sub, "past_due");
  let row = await rowOf(biz.businessId);
  assert.equal(row.billingStatus, "past_due");
  assert.ok(row.unpaidSince, "arranca el reloj");
  const firstUnpaid = row.unpaidSince!;
  const me = await b.get(`${API}/auth/me`);
  assert.equal(me.status, 200, "durante la gracia el panel anda");
  assert.equal(me.body.data.plan.pausesAt, new Date(firstUnpaid.getTime() + 7 * DAY).toISOString());

  // Un evento repetido de pago pendiente no reinicia el reloj.
  await stripeSays(sub, "unpaid");
  assert.equal((await rowOf(biz.businessId)).unpaidSince?.getTime(), firstUnpaid.getTime());

  // Antes de la gracia: nada. Cumplida: pausa por el cobro, con su rastro.
  assert.equal(await billing.pauseUnpaidBusinesses(db, { now: new Date(firstUnpaid.getTime() + 6 * DAY) }), 0);
  assert.equal((await rowOf(biz.businessId)).status, "active");
  assert.equal(await billing.pauseUnpaidBusinesses(db, { now: new Date(firstUnpaid.getTime() + 7 * DAY + 1000) }), 1);
  row = await rowOf(biz.businessId);
  assert.equal(row.status, "paused");
  assert.ok(row.billingPausedAt);
  const [audit] = await auditOf(biz.businessId, "business_paused");
  assert.equal(audit.actor, billing.BILLING_SWEEP_ACTOR);
  assert.equal((audit.details as { reason: string }).reason, "grace_expired");

  // La sesión abierta: el panel responde pausado, pero las rutas del cobro andan.
  assert.equal((await b.get(`${API}/auth/me`)).body.code, "business_paused");
  assert.equal((await b.get(`${API}/clients`)).status, 403);
  const status = await b.get(`${API}/billing/status`);
  assert.equal(status.status, 200, JSON.stringify(status.body));
  assert.equal(status.body.data.pausedForBilling, true);
  assert.equal(status.body.data.subscribed, true);
  assert.equal(status.body.data.pausesAt, null, "ya pausado: no hay fecha de pausa");
  assert.equal((await b.post(`${API}/billing/portal`)).body.data.url, "https://billing.stripe.test/p");
  assert.equal((await b.post(`${API}/billing/checkout`, { option: "pro" })).body.code, "already_subscribed", "con la suscripción viva, se paga desde el portal");

  // Un ingreso nuevo de la dueña: 403 pausado, pero con la sesión para pagar.
  const fresh = await loginAs(owner.email, owner.password);
  assert.equal(fresh.res.status, 403);
  assert.equal(fresh.res.body.code, "business_paused");
  assert.equal((await fresh.b.get(`${API}/billing/status`)).body.data.pausedForBilling, true);
  assert.equal((await fresh.b.get(`${API}/auth/me`)).body.code, "business_paused");

  // Otro rol del equipo: pausado y sin sesión.
  const admin = await createTestMember(db, { businessId: biz.businessId, role: "admin" });
  const adminLogin = await loginAs(admin.email, admin.password!);
  assert.equal(adminLogin.res.body.code, "business_paused");
  assert.equal(adminLogin.b.cookies.size, 0);
});

test("al pagar se reactiva solo: estado, reloj borrado y rastro de Stripe", async () => {
  const biz = await createTestBusiness(db, { plan: "pro" });
  const owner = await ownerOf(biz.businessId);
  const sub = await subscribed(biz.businessId);
  await stripeSays(sub, "past_due");
  await billing.pauseUnpaidBusinesses(db, { now: new Date(Date.now() + 8 * DAY) });
  assert.equal((await rowOf(biz.businessId)).status, "paused");

  await stripeSays(sub, "active");
  const row = await rowOf(biz.businessId);
  assert.equal(row.status, "active");
  assert.equal(row.billingStatus, "active");
  assert.equal(row.billingPausedAt, null);
  assert.equal(row.unpaidSince, null);
  const [audit] = await auditOf(biz.businessId, "business_reactivated");
  assert.equal(audit.actor, "system:stripe");

  const { b, res } = await loginAs(owner.email, owner.password);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal((await b.get(`${API}/clients`)).status, 200);
  assert.equal((await b.get(`${API}/auth/me`)).body.data.plan.pausesAt, null);
});

test("cancelada: el reloj sigue desde el primer cobro fallido; sin suscripción se paga con un Checkout nuevo", async () => {
  const biz = await createTestBusiness(db, { plan: "pro" });
  const owner = await ownerOf(biz.businessId);
  const sub = await subscribed(biz.businessId);
  await stripeSays(sub, "past_due");
  const since = (await rowOf(biz.businessId)).unpaidSince!;
  await stripeSays(sub, "canceled");
  let row = await rowOf(biz.businessId);
  assert.equal(row.billingStatus, "cancelled");
  assert.equal(row.unpaidSince?.getTime(), since.getTime(), "cancelar no reinicia la gracia");

  await billing.pauseUnpaidBusinesses(db, { now: new Date(since.getTime() + 8 * DAY) });
  row = await rowOf(biz.businessId);
  assert.equal(row.status, "paused");
  const { b } = await loginAs(owner.email, owner.password);
  const status = await b.get(`${API}/billing/status`);
  assert.equal(status.body.data.subscribed, false);
  assert.equal((await b.post(`${API}/billing/checkout`, { option: "pro" })).body.data.url, "https://checkout.stripe.test/s");
});

test("prueba vencida sin suscribirse: pasa a pago pendiente con la gracia y después se pausa", async () => {
  const biz = await createTestBusiness(db, { plan: "basic" });
  const owner = await ownerOf(biz.businessId);
  const ended = new Date(Date.now() - DAY);
  await withSystem(db, (tx) => tx.update(businesses).set({ billingStatus: "trial", trialEndsAt: ended }).where(eq(businesses.id, biz.businessId)));
  invalidateBusinessContext(biz.businessId);

  const now = new Date();
  assert.ok((await billing.expireTrials(db, now)) >= 1);
  let row = await rowOf(biz.businessId);
  assert.equal(row.billingStatus, "past_due");
  assert.equal(row.unpaidSince?.getTime(), now.getTime());

  await billing.pauseUnpaidBusinesses(db, { now: new Date(now.getTime() + 7 * DAY + 1) });
  row = await rowOf(biz.businessId);
  assert.equal(row.status, "paused");
  const { b } = await loginAs(owner.email, owner.password);
  assert.equal((await b.post(`${API}/billing/checkout`, { option: "basic" })).status, 200);
});

test("cobro manual: el estado que carga el superadmin no arranca la gracia; pasarlo a al día la corta", async () => {
  const manual = await createTestBusiness(db, { plan: "pro" });
  await billing.changeBusinessPlan(db, manual.businessId, { billingStatus: "past_due" }, "admin:test");
  assert.equal((await rowOf(manual.businessId)).unpaidSince, null);
  await billing.pauseUnpaidBusinesses(db, { now: new Date(Date.now() + 30 * DAY) });
  assert.equal((await rowOf(manual.businessId)).status, "active", "nadie lo pausa solo");

  const viaStripe = await createTestBusiness(db, { plan: "pro" });
  const sub = await subscribed(viaStripe.businessId);
  await stripeSays(sub, "past_due");
  assert.ok((await rowOf(viaStripe.businessId)).unpaidSince);
  await billing.changeBusinessPlan(db, viaStripe.businessId, { billingStatus: "active" }, "admin:test");
  assert.equal((await rowOf(viaStripe.businessId)).unpaidSince, null);
});

test("pausa del superadmin: la dueña no entra ni a pagar; reactivar a mano reinicia la gracia", async () => {
  const biz = await createTestBusiness(db, { plan: "pro" });
  const owner = await ownerOf(biz.businessId);
  const { b } = await loginAs(owner.email, owner.password);
  await billing.pauseBusiness(db, biz.businessId, "prueba", "admin:test");

  const login = await loginAs(owner.email, owner.password);
  assert.equal(login.res.body.code, "business_paused");
  assert.equal(login.b.cookies.size, 0, "sin sesión: no es una pausa por el cobro");
  const status = await b.get(`${API}/billing/status`);
  assert.equal(status.status, 200);
  assert.equal(status.body.data.pausedForBilling, false);
  assert.equal((await b.post(`${API}/billing/checkout`, { option: "pro" })).body.code, "business_paused");
  assert.equal((await b.post(`${API}/billing/portal`)).body.code, "business_paused");

  // Pausado por el cobro y reactivado a mano sin pagar: la gracia vuelve a empezar.
  const other = await createTestBusiness(db, { plan: "pro" });
  const sub = await subscribed(other.businessId);
  await stripeSays(sub, "past_due");
  await billing.pauseUnpaidBusinesses(db, { now: new Date(Date.now() + 8 * DAY) });
  assert.equal((await rowOf(other.businessId)).status, "paused");
  const before = Date.now();
  await billing.reactivateBusiness(db, other.businessId, "admin:test");
  const row = await rowOf(other.businessId);
  assert.equal(row.status, "active");
  assert.equal(row.billingPausedAt, null);
  assert.ok(row.unpaidSince && row.unpaidSince.getTime() >= before, "la gracia arranca de nuevo");
  assert.equal(await billing.pauseUnpaidBusinesses(db, { now: new Date(Date.now() + DAY) }), 0);
});

test("superadmin: el detalle dice si está pausado por el cobro y cuándo se pausa", async () => {
  const biz = await createTestBusiness(db, { plan: "pro" });
  const sub = await subscribed(biz.businessId);
  await stripeSays(sub, "past_due");
  const plans = billing.createPlanService(db);
  let detail = await billing.getAdminBusinessDetail(db, plans, biz.businessId);
  assert.equal(detail.pausedForBilling, false);
  assert.ok(detail.pausesAt);
  await billing.pauseUnpaidBusinesses(db, { now: new Date(Date.now() + 8 * DAY) });
  detail = await billing.getAdminBusinessDetail(db, plans, biz.businessId);
  assert.equal(detail.pausedForBilling, true);
  assert.equal(detail.pausesAt, null);
});
