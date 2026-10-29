import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { and, desc, eq } from "drizzle-orm";

// ─────────────────────────────────────────────────────────────────────────────
// Webhook de Stripe (I6.6) por HTTP contra la app real, con la base como `app_runtime` y un
// doble de la API de Stripe (la suscripción "fresca" que se lee antes de aplicar): firma
// (cuerpo crudo, secreto y tolerancia), idempotencia por id de evento, precio → plan
// (Básico, Pro, Pro sin agente conservando los cupos contratados), estado → estado del
// cobro, cancelación, precio desconocido, negocio desconocido, auditoría y tope del cuerpo.
// También el barrido de pruebas vencidas (I6.7).
// ─────────────────────────────────────────────────────────────────────────────

process.env.TRUST_PROXY = "loopback";
process.env.PANEL_SESSION_SECRET = "test-stripe-webhook-session-secret-012";
process.env.TOKENS_ENCRYPTION_KEY = "d".repeat(64);
const WEBHOOK_SECRET = "whsec_test_secret_0123456789";
process.env.STRIPE_SECRET_KEY = "sk_test_dummy";
process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;
process.env.STRIPE_PRICE_BASIC = "price_basic";
process.env.STRIPE_PRICE_PRO = "price_pro";
process.env.STRIPE_PRICE_PRO_NO_AGENT = "price_pro_no_agent";

const { createAppHandler } = await import("../../src/app");
const { expireTrials, signStripePayload } = await import("../../src/modules/billing");
const { stripeEvents } = await import("../../src/modules/billing/schema");
const { businesses } = await import("../../src/modules/business/schema");
const { auditLog } = await import("../../src/platform/db/schema");
const { withSystem } = await import("../../src/platform/db/scope");
const { createEphemeralDb } = await import("../helpers/pgliteDb");
const { startTestServer } = await import("../helpers/panelClient");
const { createTestBusiness } = await import("../helpers/identityFixtures");
type SubscriptionSnapshot = import("../../src/modules/billing").SubscriptionSnapshot;
type StripeGateway = import("../../src/modules/billing").StripeGateway;

const base = await createEphemeralDb();
const { db } = base;
let app: Awaited<ReturnType<typeof startTestServer>>;

/** La "API de Stripe" del test: suscripciones por id. */
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

async function post(body: string, signature: string | null): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (signature !== null) headers["stripe-signature"] = signature;
  const res = await fetch(`${app.baseUrl}/webhook/stripe`, { method: "POST", headers, body });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

/** Manda un evento firmado con el secreto del endpoint. */
async function send(event: { id?: string; type: string; object: Record<string, unknown> }) {
  const id = event.id ?? nextId("evt");
  const body = JSON.stringify({ id, object: "event", type: event.type, data: { object: event.object } });
  return { id, ...(await post(body, signStripePayload(body, WEBHOOK_SECRET))) };
}

function subscription(input: Partial<SubscriptionSnapshot> & { businessId?: string }): SubscriptionSnapshot {
  const sub: SubscriptionSnapshot = {
    id: input.id ?? nextId("sub"),
    customerId: input.customerId ?? nextId("cus"),
    status: input.status ?? "active",
    priceId: input.priceId === undefined ? "price_pro" : input.priceId,
    trialEnd: input.trialEnd ?? null,
    metadata: input.metadata ?? (input.businessId ? { businessId: input.businessId } : {}),
  };
  subscriptions.set(sub.id, sub);
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

test("firma: sin cabecera, con otro secreto, con el cuerpo alterado o vieja → 400 y no toca nada", async () => {
  const biz = await createTestBusiness(db, { plan: "basic" });
  const sub = subscription({ businessId: biz.businessId, priceId: "price_pro" });
  const body = JSON.stringify({ id: nextId("evt"), type: "customer.subscription.updated", data: { object: { id: sub.id } } });
  assert.equal((await post(body, null)).status, 400);
  assert.equal((await post(body, signStripePayload(body, "whsec_otro"))).status, 400);
  assert.equal((await post(body.replace("updated", "deleted"), signStripePayload(body, WEBHOOK_SECRET))).status, 400);
  const old = Math.floor(Date.now() / 1000) - 3600;
  assert.equal((await post(body, signStripePayload(body, WEBHOOK_SECRET, old))).status, 400, "una firma de hace una hora no vale (replay)");
  assert.equal((await rowOf(biz.businessId)).plan, "basic");
});

test("método distinto de POST → 405; cuerpo enorme → 413", async () => {
  const res = await fetch(`${app.baseUrl}/webhook/stripe`);
  assert.equal(res.status, 405);
  const huge = "x".repeat(300 * 1024);
  assert.equal((await post(huge, signStripePayload(huge, WEBHOOK_SECRET))).status, 413);
});

test("sin Stripe configurado → 503 (Stripe reintenta) aunque la firma sea válida", async () => {
  const saved = process.env.STRIPE_SECRET_KEY;
  delete process.env.STRIPE_SECRET_KEY;
  try {
    const res = await send({ type: "customer.subscription.updated", object: { id: "sub_x" } });
    assert.equal(res.status, 503);
    assert.equal(res.body.error, "billing_not_configured");
  } finally {
    process.env.STRIPE_SECRET_KEY = saved;
  }
});

test("checkout completo: guarda cliente y suscripción, aplica el plan (Pro sin agente) y el estado, con auditoría", async () => {
  const biz = await createTestBusiness(db, { plan: "basic", extraModules: { limits: { staff: 9 } } });
  const trialEnd = new Date(Date.now() + 7 * 86_400_000);
  const sub = subscription({ status: "trialing", priceId: "price_pro_no_agent", trialEnd, metadata: { businessId: biz.businessId, option: "pro_no_agent" } });
  const res = await send({
    type: "checkout.session.completed",
    object: { id: "cs_1", mode: "subscription", client_reference_id: biz.businessId, customer: sub.customerId, subscription: sub.id },
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.outcome, "applied");
  const row = await rowOf(biz.businessId);
  assert.equal(row.plan, "pro");
  assert.deepEqual(row.extraModules, { modules: { whatsapp: false }, limits: { staff: 9 } }, "Pro sin agente, con los cupos contratados intactos");
  assert.equal(row.billingStatus, "trial");
  assert.equal(row.stripeCustomerId, sub.customerId);
  assert.equal(row.stripeSubscriptionId, sub.id);
  assert.equal(row.trialEndsAt?.toISOString(), trialEnd.toISOString());
  const [audit] = await auditOf(biz.businessId, "stripe_subscription_synced");
  assert.equal(audit.actor, "system:stripe");
  assert.equal((audit.details as any).before.plan, "basic");
  assert.equal((audit.details as any).after.plan, "pro");
  assert.ok(!JSON.stringify(audit.details).includes("@"), "sin datos personales en la auditoría");
});

test("idempotencia: el mismo evento dos veces se aplica una sola (sin segunda auditoría)", async () => {
  const biz = await createTestBusiness(db, { plan: "basic" });
  const sub = subscription({ businessId: biz.businessId, priceId: "price_pro", status: "active" });
  const id = nextId("evt");
  const first = await send({ id, type: "customer.subscription.created", object: { id: sub.id } });
  assert.equal(first.body.outcome, "applied");
  const second = await send({ id, type: "customer.subscription.created", object: { id: sub.id } });
  assert.equal(second.status, 200);
  assert.equal(second.body.outcome, "duplicate");
  assert.equal((await auditOf(biz.businessId, "stripe_subscription_synced")).length, 1);
  const rows = await withSystem(db, (tx) => tx.select().from(stripeEvents).where(eq(stripeEvents.id, id)));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].businessId, biz.businessId);
});

test("estados: activa → al día; past_due/unpaid → atrasado; se resuelve el negocio por la suscripción guardada", async () => {
  const biz = await createTestBusiness(db, { plan: "basic" });
  const sub = subscription({ businessId: biz.businessId, priceId: "price_basic", status: "active" });
  await send({ type: "customer.subscription.created", object: { id: sub.id } });
  assert.equal((await rowOf(biz.businessId)).billingStatus, "active");
  assert.equal((await rowOf(biz.businessId)).plan, "basic");

  // Sin metadata: lo resuelve la suscripción que ya quedó guardada.
  subscriptions.set(sub.id, { ...sub, status: "past_due", metadata: {} });
  await send({ type: "customer.subscription.updated", object: { id: sub.id } });
  assert.equal((await rowOf(biz.businessId)).billingStatus, "past_due");

  subscriptions.set(sub.id, { ...sub, status: "unpaid", metadata: {} });
  await send({ type: "customer.subscription.updated", object: { id: sub.id } });
  assert.equal((await rowOf(biz.businessId)).billingStatus, "past_due");

  // `incomplete` no cambia el estado.
  subscriptions.set(sub.id, { ...sub, status: "incomplete", metadata: {} });
  await send({ type: "customer.subscription.updated", object: { id: sub.id } });
  assert.equal((await rowOf(biz.businessId)).billingStatus, "past_due");
});

test("cambio de plan desde el Portal: Pro sin agente → Pro vuelve a prender el agente; Pro → Básico", async () => {
  const biz = await createTestBusiness(db, { plan: "pro", extraModules: { modules: { whatsapp: false } } });
  const sub = subscription({ businessId: biz.businessId, priceId: "price_pro", status: "active" });
  await send({ type: "customer.subscription.updated", object: { id: sub.id } });
  let row = await rowOf(biz.businessId);
  assert.equal(row.plan, "pro");
  assert.deepEqual(row.extraModules, {});

  subscriptions.set(sub.id, { ...sub, priceId: "price_basic" });
  await send({ type: "customer.subscription.updated", object: { id: sub.id } });
  row = await rowOf(biz.businessId);
  assert.equal(row.plan, "basic");
});

test("cancelación: cobro cancelado, la suscripción deja de ser la del negocio (el cliente queda) y el plan no cambia", async () => {
  const biz = await createTestBusiness(db, { plan: "basic" });
  const sub = subscription({ businessId: biz.businessId, priceId: "price_pro", status: "active" });
  await send({ type: "customer.subscription.created", object: { id: sub.id } });
  subscriptions.set(sub.id, { ...sub, status: "canceled" });
  const res = await send({ type: "customer.subscription.deleted", object: { id: sub.id } });
  assert.equal(res.body.outcome, "applied");
  const row = await rowOf(biz.businessId);
  assert.equal(row.billingStatus, "cancelled");
  assert.equal(row.stripeSubscriptionId, null);
  assert.equal(row.stripeCustomerId, sub.customerId);
  assert.equal(row.plan, "pro");
});

test("precio desconocido: no se adivina el plan (solo el estado del cobro)", async () => {
  const biz = await createTestBusiness(db, { plan: "basic" });
  const sub = subscription({ businessId: biz.businessId, priceId: "price_de_otro_producto", status: "active" });
  await send({ type: "customer.subscription.created", object: { id: sub.id } });
  const row = await rowOf(biz.businessId);
  assert.equal(row.plan, "basic");
  assert.equal(row.billingStatus, "active");
});

test("negocio desconocido o metadata que no es un id: queda registrado y no rompe; otros tipos se ignoran", async () => {
  const sub = subscription({ metadata: { businessId: "no-es-un-uuid" } });
  const res = await send({ type: "customer.subscription.created", object: { id: sub.id } });
  assert.equal(res.status, 200);
  assert.equal(res.body.outcome, "unknown_business");
  const other = await send({ type: "invoice.paid", object: { id: "in_1" } });
  assert.equal(other.body.outcome, "ignored");
  const again = await send({ id: other.id, type: "invoice.paid", object: { id: "in_1" } });
  assert.equal(again.body.outcome, "duplicate");
});

test("si la API de Stripe falla al leer la suscripción → 500 (Stripe reintenta) y el evento NO queda registrado", async () => {
  const res = await send({ type: "customer.subscription.updated", object: { id: "sub_que_no_existe" } });
  assert.equal(res.status, 500);
  const rows = await withSystem(db, (tx) => tx.select().from(stripeEvents).where(eq(stripeEvents.id, res.id)));
  assert.equal(rows.length, 0);
});

test("pruebas vencidas: pasan a pago pendiente con auditoría; con suscripción, sin fecha o vigentes no se tocan", async () => {
  const now = new Date();
  const past = new Date(now.getTime() - 60_000);
  const future = new Date(now.getTime() + 86_400_000);
  const expired = await createTestBusiness(db, { plan: "pro" });
  const subscribed = await createTestBusiness(db, { plan: "pro" });
  const current = await createTestBusiness(db, { plan: "pro" });
  const manual = await createTestBusiness(db, { plan: "pro" });
  await withSystem(db, async (tx) => {
    await tx.update(businesses).set({ billingStatus: "trial", trialEndsAt: past }).where(eq(businesses.id, expired.businessId));
    await tx.update(businesses).set({ billingStatus: "trial", trialEndsAt: past, stripeSubscriptionId: nextId("sub") }).where(eq(businesses.id, subscribed.businessId));
    await tx.update(businesses).set({ billingStatus: "trial", trialEndsAt: future }).where(eq(businesses.id, current.businessId));
    await tx.update(businesses).set({ billingStatus: "trial", trialEndsAt: null }).where(eq(businesses.id, manual.businessId));
  });
  assert.ok((await expireTrials(db, now)) >= 1);
  assert.equal((await rowOf(expired.businessId)).billingStatus, "past_due");
  assert.equal((await rowOf(expired.businessId)).status, "active", "no se pausa solo");
  assert.equal((await auditOf(expired.businessId, "trial_expired")).length, 1);
  for (const b of [subscribed, current, manual]) assert.equal((await rowOf(b.businessId)).billingStatus, "trial");
  // Correr de nuevo no duplica nada.
  await expireTrials(db, now);
  assert.equal((await auditOf(expired.businessId, "trial_expired")).length, 1);
});
