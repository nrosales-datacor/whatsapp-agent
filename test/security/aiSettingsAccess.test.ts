import assert from "node:assert/strict";
import { after, before, test } from "node:test";

// ─────────────────────────────────────────────────────────────────────────────
// Permisos de WhatsApp IA > Configuración del bot (`/whatsapp/settings`) por HTTP, con la
// app real sobre PGlite y el rol de la app (`app_runtime`, sin BYPASSRLS):
//   • todos los roles leen; solo dueño y administración editan (403 forbidden_role);
//   • la primera lectura trae los defaults de la plantilla del rubro;
//   • un negocio no ve ni toca la configuración de otro;
//   • una configuración cuyo prompt pasa `AGENT_MAX_SYSTEM_PROMPT_CHARS` da 422 y no se guarda.
// ─────────────────────────────────────────────────────────────────────────────

process.env.TRUST_PROXY = "loopback";
process.env.PANEL_SESSION_SECRET = "test-ai-settings-access-secret-0123456789";
process.env.TOKENS_ENCRYPTION_KEY = "d".repeat(64);
process.env.PANEL_LOGIN_RATE_LIMIT_MAX_IP = "500";

const { eq } = await import("drizzle-orm");
const { createAppHandler } = await import("../../src/app");
const { withTenant } = await import("../../src/platform/db/scope");
const { businesses } = await import("../../src/modules/business/schema");
const { invalidateBusinessContext, loadIndustryTemplate } = await import("../../src/modules/business");
const { createEphemeralDb } = await import("../helpers/pgliteDb");
const { Browser, startTestServer } = await import("../helpers/panelClient");
const { createTestBusiness, createTestMember } = await import("../helpers/identityFixtures");

type Role = "owner" | "admin" | "front_desk" | "staff";

const base = await createEphemeralDb();
const { db } = base;
let app: Awaited<ReturnType<typeof startTestServer>>;

before(async () => {
  await base.client.exec("SET ROLE app_runtime");
  app = await startTestServer(createAppHandler({ db, role: "all" }));
});

after(async () => {
  await app?.close();
  await base.close();
});

const API = "/api/panel";

async function loginAs(businessId: string, role: Role): Promise<InstanceType<typeof Browser>> {
  const member = await createTestMember(db, { businessId, role });
  const b = new Browser(app.baseUrl);
  const res = await b.post(`${API}/auth/login`, { email: member.email, password: member.password });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return b;
}

async function dentalBusiness(): Promise<string> {
  const { businessId } = await createTestBusiness(db);
  await withTenant(db, businessId, (tx) => tx.update(businesses).set({ industry: "dental" }).where(eq(businesses.id, businessId)));
  invalidateBusinessContext(businessId);
  return businessId;
}

test("GET /whatsapp/settings: cualquier rol lee, con los defaults de la plantilla del rubro", async () => {
  const businessId = await dentalBusiness();
  for (const role of ["owner", "admin", "front_desk", "staff"] as const) {
    const b = await loginAs(businessId, role);
    const res = await b.get(`${API}/whatsapp/settings`);
    assert.equal(res.status, 200, `${role}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.data.register, "usted");
    assert.equal(res.body.data.instructions, loadIndustryTemplate("dental").ai.instructions);
    assert.deepEqual(Object.keys(res.body.data).sort(), ["faq", "instructions", "knowledge", "register", "texts", "tone"]);
  }
});

test("PATCH /whatsapp/settings: dueño y admin editan; recepción y profesional reciben 403", async () => {
  const businessId = await dentalBusiness();
  for (const role of ["front_desk", "staff"] as const) {
    const b = await loginAs(businessId, role);
    const res = await b.patch(`${API}/whatsapp/settings`, { tone: "seco" });
    assert.equal(res.status, 403, `${role}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.code, "forbidden_role");
  }
  for (const [role, tone] of [
    ["owner", "amable"],
    ["admin", "profesional"],
  ] as const) {
    const b = await loginAs(businessId, role);
    const res = await b.patch(`${API}/whatsapp/settings`, { tone, faq: [{ question: "¿Parqueo?", answer: "Sí." }] });
    assert.equal(res.status, 200, `${role}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.data.tone, tone);
  }
  const owner = await loginAs(businessId, "owner");
  const bad = await owner.patch(`${API}/whatsapp/settings`, { register: "vosotros" });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.code, "validation_error");
  assert.ok(bad.body.fields["body.register"]);
});

test("/whatsapp/settings: un negocio no ve la configuración de otro", async () => {
  const a = await dentalBusiness();
  const { businessId: b } = await createTestBusiness(db);
  const ownerA = await loginAs(a, "owner");
  assert.equal((await ownerA.patch(`${API}/whatsapp/settings`, { instructions: "Solo de A" })).status, 200);
  const ownerB = await loginAs(b, "owner");
  const res = await ownerB.get(`${API}/whatsapp/settings`);
  assert.equal(res.status, 200);
  assert.notEqual(res.body.data.instructions, "Solo de A");
  assert.equal(res.body.data.instructions, loadIndustryTemplate("generic").ai.instructions);
});

test("PATCH /whatsapp/settings: si el prompt resultante pasa el presupuesto → 422 prompt_too_long y no se guarda nada", async () => {
  const saved = process.env.AGENT_MAX_SYSTEM_PROMPT_CHARS;
  const setBudget = (n: number) => {
    process.env.AGENT_MAX_SYSTEM_PROMPT_CHARS = String(n);
  };
  try {
    const businessId = await dentalBusiness();
    const owner = await loginAs(businessId, "owner");
    // 24 ítems de 480 caracteres ≈ 11 500: dentro del tope propio del conocimiento (12 000)
    // pero, con el resto del prompt, por encima de un presupuesto de 8000.
    const knowledge = [{ title: "Detalle", items: Array.from({ length: 24 }, (_, i) => `${i} ${"dato largo ".repeat(48)}`.slice(0, 480)) }];
    setBudget(8000);
    const before = (await owner.get(`${API}/whatsapp/settings`)).body.data;
    const rejected = await owner.patch(`${API}/whatsapp/settings`, { knowledge });
    assert.equal(rejected.status, 422, JSON.stringify(rejected.body));
    assert.equal(rejected.body.code, "prompt_too_long");
    assert.match(rejected.body.error, /demasiado larga.*8\s?000/);
    assert.deepEqual((await owner.get(`${API}/whatsapp/settings`)).body.data, before, "la transacción se deshizo");

    // Con presupuesto holgado se guarda; si después el tope baja, un cambio que no alarga el
    // prompt pasa (el dueño puede acortar) y uno que lo alarga, no.
    setBudget(200_000);
    assert.equal((await owner.patch(`${API}/whatsapp/settings`, { knowledge })).status, 200);
    setBudget(8000);
    const shorter = await owner.patch(`${API}/whatsapp/settings`, { knowledge: [{ title: "Detalle", items: knowledge[0].items.slice(0, 20) }] });
    assert.equal(shorter.status, 200, JSON.stringify(shorter.body));
    const longer = await owner.patch(`${API}/whatsapp/settings`, { faq: [{ question: "¿Parqueo?", answer: "Sí, gratis." }] });
    assert.equal(longer.status, 422);
    assert.equal(longer.body.code, "prompt_too_long");
  } finally {
    if (saved === undefined) delete process.env.AGENT_MAX_SYSTEM_PROMPT_CHARS;
    else process.env.AGENT_MAX_SYSTEM_PROMPT_CHARS = saved;
  }
});
