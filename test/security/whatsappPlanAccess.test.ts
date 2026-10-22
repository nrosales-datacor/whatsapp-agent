import assert from "node:assert/strict";
import { after, before, test } from "node:test";

// ─────────────────────────────────────────────────────────────────────────────
// Planes × WhatsApp por HTTP, con la app real (createAppHandler con los planes de la
// composición, src/plans.ts) sobre PGlite como el rol de la app:
//   • `module: "whatsapp"` con el `moduleGate` real: un Pro sin agente recibe 403
//     `module_not_in_plan` en la bandeja, la configuración del agente y el push; el
//     Básico (que trae el agente) pasa;
//   • `me.plan.usage.aiConversations` y el detalle del superadmin muestran el uso real
//     del agente en el mes (`ai_usage_monthly`, vía `aiUsage`); sin WhatsApp conectado,
//     null ("todavía no se mide").
// ─────────────────────────────────────────────────────────────────────────────

process.env.TRUST_PROXY = "loopback";
process.env.PANEL_SESSION_SECRET = "test-whatsapp-plan-access-secret-012345";
process.env.TOKENS_ENCRYPTION_KEY = "d".repeat(64);
process.env.PANEL_LOGIN_RATE_LIMIT_MAX_IP = "500";
process.env.PANEL_SUPERADMIN_USERNAME = "root";
process.env.VAPID_PUBLIC_KEY = "BPublicKeyDePrueba";
process.env.VAPID_PRIVATE_KEY = "privada-de-prueba";
delete process.env.PANEL_SUPERADMIN_TOTP_SECRET;
const ADMIN_PASSWORD = "clave-del-superadmin-3";
const { hashPassword } = await import("../../src/platform/auth/password");
process.env.PANEL_SUPERADMIN_HASH = await hashPassword(ADMIN_PASSWORD);

const { createAppHandler } = await import("../../src/app");
const { monthIn, PLANS, PRO_WITHOUT_AGENT } = await import("../../src/modules/billing");
const { incrementAiUsage } = await import("../../src/modules/whatsapp/usage");
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
  // Sin `plans` ni `panelApi`: los planes reales de la composición (con el uso del agente).
  app = await startTestServer(createAppHandler({ db, role: "all", whatsapp: fakeWhatsApp(db).deps }));
});

after(async () => {
  await app?.close();
  await base.close();
});

async function ownerOf(businessId: string): Promise<B> {
  const member = await createTestMember(db, { businessId, role: "owner" });
  const b = new Browser(app.baseUrl);
  const res = await b.post(`${API}/auth/login`, { email: member.email, password: member.password });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return b;
}

async function admin(): Promise<B> {
  const b = new Browser(app.baseUrl);
  const res = await b.post(`${API}/admin/login`, { username: "root", password: ADMIN_PASSWORD });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return b;
}

test("module gate real: un Pro sin agente recibe 403 module_not_in_plan en /whatsapp/* y /push/*; el Básico pasa", async () => {
  const noAgent = await ownerOf((await createTestBusiness(db, { plan: "pro", extraModules: { ...PRO_WITHOUT_AGENT } })).businessId);
  for (const path of ["/whatsapp/conversations", "/whatsapp/summary", "/whatsapp/settings", "/whatsapp/channels", "/push/public-key"]) {
    const res = await noAgent.get(`${API}${path}`);
    assert.equal(res.status, 403, `${path}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.code, "module_not_in_plan", path);
  }
  const write = await noAgent.patch(`${API}/whatsapp/settings`, { register: "tu" });
  assert.equal(write.body.code, "module_not_in_plan");

  const basic = await ownerOf((await createTestBusiness(db, { plan: "basic", locations: ["Central"] })).businessId);
  for (const path of ["/whatsapp/conversations", "/whatsapp/settings", "/push/public-key"]) {
    const res = await basic.get(`${API}${path}`);
    assert.equal(res.status, 200, `${path}: ${JSON.stringify(res.body)}`);
  }
});

test("uso del agente: me.plan.usage.aiConversations y el superadmin reflejan ai_usage_monthly; sin WhatsApp conectado, null", async () => {
  const biz = await createTestBusiness(db, { plan: "basic", locations: ["Central"] });
  await createChannel(db, biz.businessId);
  const owner = await ownerOf(biz.businessId);

  // Con el número conectado y sin actividad en el mes: se mide, en cero.
  assert.equal((await owner.get(`${API}/auth/me`)).body.data.plan.usage.aiConversations, 0);

  // El mes de los planes es el de Costa Rica: el uso se anota a mitad de ese mes.
  const month = monthIn(new Date(), "America/Costa_Rica");
  const midMonth = new Date(`${month}-15T18:00:00Z`);
  await incrementAiUsage(db, biz.businessId, { conversationsStarted: 3, messagesIn: 9, costMicros: 42_000 }, midMonth);
  const me = (await owner.get(`${API}/auth/me`)).body.data;
  assert.equal(me.plan.usage.month, month);
  assert.equal(me.plan.usage.aiConversations, 3);
  assert.equal(me.plan.limits.aiConversations, PLANS.basic.limits.aiConversations);

  const detail = (await (await admin()).get(`${API}/admin/businesses/${biz.businessId}`)).body.data;
  assert.equal(detail.usage.aiConversations, 3);

  // Un negocio sin WhatsApp conectado: todavía no se mide.
  const other = await ownerOf((await createTestBusiness(db, { plan: "basic", locations: ["Central"] })).businessId);
  assert.equal((await other.get(`${API}/auth/me`)).body.data.plan.usage.aiConversations, null);
});
