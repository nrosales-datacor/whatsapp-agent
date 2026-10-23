import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { eq } from "drizzle-orm";

// ─────────────────────────────────────────────────────────────────────────────
// Checklist de primeros pasos del Inicio (I6) por HTTP: cada paso se detecta solo (horario,
// servicios, equipo, WhatsApp si el plan lo trae, primera cita), se oculta al completarse
// o al descartarla, y es de dueño y admin. Base como `app_runtime`.
// ─────────────────────────────────────────────────────────────────────────────

process.env.TRUST_PROXY = "loopback";
process.env.PANEL_SESSION_SECRET = "test-onboarding-session-secret-012345678";
process.env.TOKENS_ENCRYPTION_KEY = "a".repeat(64);
process.env.PANEL_LOGIN_RATE_LIMIT_MAX_IP = "500";

const { createAppHandler } = await import("../../src/app");
const { businesses, invalidateBusinessContext } = await (async () => ({
  businesses: (await import("../../src/modules/business/schema")).businesses,
  invalidateBusinessContext: (await import("../../src/modules/business")).invalidateBusinessContext,
}))();
const { appointments } = await import("../../src/modules/scheduling/schema");
const { withSystem, withTenant } = await import("../../src/platform/db/scope");
const { createEphemeralDb } = await import("../helpers/pgliteDb");
const { Browser, startTestServer } = await import("../helpers/panelClient");
const { createTestBusiness, createTestMember } = await import("../helpers/identityFixtures");
const { appointmentValues, createBusinessFixture } = await import("../helpers/domainFixtures");
const { createChannel } = await import("../helpers/whatsappFixtures");

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

async function memberOf(businessId: string, role: "owner" | "admin" | "staff" = "owner") {
  const member = await createTestMember(db, { businessId, role });
  const b = new Browser(app.baseUrl);
  assert.equal((await b.post(`${API}/auth/login`, { email: member.email, password: member.password })).status, 200);
  return b;
}

const stepsOf = (data: { steps: { id: string; done: boolean }[] }) => Object.fromEntries(data.steps.map((s) => [s.id, s.done]));

test("checklist: cada paso se detecta solo y, completa, se oculta", async () => {
  const f = await createBusinessFixture(db, { staffCount: 1 });
  const owner = await memberOf(f.businessId);

  let res = await owner.get(`${API}/onboarding`);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.data.visible, true);
  assert.deepEqual(stepsOf(res.body.data), { hours: false, services: false, team: true, whatsapp: false, first_appointment: false }, "el plan Básico trae WhatsApp");

  assert.equal((await owner.request("PUT", `${API}/settings/locations/${f.locationId}/hours`, { hours: [{ weekday: 1, start: "09:00", end: "17:00" }] })).status, 200);
  const service = await owner.post(`${API}/settings/services`, { name: "Consulta", durationMin: 30, priceCents: 1_000_000 });
  assert.equal(service.status, 201, JSON.stringify(service.body));
  await createChannel(db, f.businessId);
  await withTenant(db, f.businessId, (tx) => tx.insert(appointments).values(appointmentValues(f, "2026-11-02T15:00:00.000Z", 30)));

  res = await owner.get(`${API}/onboarding`);
  assert.deepEqual(stepsOf(res.body.data), { hours: true, services: true, team: true, whatsapp: true, first_appointment: true });
  assert.equal(res.body.data.completed, true);
  assert.equal(res.body.data.visible, false, "completa: no se muestra más");
});

test("checklist: Pro sin agente no pide WhatsApp; descartarla la oculta; recepción y profesional no la ven", async () => {
  const biz = await createTestBusiness(db, { plan: "pro", extraModules: { modules: { whatsapp: false }, limits: { locations: 5, staff: 10, users: 10 } } });
  const admin = await memberOf(biz.businessId, "admin");
  let res = await admin.get(`${API}/onboarding`);
  assert.deepEqual(
    res.body.data.steps.map((s: { id: string }) => s.id),
    ["hours", "services", "team", "first_appointment"],
  );
  assert.equal(res.body.data.visible, true);

  const staff = await memberOf(biz.businessId, "staff");
  assert.equal((await staff.get(`${API}/onboarding`)).status, 403);
  assert.equal((await staff.post(`${API}/onboarding/dismiss`)).status, 403);

  res = await admin.post(`${API}/onboarding/dismiss`);
  assert.equal(res.status, 200);
  assert.equal(res.body.data.dismissed, true);
  assert.equal(res.body.data.visible, false);
  assert.equal((await admin.get(`${API}/onboarding`)).body.data.visible, false);
  const [row] = await withSystem(db, (tx) => tx.select().from(businesses).where(eq(businesses.id, biz.businessId)));
  assert.ok(row.onboardingDismissedAt);
});

test("checklist: un negocio que ya la tenía descartada (los anteriores a I6) no la muestra", async () => {
  const biz = await createTestBusiness(db);
  await withSystem(db, (tx) => tx.update(businesses).set({ onboardingDismissedAt: new Date("2026-01-01T00:00:00Z") }).where(eq(businesses.id, biz.businessId)));
  invalidateBusinessContext(biz.businessId);
  const owner = await memberOf(biz.businessId);
  const res = await owner.get(`${API}/onboarding`);
  assert.equal(res.body.data.visible, false);
  assert.equal(res.body.data.dismissed, true);
});
