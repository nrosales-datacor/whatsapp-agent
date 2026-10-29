import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { and, desc, eq } from "drizzle-orm";

// ─────────────────────────────────────────────────────────────────────────────
// Superadmin y cobro manual (I2) por HTTP: cambiar plan, módulos sueltos, cupos y estado del
// cobro (con auditoría en la misma transacción), pausar y reactivar (el negocio ve 403
// `business_paused` y vuelve), y el detalle con el uso del mes. Base como `app_runtime`.
// ─────────────────────────────────────────────────────────────────────────────

process.env.TRUST_PROXY = "loopback";
process.env.PANEL_SESSION_SECRET = "test-superadmin-plans-secret-0123456789";
process.env.TOKENS_ENCRYPTION_KEY = "f".repeat(64);
process.env.PANEL_LOGIN_RATE_LIMIT_MAX_IP = "500";
process.env.PANEL_SUPERADMIN_USERNAME = "root";
delete process.env.PANEL_SUPERADMIN_TOTP_SECRET;

const ADMIN_PASSWORD = "clave-del-superadmin-2";
const { hashPassword } = await import("../../src/platform/auth/password");
process.env.PANEL_SUPERADMIN_HASH = await hashPassword(ADMIN_PASSWORD);

const { createAppHandler } = await import("../../src/app");
const { businesses } = await import("../../src/modules/business/schema");
const { auditLog } = await import("../../src/platform/db/schema");
const { withSystem } = await import("../../src/platform/db/scope");
const { createEphemeralDb } = await import("../helpers/pgliteDb");
const { Browser, startTestServer } = await import("../helpers/panelClient");
const { createTestBusiness, createTestMember } = await import("../helpers/identityFixtures");

type TestServer = Awaited<ReturnType<typeof startTestServer>>;

const base = await createEphemeralDb();
const { db } = base;
let app: TestServer;

before(async () => {
  await base.client.exec("SET ROLE app_runtime");
  app = await startTestServer(createAppHandler({ db, role: "all" }));
});

after(async () => {
  await app?.close();
  await base.close();
});

const API = "/api/panel";

async function admin(): Promise<InstanceType<typeof Browser>> {
  const b = new Browser(app.baseUrl);
  const res = await b.post(`${API}/admin/login`, { username: "root", password: ADMIN_PASSWORD });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return b;
}

async function ownerOf(businessId: string): Promise<InstanceType<typeof Browser>> {
  const member = await createTestMember(db, { businessId, role: "owner" });
  const b = new Browser(app.baseUrl);
  assert.equal((await b.post(`${API}/auth/login`, { email: member.email, password: member.password })).status, 200);
  return b;
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

async function rowOf(businessId: string) {
  const [row] = await withSystem(db, (tx) => tx.select().from(businesses).where(eq(businesses.id, businessId)));
  return row;
}

test("plan: sin sesión de superadmin (o con la de un negocio) → 401", async () => {
  const biz = await createTestBusiness(db);
  const owner = await ownerOf(biz.businessId);
  for (const b of [new Browser(app.baseUrl), owner]) {
    assert.equal((await b.patch(`${API}/admin/businesses/${biz.businessId}/plan`, { plan: "basic" })).status, 401);
    assert.equal((await b.post(`${API}/admin/businesses/${biz.businessId}/pause`, {})).status, 401);
    assert.equal((await b.get(`${API}/admin/businesses/${biz.businessId}`)).status, 401);
  }
});

test("plan: Básico → Pro sin agente con cupos contratados y cobro al día; queda auditado (antes/después) y el negocio lo ve", async () => {
  const biz = await createTestBusiness(db, { plan: "basic", locations: ["Central"] });
  const owner = await ownerOf(biz.businessId);
  const a = await admin();

  const res = await a.patch(`${API}/admin/businesses/${biz.businessId}/plan`, {
    plan: "pro",
    extraModules: { whatsapp: false, campaigns: true },
    limits: { locations: 3, staff: 10, aiConversations: null },
    billingStatus: "active",
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const detail = res.body.data;
  assert.equal(detail.business.plan, "pro");
  assert.equal(detail.business.planLabel, "Pro sin agente");
  assert.equal(detail.business.billingStatus, "active");
  assert.ok(!detail.business.modules.includes("whatsapp"));
  assert.deepEqual(detail.overrides.modules, { whatsapp: false }, "campañas ya viene en Pro: no se guarda");
  assert.equal(detail.limits.locations, 3);
  assert.equal(detail.limits.aiConversations, null);
  assert.equal(detail.usage.locations, 1);
  assert.equal(detail.usage.users, 1);

  const stored = await rowOf(biz.businessId);
  assert.deepEqual(stored.extraModules, { modules: { whatsapp: false }, limits: { locations: 3, staff: 10, aiConversations: null } });

  const [entry] = await auditOf(biz.businessId, "plan_changed");
  assert.equal(entry.actor, "superadmin:root");
  const details = entry.details as { before: { plan: string; billingStatus: string }; after: { plan: string; modules: string[]; billingStatus: string } };
  assert.equal(details.before.plan, "basic");
  assert.equal(details.before.billingStatus, "trial");
  assert.equal(details.after.plan, "pro");
  assert.equal(details.after.billingStatus, "active");
  assert.ok(!details.after.modules.includes("whatsapp"));

  const me = (await owner.get(`${API}/auth/me`)).body.data;
  assert.equal(me.plan.label, "Pro sin agente", "el proceso que cambia el plan invalida su caché al instante");
  assert.equal(me.plan.limits.locations, 3);
  assert.equal((await owner.post(`${API}/settings/locations`, { name: "Norte" })).status, 201, "ya puede sumar sucursales");
});

test("plan: lo que no viene se conserva; extraModules y limits reemplazan lo contratado; validación estricta", async () => {
  const biz = await createTestBusiness(db, { plan: "basic", locations: ["Central"], extraModules: { modules: { campaigns: true }, limits: { staff: 4 } } });
  const a = await admin();
  const onlyBilling = await a.patch(`${API}/admin/businesses/${biz.businessId}/plan`, { billingStatus: "past_due" });
  assert.equal(onlyBilling.status, 200);
  assert.deepEqual(onlyBilling.body.data.overrides, { modules: { campaigns: true }, limits: { staff: 4 } });
  assert.equal(onlyBilling.body.data.business.billingStatus, "past_due");

  const replaced = await a.patch(`${API}/admin/businesses/${biz.businessId}/plan`, { limits: { users: 3 } });
  assert.deepEqual(replaced.body.data.overrides, { modules: { campaigns: true }, limits: { users: 3 } });

  for (const body of [{}, { plan: "enterprise" }, { extraModules: { inventado: true } }, { limits: { staff: -1 } }, { billingStatus: "debe" }, { otra: 1 }]) {
    const res = await a.patch(`${API}/admin/businesses/${biz.businessId}/plan`, body);
    assert.equal(res.status, 400, JSON.stringify(body));
  }
  const missing = await a.patch(`${API}/admin/businesses/00000000-0000-4000-8000-000000000000/plan`, { plan: "pro" });
  assert.equal(missing.status, 404);
});

test("pausa: la API del negocio → 403 business_paused; repetir → 409; reactivar la devuelve; todo auditado", async () => {
  const biz = await createTestBusiness(db);
  const owner = await ownerOf(biz.businessId);
  const a = await admin();

  const paused = await a.post(`${API}/admin/businesses/${biz.businessId}/pause`, { reason: "falta de pago octubre" });
  assert.equal(paused.status, 200, JSON.stringify(paused.body));
  assert.equal(paused.body.data.business.status, "paused");
  const me = await owner.get(`${API}/auth/me`);
  assert.equal(me.status, 403);
  assert.equal(me.body.code, "business_paused");
  assert.equal((await a.post(`${API}/admin/businesses/${biz.businessId}/pause`, {})).status, 409);

  const list = await a.get(`${API}/admin/businesses`);
  assert.equal(list.body.data.find((b: { id: string }) => b.id === biz.businessId)?.status, "paused", "el superadmin lo sigue viendo");

  const [pauseEntry] = await auditOf(biz.businessId, "business_paused");
  assert.equal(pauseEntry.actor, "superadmin:root");
  assert.equal((pauseEntry.details as { reason: string }).reason, "falta de pago octubre");

  const back = await a.post(`${API}/admin/businesses/${biz.businessId}/reactivate`);
  assert.equal(back.status, 200);
  assert.equal(back.body.data.business.status, "active");
  assert.equal((await owner.get(`${API}/auth/me`)).status, 200, "la sesión del dueño vuelve a servir");
  assert.equal((await a.post(`${API}/admin/businesses/${biz.businessId}/reactivate`)).status, 409);
  assert.equal((await auditOf(biz.businessId, "business_reactivated")).length, 1);

  const detail = (await a.get(`${API}/admin/businesses/${biz.businessId}`)).body.data;
  assert.deepEqual(
    detail.audit.slice(0, 2).map((e: { action: string }) => e.action),
    ["business_reactivated", "business_paused"],
    "el detalle trae el historial, más reciente primero",
  );
});

test("lista y alta: cada negocio con su plan efectivo y estado de cobro (alta nueva = Básico en prueba)", async () => {
  const a = await admin();
  const created = await a.post(`${API}/admin/businesses`, {
    name: "Uñas de prueba",
    industry: "nails",
    timezone: "America/Costa_Rica",
    currency: "CRC",
    country: "CR",
    locationName: "Central",
    ownerEmail: `duena-${Date.now()}@example.test`,
    ownerName: "Dueña",
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.data.plan, "basic");
  assert.equal(created.body.data.planLabel, "Básico");
  assert.equal(created.body.data.billingStatus, "trial");
  assert.deepEqual(created.body.data.modules, ["scheduling", "clients", "whatsapp"]);
  assert.ok(!("extraModules" in created.body.data));

  const list = (await a.get(`${API}/admin/businesses`)).body.data;
  const row = list.find((b: { id: string }) => b.id === created.body.data.id);
  assert.deepEqual(row, created.body.data);
});
