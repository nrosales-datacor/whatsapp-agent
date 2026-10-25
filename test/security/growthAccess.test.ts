import assert from "node:assert/strict";
import { after, before, test } from "node:test";

// ─────────────────────────────────────────────────────────────────────────────
// Crecimiento (I6) por HTTP con la app real (planes de la composición) sobre PGlite como
// el rol de la app:
//   • Campañas (`module: "campaigns"`): el Básico recibe 403 `module_not_in_plan`; el
//     Básico con Campañas como extra entra; recepción 403; una campaña de otro negocio, 404.
//   • /whatsapp/growth: el Pro lee y guarda; el Básico lee con todo en `allowed: false` y
//     no puede guardar (403); el Pro sin agente ni entra (módulo whatsapp).
//   • Consentimiento en la ficha: dueño y recepción con Campañas; el profesional no; queda
//     auditado.
// ─────────────────────────────────────────────────────────────────────────────

process.env.TRUST_PROXY = "loopback";
process.env.PANEL_SESSION_SECRET = "test-growth-access-secret-0123456789";
process.env.TOKENS_ENCRYPTION_KEY = "d".repeat(64);
process.env.PANEL_LOGIN_RATE_LIMIT_MAX_IP = "500";

const { createAppHandler } = await import("../../src/app");
const { PRO_WITHOUT_AGENT } = await import("../../src/modules/billing");
const { clients } = await import("../../src/modules/clients/schema");
const { services } = await import("../../src/modules/catalog/schema");
const { listTenantAudit } = await import("../../src/platform/audit/auditLog");
const { withTenant } = await import("../../src/platform/db/scope");
const { createEphemeralDb } = await import("../helpers/pgliteDb");
const { Browser, startTestServer } = await import("../helpers/panelClient");
const { createTestBusiness, createTestMember } = await import("../helpers/identityFixtures");
const { createChannel, fakeWhatsApp } = await import("../helpers/whatsappFixtures");

type B = InstanceType<typeof Browser>;
const API = "/api/panel";

const base = await createEphemeralDb();
const { db } = base;
let app: Awaited<ReturnType<typeof startTestServer>>;

before(async () => {
  await base.client.exec("SET ROLE app_runtime");
  app = await startTestServer(createAppHandler({ db, role: "all", whatsapp: fakeWhatsApp(db).deps }));
});
after(async () => {
  await app?.close();
  await base.close();
});

async function login(businessId: string, role: "owner" | "admin" | "front_desk" | "staff"): Promise<B> {
  const member = await createTestMember(db, { businessId, role });
  const b = new Browser(app.baseUrl);
  const res = await b.post(`${API}/auth/login`, { email: member.email, password: member.password });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return b;
}

async function addClient(businessId: string, name: string, phone: string): Promise<string> {
  const [row] = await withTenant(db, businessId, (tx) => tx.insert(clients).values({ businessId, name, phone }).returning({ id: clients.id }));
  return row.id;
}

const PROMO = { name: "Promo", message: "Descuento del mes.", segment: {} };

test("campañas: el Básico no las tiene (403); con Campañas como extra sí; recepción no entra", async () => {
  const basic = await login((await createTestBusiness(db, { plan: "basic", locations: ["Central"] })).businessId, "owner");
  for (const [method, path] of [
    ["get", "/campaigns"],
    ["get", "/campaigns/overview"],
  ] as const) {
    const res = await basic[method](`${API}${path}`);
    assert.equal(res.status, 403, path);
    assert.equal(res.body.code, "module_not_in_plan");
  }
  assert.equal((await basic.post(`${API}/campaigns`, PROMO)).body.code, "module_not_in_plan");

  const withExtra = await login((await createTestBusiness(db, { plan: "basic", locations: ["Central"], extraModules: { modules: { campaigns: true } } })).businessId, "owner");
  assert.equal((await withExtra.get(`${API}/campaigns`)).status, 200);

  const pro = await createTestBusiness(db);
  const desk = await login(pro.businessId, "front_desk");
  assert.equal((await desk.get(`${API}/campaigns`)).status, 403);
});

test("campañas: CRUD del borrador, vista previa, lanzar sin plantilla (409) y aislamiento entre negocios", async () => {
  const biz = await createTestBusiness(db);
  await createChannel(db, biz.businessId);
  const owner = await login(biz.businessId, "owner");
  const created = await owner.post(`${API}/campaigns`, PROMO);
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const id = created.body.data.id;
  assert.equal(created.body.data.status, "draft");

  const bad = await owner.post(`${API}/campaigns`, { ...PROMO, message: "línea uno\nlínea dos" });
  assert.equal(bad.status, 400, "sin saltos de línea en la variable de la plantilla");

  const patched = await owner.patch(`${API}/campaigns/${id}`, { segment: { statuses: ["at_risk"], lastVisitMinDays: 60 } });
  assert.equal(patched.status, 200, JSON.stringify(patched.body));
  assert.deepEqual(patched.body.data.segment, { statuses: ["at_risk"], lastVisitMinDays: 60 });

  const preview = await owner.post(`${API}/campaigns/preview`, { segment: {} });
  assert.equal(preview.status, 200);
  assert.deepEqual(Object.keys(preview.body.data).sort(), ["channels", "eligible", "matched", "optedOut", "sample", "withoutConsent", "withoutPhone"]);

  const launch = await owner.post(`${API}/campaigns/${id}/launch`, {});
  assert.equal(launch.status, 409);
  assert.equal(launch.body.code, "no_marketing_template");

  const other = await login((await createTestBusiness(db)).businessId, "owner");
  assert.equal((await other.get(`${API}/campaigns/${id}`)).status, 404, "otro negocio no la ve");
  assert.equal((await other.post(`${API}/campaigns/${id}/cancel`, {})).status, 404);
  assert.equal((await other.delete(`${API}/campaigns/${id}`)).status, 404);

  assert.equal((await owner.delete(`${API}/campaigns/${id}`)).status, 204);
  assert.equal((await owner.get(`${API}/campaigns/${id}`)).status, 404);
});

test("crecimiento: el Pro lee y guarda; el Básico lee sin nada permitido y no guarda; el Pro sin agente no entra", async () => {
  const pro = await createTestBusiness(db);
  const [svc] = await withTenant(db, pro.businessId, (tx) =>
    tx
      .insert(services)
      .values([
        { businessId: pro.businessId, name: "Manicura", durationMin: 40, priceCents: 800_000 },
        { businessId: pro.businessId, name: "Pedicura", durationMin: 60, priceCents: 1_200_000 },
      ])
      .returning({ id: services.id }),
  );
  const [, pedi] = await withTenant(db, pro.businessId, (tx) => tx.select({ id: services.id }).from(services).orderBy(services.name));
  const owner = await login(pro.businessId, "owner");
  const read = await owner.get(`${API}/whatsapp/growth`);
  assert.equal(read.status, 200);
  assert.deepEqual(read.body.data.allowed, { reviews: true, quoteRecovery: true, upsell: true });
  assert.equal(read.body.data.reviews.enabled, false, "apagado hasta que el dueño lo active");

  const saved = await owner.patch(`${API}/whatsapp/growth`, {
    reviews: { enabled: true, delayHours: 4, reviewUrl: "https://g.page/r/negocio/review" },
    upsell: { enabled: true, rules: [{ serviceId: svc.id, suggestServiceId: pedi.id }] },
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.equal(saved.body.data.reviews.delayHours, 4);
  assert.equal(saved.body.data.upsell.rules.length, 1);
  const badUrl = await owner.patch(`${API}/whatsapp/growth`, { reviews: { enabled: true, delayHours: 4, reviewUrl: "javascript:alert(1)" } });
  assert.equal(badUrl.status, 400);
  const badRule = await owner.patch(`${API}/whatsapp/growth`, { upsell: { enabled: true, rules: [{ serviceId: svc.id, suggestServiceId: svc.id }] } });
  assert.equal(badRule.status, 400);
  const desk = await login(pro.businessId, "front_desk");
  assert.equal((await desk.patch(`${API}/whatsapp/growth`, { quoteRecovery: { enabled: true, waitHours: 3, firstTouchText: null } })).status, 403);

  const basic = await login((await createTestBusiness(db, { plan: "basic", locations: ["Central"] })).businessId, "owner");
  const basicRead = await basic.get(`${API}/whatsapp/growth`);
  assert.equal(basicRead.status, 200);
  assert.deepEqual(basicRead.body.data.allowed, { reviews: false, quoteRecovery: false, upsell: false });
  const basicWrite = await basic.patch(`${API}/whatsapp/growth`, { quoteRecovery: { enabled: true, waitHours: 3, firstTouchText: null } });
  assert.equal(basicWrite.status, 403);
  assert.equal(basicWrite.body.code, "module_not_in_plan");

  const noAgent = await login((await createTestBusiness(db, { extraModules: { ...PRO_WITHOUT_AGENT } })).businessId, "owner");
  assert.equal((await noAgent.get(`${API}/whatsapp/growth`)).body.code, "module_not_in_plan");
});

test("consentimiento en la ficha: recepción lo registra (auditado), el profesional no; sin Campañas, 403", async () => {
  const biz = await createTestBusiness(db);
  const clientId = await addClient(biz.businessId, "Lucía Mora", "+50688776655");
  const desk = await login(biz.businessId, "front_desk");
  const granted = await desk.put(`${API}/clients/${clientId}/marketing-consent`, { granted: true });
  assert.equal(granted.status, 200, JSON.stringify(granted.body));
  assert.ok(granted.body.data.marketingConsentAt);
  const revoked = await desk.put(`${API}/clients/${clientId}/marketing-consent`, { granted: false });
  assert.equal(revoked.body.data.marketingConsentAt, null);
  assert.ok(revoked.body.data.marketingOptOutAt, "retirarlo en la ficha es una baja");
  const audit = await listTenantAudit(db, biz.businessId, 10);
  assert.deepEqual(
    audit.filter((a) => a.details.clientId === clientId).map((a) => a.action),
    ["client_marketing_consent_revoked", "client_marketing_consent_granted"],
  );

  const staff = await login(biz.businessId, "staff");
  assert.equal((await staff.put(`${API}/clients/${clientId}/marketing-consent`, { granted: true })).status, 403);

  const basic = await createTestBusiness(db, { plan: "basic", locations: ["Central"] });
  const basicClient = await addClient(basic.businessId, "Pedro", "+50688776600");
  const basicOwner = await login(basic.businessId, "owner");
  assert.equal((await basicOwner.put(`${API}/clients/${basicClient}/marketing-consent`, { granted: true })).body.code, "module_not_in_plan");
});
