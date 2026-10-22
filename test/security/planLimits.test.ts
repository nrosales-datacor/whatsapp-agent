import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { and, eq } from "drizzle-orm";

// ─────────────────────────────────────────────────────────────────────────────
// Planes y límites por HTTP (PLAN-GESTION.md §5), con la app real sobre PGlite corriendo
// como el rol de la app (`app_runtime`, sin BYPASSRLS):
//   • cupos del plan al crear o reactivar sucursales, profesionales y usuarios → 403
//     `plan_limit_reached` con un mensaje claro (y lo contratado en Pro los amplía);
//   • marca propia solo en Pro;
//   • `me` con plan, nivel de clientes, límites y uso;
//   • `moduleGate` real en el router (Básico sin ventas);
//   • negocio pausado → 403 `business_paused` en toda la API, hasta que se reactiva.
// ─────────────────────────────────────────────────────────────────────────────

process.env.TRUST_PROXY = "loopback";
process.env.PANEL_SESSION_SECRET = "test-plan-limits-secret-0123456789abcd";
process.env.TOKENS_ENCRYPTION_KEY = "e".repeat(64);
process.env.PANEL_LOGIN_RATE_LIMIT_MAX_IP = "500";
delete process.env.PLAN_BASIC_AI_CONVERSATIONS;

const { createAppHandler } = await import("../../src/app");
const { createPlanService, PLANS, PRO_WITHOUT_AGENT } = await import("../../src/modules/billing");
const { invalidateBusinessContext } = await import("../../src/modules/business");
const { businesses, locations } = await import("../../src/modules/business/schema");
const { createSessionResolver } = await import("../../src/modules/team");
const { withSystem, withTenant } = await import("../../src/platform/db/scope");
const { createRouter, route } = await import("../../src/platform/http/router");
const { createEphemeralDb } = await import("../helpers/pgliteDb");
const { Browser, startTestServer } = await import("../helpers/panelClient");
const { createTestBusiness, createTestMember, uniqueEmail } = await import("../helpers/identityFixtures");

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

async function loginOwner(businessId: string): Promise<InstanceType<typeof Browser>> {
  const member = await createTestMember(db, { businessId, role: "owner" });
  const b = new Browser(app.baseUrl);
  const res = await b.post(`${API}/auth/login`, { email: member.email, password: member.password });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return b;
}

function assertLimit(res: { status: number; body: { code?: string; error?: string } }, fragment: string): void {
  assert.equal(res.status, 403, JSON.stringify(res.body));
  assert.equal(res.body.code, "plan_limit_reached");
  assert.ok(res.body.error?.includes(fragment), `mensaje claro con el tope: ${res.body.error}`);
  assert.match(res.body.error ?? "", /ampliá tu plan/);
}

async function setBusinessStatus(businessId: string, status: "active" | "paused"): Promise<void> {
  await withSystem(db, (tx) => tx.update(businesses).set({ status }).where(eq(businesses.id, businessId)));
  invalidateBusinessContext(businessId);
}

test("sucursales: el Básico tiene 1 activa (crear o reactivar otra → 403); en Pro manda lo contratado", async () => {
  const basic = await createTestBusiness(db, { plan: "basic", locations: ["Central", "Vieja"] });
  await withTenant(db, basic.businessId, (tx) =>
    tx.update(locations).set({ active: false }).where(and(eq(locations.id, basic.locationIds[1]), eq(locations.businessId, basic.businessId))),
  );
  invalidateBusinessContext(basic.businessId);
  const owner = await loginOwner(basic.businessId);

  assertLimit(await owner.post(`${API}/settings/locations`, { name: "Norte" }), "1 sucursal activa");
  assertLimit(await owner.patch(`${API}/settings/locations/${basic.locationIds[1]}`, { active: true }), "1 sucursal activa");
  assert.equal((await owner.patch(`${API}/settings/locations/${basic.locationIds[1]}`, { name: "Vieja (cerrada)" })).status, 200, "editar una inactiva no suma");

  const pro = await createTestBusiness(db, { plan: "pro", extraModules: { limits: { locations: 2 } } });
  const proOwner = await loginOwner(pro.businessId);
  assertLimit(await proOwner.post(`${API}/settings/locations`, { name: "Sur" }), "2 sucursales activas");

  const contracted = await createTestBusiness(db, { plan: "pro", extraModules: { limits: { locations: 3 } } });
  const contractedOwner = await loginOwner(contracted.businessId);
  assert.equal((await contractedOwner.post(`${API}/settings/locations`, { name: "Sur" })).status, 201);
  assertLimit(await contractedOwner.post(`${API}/settings/locations`, { name: "Oeste" }), "3 sucursales activas");
});

test("profesionales: el Básico tiene 3 activos; el 4.º o reactivar a uno inactivo → 403; uno inactivo sí se crea", async () => {
  const biz = await createTestBusiness(db, { plan: "basic", locations: ["Central"] });
  const owner = await loginOwner(biz.businessId);
  const ids: string[] = [];
  for (const name of ["Ana", "Beto", "Caro"]) {
    const res = await owner.post(`${API}/settings/staff`, { name });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    ids.push(res.body.data.id);
  }
  assertLimit(await owner.post(`${API}/settings/staff`, { name: "Dani" }), "3 profesionales activos");

  const inactive = await owner.post(`${API}/settings/staff`, { name: "Eli", active: false });
  assert.equal(inactive.status, 201, "un profesional inactivo no ocupa lugar");
  assertLimit(await owner.patch(`${API}/settings/staff/${inactive.body.data.id}`, { active: true }), "3 profesionales activos");
  assert.equal((await owner.patch(`${API}/settings/staff/${ids[0]}`, { name: "Ana María", active: true })).status, 200, "uno ya activo no suma");

  // Liberar un lugar (sin historial: se borra) deja reactivar.
  assert.equal((await owner.request("DELETE", `${API}/settings/staff/${ids[2]}`)).status, 200);
  assert.equal((await owner.patch(`${API}/settings/staff/${inactive.body.data.id}`, { active: true })).status, 200);
});

test("profesionales: dos altas simultáneas con un solo lugar libre → entra una sola", async () => {
  const biz = await createTestBusiness(db, { plan: "basic", locations: ["Central"] });
  const owner = await loginOwner(biz.businessId);
  for (const name of ["Ana", "Beto"]) assert.equal((await owner.post(`${API}/settings/staff`, { name })).status, 201);
  const results = await Promise.all([owner.post(`${API}/settings/staff`, { name: "Caro" }), owner.post(`${API}/settings/staff`, { name: "Dani" })]);
  assert.deepEqual(results.map((r) => r.status).sort(), [201, 403]);
});

test("usuarios: el Básico tiene 2 (dueño + 1); reenviar una invitación no ocupa otro lugar; reactivar pasando el tope → 403", async () => {
  const biz = await createTestBusiness(db, { plan: "basic", locations: ["Central"] });
  const owner = await loginOwner(biz.businessId);
  const deskEmail = uniqueEmail("recepcion");
  const invited = await owner.post(`${API}/team/invitations`, { email: deskEmail, role: "front_desk" });
  assert.equal(invited.status, 201, JSON.stringify(invited.body));
  assert.equal((await owner.post(`${API}/team/invitations`, { email: deskEmail, role: "front_desk" })).status, 201, "reenvío: mismo lugar");
  assertLimit(await owner.post(`${API}/team/invitations`, { email: uniqueEmail("otra"), role: "staff" }), "2 usuarios");

  const membershipId = invited.body.data.membershipId;
  assert.equal((await owner.patch(`${API}/team/members/${membershipId}`, { active: false })).status, 200);
  assert.equal((await owner.post(`${API}/team/invitations`, { email: uniqueEmail("nueva"), role: "staff" })).status, 201, "el lugar liberado se usa");
  assertLimit(await owner.patch(`${API}/team/members/${membershipId}`, { active: true }), "2 usuarios");
});

test("marca propia: solo en Pro (el Básico la ve deshabilitada y el PATCH → 403); la guardada vuelve al pasar a Pro", async () => {
  const basic = await createTestBusiness(db, { plan: "basic", locations: ["Central"], branding: { accentColor: "#654321" } });
  const owner = await loginOwner(basic.businessId);
  const settings = await owner.get(`${API}/settings/business`);
  assert.equal(settings.body.data.brandingEditable, false);
  const denied = await owner.patch(`${API}/settings/business`, { branding: { accentColor: "#000000" } });
  assert.equal(denied.status, 403);
  assert.equal(denied.body.code, "module_not_in_plan");
  assert.equal((await owner.patch(`${API}/settings/business`, { name: "Otro nombre" })).status, 200, "el resto sí se edita");
  assert.deepEqual((await owner.get(`${API}/auth/me`)).body.data.business.branding, {}, "el panel no aplica la marca de un Básico");

  await withSystem(db, (tx) => tx.update(businesses).set({ plan: "pro" }).where(eq(businesses.id, basic.businessId)));
  invalidateBusinessContext(basic.businessId);
  assert.deepEqual((await owner.get(`${API}/auth/me`)).body.data.business.branding, { accentColor: "#654321" });
  assert.equal((await owner.get(`${API}/settings/business`)).body.data.brandingEditable, true);
  assert.equal((await owner.patch(`${API}/settings/business`, { branding: { accentColor: "#000000" } })).status, 200);
});

test("me: plan, nivel de clientes, módulos, límites y uso del mes (sin el tope interno de gasto)", async () => {
  const basic = await createTestBusiness(db, { plan: "basic", locations: ["Central"] });
  const owner = await loginOwner(basic.businessId);
  assert.equal((await owner.post(`${API}/settings/staff`, { name: "Ana" })).status, 201);
  const me = (await owner.get(`${API}/auth/me`)).body.data;
  assert.equal(me.business.plan, "basic");
  assert.equal(me.plan.id, "basic");
  assert.equal(me.plan.label, "Básico");
  assert.equal(me.plan.clientsTier, "basic");
  assert.deepEqual(me.plan.modules, ["scheduling", "clients", "whatsapp"]);
  assert.deepEqual(me.modules, me.plan.modules);
  assert.deepEqual(me.plan.features, []);
  assert.equal(me.plan.billingStatus, "trial");
  assert.deepEqual(me.plan.limits, { locations: 1, staff: 3, users: 2, aiConversations: PLANS.basic.limits.aiConversations });
  assert.equal(me.plan.usage.locations, 1);
  assert.equal(me.plan.usage.staff, 1);
  assert.equal(me.plan.usage.users, 1);
  assert.equal(me.plan.usage.aiConversations, null, "sin módulo WhatsApp todavía no se mide");
  assert.match(me.plan.usage.month, /^\d{4}-\d{2}$/);
  assert.ok(!("aiLlmUsd" in me.plan.limits));

  const noAgent = await createTestBusiness(db, { plan: "pro", extraModules: { ...PRO_WITHOUT_AGENT, limits: { staff: 12 } } });
  const proMe = (await (await loginOwner(noAgent.businessId)).get(`${API}/auth/me`)).body.data;
  assert.equal(proMe.plan.label, "Pro sin agente");
  assert.equal(proMe.plan.clientsTier, "full");
  assert.ok(!proMe.modules.includes("whatsapp"));
  assert.ok(proMe.modules.includes("reports"));
  assert.equal(proMe.plan.limits.staff, 12, "lo contratado");
});

test("moduleGate real en el router: una ruta de ventas → 403 module_not_in_plan al Básico; el Pro pasa", async () => {
  const plans = createPlanService(db);
  const probe = await startTestServer(
    createRouter({
      routes: [route({ method: "GET", path: "/probe", auth: "user", module: "sales" }, () => ({ fine: true }))],
      resolveSession: createSessionResolver(db),
      moduleGate: plans.moduleGate,
    }),
  );
  try {
    const call = async (businessId: string) => {
      const b = await loginOwner(businessId);
      const viaProbe = new Browser(probe.baseUrl, b.ip);
      for (const [k, v] of b.cookies) viaProbe.cookies.set(k, v);
      return viaProbe.get(`${API}/probe`);
    };
    const basic = await call((await createTestBusiness(db, { plan: "basic", locations: ["Central"] })).businessId);
    assert.equal(basic.status, 403);
    assert.equal(basic.body.code, "module_not_in_plan");
    assert.equal((await call((await createTestBusiness(db, { plan: "pro" })).businessId)).status, 200);
  } finally {
    await probe.close();
  }
});

test("pausa: toda la API del negocio responde 403 business_paused (también /auth/me) y vuelve al reactivar", async () => {
  const biz = await createTestBusiness(db);
  const owner = await loginOwner(biz.businessId);
  await setBusinessStatus(biz.businessId, "paused");

  for (const path of ["/auth/me", "/settings/locations", "/home/today"]) {
    const res = await owner.get(`${API}${path}`);
    assert.equal(res.status, 403, path);
    assert.equal(res.body.code, "business_paused", path);
  }
  const write = await owner.post(`${API}/settings/staff`, { name: "Ana" });
  assert.equal(write.body.code, "business_paused");
  assert.equal((await new Browser(app.baseUrl).get(`${API}/auth/me`)).status, 401, "sin sesión sigue siendo 401");

  await setBusinessStatus(biz.businessId, "active");
  assert.equal((await owner.get(`${API}/auth/me`)).status, 200, "la misma sesión vuelve a servir");
});
