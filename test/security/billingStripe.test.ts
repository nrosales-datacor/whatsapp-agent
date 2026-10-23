import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { and, desc, eq } from "drizzle-orm";

// ─────────────────────────────────────────────────────────────────────────────
// Cobro en línea con Stripe (I6) por HTTP, con Stripe SIEMPRE simulado: el gateway de
// Checkout/Portal es un doble que anota las llamadas, y los webhooks se firman con un
// secreto de prueba (la verificación de la firma es la real del SDK, sin red).
//
//   • Checkout y Portal: solo el dueño, sin config → 503, ya suscripto → 409, sin cliente → 409.
//   • Webhook: firma inválida, sin config, idempotencia por id, alta/cambio/cancelación de
//     la suscripción, evento viejo que llega tarde, negocio desconocido.
//   • past_due → gracia → pausa (barrido) → pagar reactiva; la pausa del superadmin no.
//   • Pausa por el cobro: la dueña entra solo a pagar (allowWhenPaused).
//   • Prueba vencida → pausa (salvo una suscripción viva de Stripe).
// Base como `app_runtime`.
// ─────────────────────────────────────────────────────────────────────────────

process.env.TRUST_PROXY = "loopback";
process.env.PANEL_SESSION_SECRET = "test-billing-stripe-secret-0123456789abcd";
process.env.TOKENS_ENCRYPTION_KEY = "e".repeat(64);
process.env.PANEL_LOGIN_RATE_LIMIT_MAX_IP = "500";
process.env.PUBLIC_BASE_URL = "https://app.example.test";
process.env.PANEL_SUPERADMIN_USERNAME = "root";
delete process.env.PANEL_SUPERADMIN_TOTP_SECRET;
delete process.env.BILLING_PAST_DUE_GRACE_DAYS;

const WEBHOOK_SECRET = "whsec_prueba_0123456789";
const STRIPE_ENV = {
  STRIPE_SECRET_KEY: "sk_test_prueba",
  STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
  STRIPE_PRICE_BASIC: "price_basic",
  STRIPE_PRICE_PRO: "price_pro",
  STRIPE_PRICE_EXTRA_LOCATION: "price_extra_location",
  STRIPE_PRICE_EXTRA_STAFF: "price_extra_staff",
};
// me.plan y el detalle del superadmin leen el entorno del proceso.
Object.assign(process.env, STRIPE_ENV);

const ADMIN_PASSWORD = "clave-del-superadmin-3";
const { hashPassword } = await import("../../src/platform/auth/password");
process.env.PANEL_SUPERADMIN_HASH = await hashPassword(ADMIN_PASSWORD);

const { createAppHandler } = await import("../../src/app");
const { signStripePayload, sweepBilling } = await import("../../src/modules/billing");
const { businesses, invalidateBusinessContextForTests } = await (async () => {
  const schema = await import("../../src/modules/business/schema");
  const business = await import("../../src/modules/business");
  return { businesses: schema.businesses, invalidateBusinessContextForTests: business.invalidateBusinessContext };
})();
const { stripeEvents } = await import("../../src/modules/billing/schema");
const { auditLog } = await import("../../src/platform/db/schema");
const { withSystem } = await import("../../src/platform/db/scope");
const { createEphemeralDb } = await import("../helpers/pgliteDb");
const { Browser, startTestServer } = await import("../helpers/panelClient");
const { createTestBusiness, createTestMember } = await import("../helpers/identityFixtures");

type TestServer = Awaited<ReturnType<typeof startTestServer>>;
type CheckoutCall = Parameters<import("../../src/modules/billing").StripeGateway["createCheckoutSession"]>[0];

const checkoutCalls: CheckoutCall[] = [];
const portalCalls: { customerId: string; returnUrl: string }[] = [];
const gateway = {
  async createCheckoutSession(input: CheckoutCall) {
    checkoutCalls.push(input);
    return { id: `cs_test_${checkoutCalls.length}`, url: `https://checkout.stripe.test/c/${checkoutCalls.length}` };
  },
  async createPortalSession(input: { customerId: string; returnUrl: string }) {
    portalCalls.push(input);
    return { url: `https://billing.stripe.test/p/${portalCalls.length}` };
  },
};

const base = await createEphemeralDb();
const { db } = base;
let app: TestServer;
let unconfigured: TestServer;

before(async () => {
  await base.client.exec("SET ROLE app_runtime");
  app = await startTestServer(createAppHandler({ db, role: "all", billing: { env: STRIPE_ENV, gateway: () => gateway } }));
  unconfigured = await startTestServer(createAppHandler({ db, role: "all", billing: { env: {}, gateway: () => gateway } }));
});

after(async () => {
  await app?.close();
  await unconfigured?.close();
  await base.close();
});

const API = "/api/panel";
const DAY = 86_400_000;
const secs = (d: Date) => Math.floor(d.getTime() / 1000);

async function loginAs(server: TestServer, email: string, password: string) {
  const b = new Browser(server.baseUrl);
  const res = await b.post(`${API}/auth/login`, { email, password });
  return { browser: b, res };
}

async function ownerOf(businessId: string, server: TestServer = app) {
  const member = await createTestMember(db, { businessId, role: "owner" });
  const { browser, res } = await loginAs(server, member.email, member.password!);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return { browser, member };
}

async function rowOf(businessId: string) {
  const [row] = await withSystem(db, (tx) => tx.select().from(businesses).where(eq(businesses.id, businessId)));
  return row;
}

async function setRow(businessId: string, values: Partial<typeof businesses.$inferInsert>) {
  await withSystem(db, (tx) => tx.update(businesses).set(values).where(eq(businesses.id, businessId)));
  invalidateBusinessContextForTests(businessId);
}

async function auditOf(businessId: string, action: string) {
  return withSystem(db, (tx) =>
    tx
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.businessId, businessId), eq(auditLog.action, action)))
      .orderBy(desc(auditLog.createdAt)),
  );
}

// ── Eventos de Stripe de ejemplo (forma de la API 2025+: período en los ítems) ──

function stripeEvent(type: string, object: Record<string, unknown>, created = new Date()) {
  return { id: `evt_${randomUUID().replace(/-/g, "")}`, object: "event", api_version: "2026-05-27.dahlia", type, created: secs(created), data: { object } };
}

function subscription(input: {
  id: string;
  customer: string;
  status: string;
  businessId?: string;
  items: { price: string; quantity?: number }[];
  periodEnd?: Date;
  cancelAtPeriodEnd?: boolean;
}) {
  const periodEnd = secs(input.periodEnd ?? new Date(Date.now() + 30 * DAY));
  return {
    id: input.id,
    object: "subscription",
    customer: input.customer,
    status: input.status,
    cancel_at_period_end: input.cancelAtPeriodEnd ?? false,
    cancel_at: input.cancelAtPeriodEnd ? periodEnd : null,
    ended_at: input.status === "canceled" ? secs(new Date()) : null,
    metadata: input.businessId ? { businessId: input.businessId } : {},
    items: {
      object: "list",
      data: input.items.map((i, n) => ({ id: `si_${n}`, object: "subscription_item", price: { id: i.price, object: "price" }, quantity: i.quantity ?? 1, current_period_end: periodEnd })),
    },
  };
}

function invoice(input: { subscription: string; customer: string; businessId?: string }) {
  return {
    id: `in_${randomUUID().slice(0, 8)}`,
    object: "invoice",
    customer: input.customer,
    parent: { type: "subscription_details", subscription_details: { subscription: input.subscription, metadata: input.businessId ? { businessId: input.businessId } : {} } },
  };
}

async function sendWebhook(event: object, options: { server?: TestServer; signature?: string | null } = {}) {
  const payload = JSON.stringify(event);
  const headers: Record<string, string> = { "content-type": "application/json" };
  const signature = options.signature === undefined ? signStripePayload(payload, WEBHOOK_SECRET) : options.signature;
  if (signature !== null) headers["stripe-signature"] = signature;
  const res = await fetch(`${(options.server ?? app).baseUrl}/webhook/stripe`, { method: "POST", headers, body: payload });
  return { status: res.status, body: (await res.json()) as { ok: boolean; data?: { outcome: string }; code?: string } };
}

// ── Checkout y Portal ───────────────────────────────────────────────────────

test("checkout: la dueña recibe la URL de Stripe; en prueba, Stripe no cobra hasta que termine; los demás roles no", async () => {
  const biz = await createTestBusiness(db, { plan: "basic", locations: ["Central"] });
  const trialEnd = new Date(Date.now() + 10 * DAY);
  await setRow(biz.businessId, { billingStatus: "trial", trialEndsAt: trialEnd });
  const { browser: owner, member } = await ownerOf(biz.businessId);

  const res = await owner.post(`${API}/billing/checkout`, { plan: "basic" });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.match(res.body.data.url, /^https:\/\/checkout\.stripe\.test\//);
  const call = checkoutCalls.at(-1)!;
  assert.equal(call.businessId, biz.businessId);
  assert.deepEqual(call.lineItems, [{ price: "price_basic", quantity: 1 }]);
  assert.equal(call.customerId, null);
  assert.equal(call.customerEmail, member.email, "Checkout crea el cliente con el correo de la dueña");
  assert.equal(call.trialEnd?.toISOString(), trialEnd.toISOString());
  assert.equal(call.successUrl, "https://app.example.test/panel/settings/plan?checkout=success");
  assert.equal(call.cancelUrl, "https://app.example.test/panel/settings/plan?checkout=cancelled");

  const admin = await createTestMember(db, { businessId: biz.businessId, role: "admin" });
  const { browser: adminBrowser } = await loginAs(app, admin.email, admin.password!);
  for (const [method, path] of [["POST", "/billing/checkout"], ["POST", "/billing/portal"], ["GET", "/billing/status"]] as const) {
    const r = await adminBrowser.request(method, `${API}${path}`, method === "POST" ? { plan: "basic" } : undefined);
    assert.equal(r.status, 403, path);
    assert.equal(r.body.code, "forbidden_role", path);
    assert.equal((await new Browser(app.baseUrl).request(method, `${API}${path}`, method === "POST" ? { plan: "basic" } : undefined)).status, 401);
  }
  assert.equal((await owner.post(`${API}/billing/checkout`, { plan: "enterprise" })).status, 400);
});

test("checkout del Pro con cupos extra; una suscripción viva → 409 (se gestiona desde el Portal)", async () => {
  const biz = await createTestBusiness(db, { plan: "basic", locations: ["Central"] });
  const { browser: owner } = await ownerOf(biz.businessId);
  const res = await owner.post(`${API}/billing/checkout`, { plan: "pro", extraLocations: 2, extraStaff: 3 });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(checkoutCalls.at(-1)!.lineItems, [
    { price: "price_pro", quantity: 1 },
    { price: "price_extra_location", quantity: 2 },
    { price: "price_extra_staff", quantity: 3 },
  ]);
  assert.equal(checkoutCalls.at(-1)!.trialEnd, null, "sin prueba con vencimiento, cobra ya");

  await setRow(biz.businessId, { stripeCustomerId: `cus_${randomUUID().slice(0, 8)}`, stripeSubscriptionId: `sub_${randomUUID().slice(0, 8)}`, stripeSubscriptionStatus: "active" });
  const again = await owner.post(`${API}/billing/checkout`, { plan: "pro" });
  assert.equal(again.status, 409);
  assert.equal(again.body.code, "already_subscribed");
});

test("portal: sin cliente de Stripe → 409; con cliente → URL del Customer Portal", async () => {
  const biz = await createTestBusiness(db, { plan: "basic", locations: ["Central"] });
  const { browser: owner } = await ownerOf(biz.businessId);
  const none = await owner.post(`${API}/billing/portal`);
  assert.equal(none.status, 409);
  assert.equal(none.body.code, "no_billing_account");

  const customer = `cus_${randomUUID().slice(0, 8)}`;
  await setRow(biz.businessId, { stripeCustomerId: customer });
  const res = await owner.post(`${API}/billing/portal`);
  assert.equal(res.status, 200);
  assert.match(res.body.data.url, /^https:\/\/billing\.stripe\.test\//);
  assert.deepEqual(portalCalls.at(-1), { customerId: customer, returnUrl: "https://app.example.test/panel/settings/plan" });

  const status = (await owner.get(`${API}/billing/status`)).body.data;
  assert.equal(status.onlinePayments, true);
  assert.equal(status.canManage, true);
  assert.deepEqual(status.extras, { locations: true, staff: true });
  assert.deepEqual(status.plans.map((p: { available: boolean }) => p.available), [true, true]);
});

test("sin Stripe configurado: checkout, portal y webhook responden 503 billing_not_configured; el estado lo dice", async () => {
  const biz = await createTestBusiness(db, { plan: "basic", locations: ["Central"] });
  const { browser: owner } = await ownerOf(biz.businessId, unconfigured);
  const before = checkoutCalls.length;
  for (const path of ["/billing/checkout", "/billing/portal"]) {
    const res = await owner.post(`${API}${path}`, path.endsWith("checkout") ? { plan: "basic" } : undefined);
    assert.equal(res.status, 503, path);
    assert.equal(res.body.code, "billing_not_configured", path);
    assert.match(res.body.error, /Escribinos/);
  }
  assert.equal(checkoutCalls.length, before, "no se llamó a Stripe");
  assert.equal((await owner.get(`${API}/billing/status`)).body.data.onlinePayments, false);
  const hook = await sendWebhook(stripeEvent("invoice.paid", invoice({ subscription: "sub_x", customer: "cus_x" })), { server: unconfigured });
  assert.equal(hook.status, 503);
  assert.equal(hook.body.code, "billing_not_configured");
});

// ── Webhook ─────────────────────────────────────────────────────────────────

test("webhook: sin firma o con firma inválida → 400 y no se registra nada; un GET → 405", async () => {
  const event = stripeEvent("invoice.paid", invoice({ subscription: "sub_y", customer: "cus_y" }));
  for (const signature of [null, "t=1,v1=deadbeef", signStripePayload("{}", WEBHOOK_SECRET), signStripePayload(JSON.stringify(event), "whsec_otro")]) {
    const res = await sendWebhook(event, { signature });
    assert.equal(res.status, 400, String(signature));
    assert.equal(res.body.code, "invalid_signature");
  }
  const rows = await withSystem(db, (tx) => tx.select().from(stripeEvents).where(eq(stripeEvents.id, event.id)));
  assert.equal(rows.length, 0);
  assert.equal((await fetch(`${app.baseUrl}/webhook/stripe`)).status, 405);
});

test("webhook: Checkout + suscripción Pro con cupos → plan, cobro, período y cupos; el mismo evento dos veces se aplica una", async () => {
  const biz = await createTestBusiness(db, { plan: "basic", locations: ["Central"] });
  await setRow(biz.businessId, { billingStatus: "trial", trialEndsAt: new Date(Date.now() + 5 * DAY) });
  const { browser: owner } = await ownerOf(biz.businessId);
  const customer = `cus_${randomUUID().slice(0, 8)}`;
  const sub = `sub_${randomUUID().slice(0, 8)}`;

  const completed = stripeEvent("checkout.session.completed", {
    id: "cs_test_1",
    object: "checkout.session",
    mode: "subscription",
    client_reference_id: biz.businessId,
    customer,
    subscription: sub,
  });
  assert.equal((await sendWebhook(completed)).body.data?.outcome, "applied");
  let row = await rowOf(biz.businessId);
  assert.equal(row.stripeCustomerId, customer);
  assert.equal(row.stripeSubscriptionId, sub);

  const periodEnd = new Date(Date.now() + 30 * DAY);
  const created = stripeEvent(
    "customer.subscription.created",
    subscription({ id: sub, customer, status: "active", businessId: biz.businessId, periodEnd, items: [{ price: "price_pro" }, { price: "price_extra_location", quantity: 2 }, { price: "price_extra_staff", quantity: 4 }] }),
  );
  const first = await sendWebhook(created);
  assert.equal(first.status, 200);
  assert.equal(first.body.data?.outcome, "applied");
  row = await rowOf(biz.businessId);
  assert.equal(row.plan, "pro");
  assert.equal(row.billingStatus, "active");
  assert.equal(row.stripeSubscriptionStatus, "active");
  assert.equal(Math.round(row.currentPeriodEnd!.getTime() / 1000), secs(periodEnd));
  assert.deepEqual(row.extraModules, { limits: { locations: 3, staff: 9 } }, "base del Pro + cupos extra");

  const duplicate = await sendWebhook(created);
  assert.equal(duplicate.status, 200);
  assert.equal(duplicate.body.data?.outcome, "duplicate");
  const changes = await auditOf(biz.businessId, "plan_changed");
  assert.equal(changes.length, 1, "un solo cambio auditado");
  assert.equal(changes[0].actor, "system:stripe");

  const me = (await owner.get(`${API}/auth/me`)).body.data;
  assert.equal(me.plan.id, "pro");
  assert.equal(me.plan.limits.locations, 3);
  assert.equal(me.plan.billing.hasSubscription, true);
  assert.equal(me.plan.billing.canManage, true);
});

test("webhook: bajar de plan y cancelar al final del período; al terminar → cancelled y pausa por el cobro; la dueña entra solo a pagar", async () => {
  const biz = await createTestBusiness(db, { plan: "pro", locations: ["Central"] });
  const { browser: owner, member } = await ownerOf(biz.businessId);
  const customer = `cus_${randomUUID().slice(0, 8)}`;
  const sub = `sub_${randomUUID().slice(0, 8)}`;
  await setRow(biz.businessId, { stripeCustomerId: customer, stripeSubscriptionId: sub, stripeSubscriptionStatus: "active", billingStatus: "active", extraModules: { limits: { locations: 3 } } });

  const end = new Date(Date.now() + 12 * DAY);
  await sendWebhook(stripeEvent("customer.subscription.updated", subscription({ id: sub, customer, status: "active", items: [{ price: "price_basic" }], periodEnd: end, cancelAtPeriodEnd: true })));
  let row = await rowOf(biz.businessId);
  assert.equal(row.plan, "basic");
  assert.deepEqual(row.extraModules, {}, "los cupos extra del Pro se van con el Pro");
  assert.equal(row.cancelAtPeriodEnd, true);
  assert.equal(row.billingStatus, "active", "sigue activo hasta el final del período");
  const status = (await owner.get(`${API}/billing/status`)).body.data;
  assert.equal(status.cancelAtPeriodEnd, true);
  assert.equal(status.currentPeriodEnd, new Date(secs(end) * 1000).toISOString());

  await sendWebhook(stripeEvent("customer.subscription.deleted", subscription({ id: sub, customer, status: "canceled", items: [{ price: "price_basic" }], periodEnd: end })));
  row = await rowOf(biz.businessId);
  assert.equal(row.billingStatus, "cancelled");
  assert.equal(row.status, "paused");
  assert.ok(row.billingPausedAt, "pausa POR EL COBRO");
  const [paused] = await auditOf(biz.businessId, "business_paused");
  assert.equal(paused.actor, "system:stripe");

  // La sesión abierta: el resto de la API → 403; las rutas de pago, no.
  assert.equal((await owner.get(`${API}/auth/me`)).body.code, "business_paused");
  assert.equal((await owner.get(`${API}/settings/locations`)).body.code, "business_paused");
  const paidStatus = await owner.get(`${API}/billing/status`);
  assert.equal(paidStatus.status, 200);
  assert.equal(paidStatus.body.data.pausedForBilling, true);
  assert.equal(paidStatus.body.data.hasSubscription, false);

  // Un login nuevo: 403 business_paused, pero con la sesión para pagar.
  const { browser: fresh, res } = await loginAs(app, member.email, member.password!);
  assert.equal(res.status, 403);
  assert.equal(res.body.code, "business_paused");
  assert.ok(res.setCookies.length > 0, "deja la cookie para las rutas de pago");
  assert.equal((await fresh.get(`${API}/home/today`)).body.code, "business_paused");
  const checkout = await fresh.post(`${API}/billing/checkout`, { plan: "pro" });
  assert.equal(checkout.status, 200, "puede volver a suscribirse");
  assert.equal(checkoutCalls.at(-1)!.customerId, customer, "con su mismo cliente de Stripe");
});

test("past_due → gracia → pausa del barrido → pagar reactiva; un evento viejo que llega tarde no pisa el estado", async () => {
  const biz = await createTestBusiness(db, { plan: "basic", locations: ["Central"] });
  const { browser: owner } = await ownerOf(biz.businessId);
  const customer = `cus_${randomUUID().slice(0, 8)}`;
  const sub = `sub_${randomUUID().slice(0, 8)}`;
  await setRow(biz.businessId, { stripeCustomerId: customer, stripeSubscriptionId: sub, stripeSubscriptionStatus: "active", billingStatus: "active" });

  const failedAt = new Date(Date.now() - 60_000);
  assert.equal((await sendWebhook(stripeEvent("invoice.payment_failed", invoice({ subscription: sub, customer }), failedAt))).body.data?.outcome, "applied");
  let row = await rowOf(biz.businessId);
  assert.equal(row.billingStatus, "past_due");
  assert.equal(secs(row.pastDueSince!), secs(failedAt));
  const me = (await owner.get(`${API}/auth/me`)).body.data;
  assert.equal(me.plan.billingStatus, "past_due");
  assert.equal(new Date(me.plan.billing.pauseAt).getTime(), secs(failedAt) * 1000 + 7 * DAY, "se pausa a los 7 días de gracia");

  // Un segundo intento fallido no corre la fecha del atraso.
  await sendWebhook(stripeEvent("invoice.payment_failed", invoice({ subscription: sub, customer })));
  assert.equal(secs((await rowOf(biz.businessId)).pastDueSince!), secs(failedAt));

  // Dentro de la gracia, el barrido no lo toca; vencida, lo pausa por el cobro.
  await sweepBilling(db, { now: new Date(Date.now() + 6 * DAY), env: {} });
  assert.equal((await rowOf(biz.businessId)).status, "active");
  const swept = await sweepBilling(db, { now: new Date(Date.now() + 8 * DAY), env: {} });
  assert.ok(swept.paused >= 1);
  row = await rowOf(biz.businessId);
  assert.equal(row.status, "paused");
  assert.ok(row.billingPausedAt);
  const [pause] = await auditOf(biz.businessId, "business_paused");
  assert.equal(pause.actor, "system:billing");
  assert.equal((pause.details as { reason: string }).reason, "past_due_grace_expired");
  assert.equal((await owner.get(`${API}/auth/me`)).body.code, "business_paused");

  // Paga (desde el Portal o el correo de Stripe): al día y reactivado.
  const paid = await sendWebhook(stripeEvent("invoice.paid", invoice({ subscription: sub, customer })));
  assert.equal(paid.body.data?.outcome, "applied");
  row = await rowOf(biz.businessId);
  assert.equal(row.billingStatus, "active");
  assert.equal(row.status, "active");
  assert.equal(row.billingPausedAt, null);
  assert.equal(row.pastDueSince, null);
  assert.equal((await auditOf(biz.businessId, "business_reactivated"))[0].actor, "system:stripe");
  assert.equal((await owner.get(`${API}/auth/me`)).status, 200, "la misma sesión vuelve a servir");

  // Llega tarde un evento VIEJO (past_due de antes del pago): se registra pero no pisa nada.
  const late = await sendWebhook(stripeEvent("customer.subscription.updated", subscription({ id: sub, customer, status: "past_due", items: [{ price: "price_basic" }] }), new Date(Date.now() - 10 * 60_000)));
  assert.equal(late.body.data?.outcome, "stale");
  assert.equal((await rowOf(biz.businessId)).billingStatus, "active");
});

test("pausa del superadmin: pagar no la levanta y las rutas de pago responden business_paused", async () => {
  const biz = await createTestBusiness(db, { plan: "basic", locations: ["Central"] });
  const { browser: owner } = await ownerOf(biz.businessId);
  const customer = `cus_${randomUUID().slice(0, 8)}`;
  const sub = `sub_${randomUUID().slice(0, 8)}`;
  await setRow(biz.businessId, { stripeCustomerId: customer, stripeSubscriptionId: sub, stripeSubscriptionStatus: "past_due", billingStatus: "past_due" });

  const admin = new Browser(app.baseUrl);
  assert.equal((await admin.post(`${API}/admin/login`, { username: "root", password: ADMIN_PASSWORD })).status, 200);
  assert.equal((await admin.post(`${API}/admin/businesses/${biz.businessId}/pause`, { reason: "fraude" })).status, 200);

  await sendWebhook(stripeEvent("invoice.paid", invoice({ subscription: sub, customer })));
  const row = await rowOf(biz.businessId);
  assert.equal(row.billingStatus, "active", "el cobro queda al día");
  assert.equal(row.status, "paused", "pero la pausa del superadmin sigue");
  const status = await owner.get(`${API}/billing/status`);
  assert.equal(status.status, 403);
  assert.equal(status.body.code, "business_paused");

  // El superadmin ve el estado de Stripe del negocio.
  const detail = (await admin.get(`${API}/admin/businesses/${biz.businessId}`)).body.data;
  assert.equal(detail.stripe.configured, true);
  assert.equal(detail.stripe.customerId, customer);
  assert.equal(detail.stripe.subscriptionId, sub);
  assert.equal(detail.stripe.billingPaused, false);
  assert.equal(detail.stripe.dashboardUrl, `https://dashboard.stripe.com/test/customers/${customer}`);
});

test("prueba vencida: el barrido pausa por el cobro (salvo una suscripción viva de Stripe que cobra al terminar)", async () => {
  const expired = await createTestBusiness(db, { plan: "basic", locations: ["Central"] });
  await setRow(expired.businessId, { billingStatus: "trial", trialEndsAt: new Date(Date.now() - 60_000) });
  const covered = await createTestBusiness(db, { plan: "basic", locations: ["Central"] });
  await setRow(covered.businessId, { billingStatus: "trial", trialEndsAt: new Date(Date.now() - 60_000), stripeSubscriptionId: `sub_${randomUUID().slice(0, 8)}`, stripeSubscriptionStatus: "trialing" });
  const manual = await createTestBusiness(db, { plan: "basic", locations: ["Central"] });
  await setRow(manual.businessId, { billingStatus: "trial", trialEndsAt: null });

  await sweepBilling(db, { env: {} });
  const e = await rowOf(expired.businessId);
  assert.equal(e.status, "paused");
  assert.ok(e.billingPausedAt);
  assert.equal(((await auditOf(expired.businessId, "business_paused"))[0].details as { reason: string }).reason, "trial_expired");
  assert.equal((await rowOf(covered.businessId)).status, "active");
  assert.equal((await rowOf(manual.businessId)).status, "active", "el cobro manual no vence solo");
});

test("webhook: negocio desconocido y tipos que no se usan → 200 y quedan registrados (no se reintentan)", async () => {
  const unknown = await sendWebhook(stripeEvent("invoice.paid", invoice({ subscription: "sub_nadie", customer: "cus_nadie" })));
  assert.equal(unknown.status, 200);
  assert.equal(unknown.body.data?.outcome, "unknown_business");
  const other = stripeEvent("customer.created", { id: "cus_z", object: "customer" });
  const ignored = await sendWebhook(other);
  assert.equal(ignored.body.data?.outcome, "ignored");
  const rows = await withSystem(db, (tx) => tx.select().from(stripeEvents).where(eq(stripeEvents.id, other.id)));
  assert.equal(rows.length, 1);
});
