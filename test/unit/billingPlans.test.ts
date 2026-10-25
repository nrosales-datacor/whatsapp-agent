import assert from "node:assert/strict";
import { test } from "node:test";
import type { Business } from "../../src/modules/business";
import {
  buildPlans,
  createPlanService,
  ExtraModulesSchema,
  MODULES,
  monthIn,
  normalizeExtraModules,
  PLANS,
  PRO_WITHOUT_AGENT,
  readExtraModules,
  resolveEntitlements,
} from "../../src/modules/billing";
import type { Executor } from "../../src/platform/db/scope";

// ─────────────────────────────────────────────────────────────────────────────
// Catálogo de planes (PLAN-GESTION.md §5) y su resolución, sin base: qué trae cada plan,
// los overrides de `extra_modules` (sumar, apagar, cupos contratados), la lectura tolerante
// de lo guardado, `moduleGate` por plan, los topes del agente (`getAiLimits`) y el chequeo
// de la cola para un negocio pausado.
// ─────────────────────────────────────────────────────────────────────────────

type Row = Pick<Business, "plan" | "extraModules" | "status" | "billingStatus">;

function row(overrides: Partial<Row> = {}): Row {
  return { plan: "basic", extraModules: {}, status: "active", billingStatus: "trial", ...overrides };
}

/** Negocio completo para el servicio (con `loadBusiness` inyectado: sin base). */
function business(id: string, overrides: Partial<Business> = {}): Business {
  return { id, timezone: "America/Costa_Rica", ...row(), ...overrides } as Business;
}

function serviceWith(rows: Record<string, Business>, options: { jobsAllowedWhilePaused?: string[] } = {}) {
  return createPlanService({} as Executor, { loadBusiness: async (id) => rows[id] ?? null, ...options });
}

test("catálogo: Básico = agenda, clientes (nivel básico) y WhatsApp; 1 sucursal, 3 profesionales, 2 usuarios, 500 conversaciones", () => {
  const basic = PLANS.basic;
  assert.deepEqual([...basic.modules], ["scheduling", "clients", "whatsapp"]);
  assert.equal(basic.clientsTier, "basic");
  assert.deepEqual([...basic.features], [], "sin marca propia");
  assert.equal(basic.limits.locations, 1);
  assert.equal(basic.limits.staff, 3);
  assert.equal(basic.limits.users, 2);
  assert.equal(buildPlans({}).basic.limits.aiConversations, 500, "default sin env");
});

test("catálogo: Pro = todos los módulos, CRM completo, marca propia y crecimiento del agente; tope de conversaciones mayor que el Básico", () => {
  const pro = PLANS.pro;
  assert.deepEqual([...pro.modules], [...MODULES]);
  assert.deepEqual([...MODULES], ["scheduling", "clients", "sales", "commissions", "reports", "whatsapp", "campaigns"]);
  assert.equal(pro.clientsTier, "full");
  assert.deepEqual([...pro.features], ["branding", "reviews", "quote_recovery", "upsell"]);
  const defaults = buildPlans({});
  assert.ok((defaults.pro.limits.aiConversations ?? 0) > (defaults.basic.limits.aiConversations ?? 0));
  assert.ok((defaults.pro.limits.aiLlmUsd ?? 0) > (defaults.basic.limits.aiLlmUsd ?? 0));
});

test("catálogo: los topes del agente salen del entorno; un valor inválido cae al default", () => {
  const plans = buildPlans({ PLAN_BASIC_AI_CONVERSATIONS: "800", PLAN_PRO_AI_CONVERSATIONS: "x", PLAN_BASIC_AI_LLM_USD: "12.5", PLAN_PRO_AI_LLM_USD: "-3" });
  assert.equal(plans.basic.limits.aiConversations, 800);
  assert.equal(plans.pro.limits.aiConversations, 3000);
  assert.equal(plans.basic.limits.aiLlmUsd, 12.5);
  assert.equal(plans.pro.limits.aiLlmUsd, 40);
});

test("entitlements: Básico tal cual, Básico + campañas y cupos contratados (null = sin tope)", () => {
  const plain = resolveEntitlements(row());
  assert.equal(plain.label, "Básico");
  assert.deepEqual(plain.modules, ["scheduling", "clients", "whatsapp"]);

  const extra = resolveEntitlements(row({ extraModules: { modules: { campaigns: true }, limits: { staff: 5, aiConversations: null } } }));
  assert.deepEqual(extra.modules, ["scheduling", "clients", "whatsapp", "campaigns"], "orden del catálogo");
  assert.equal(extra.limits.staff, 5);
  assert.equal(extra.limits.aiConversations, null);
  assert.equal(extra.limits.locations, 1, "lo que no se contrató sale del plan");
  assert.equal(extra.clientsTier, "basic");
});

test("entitlements: Pro sin agente = Pro con whatsapp apagado; un plan desconocido cae al Básico, nunca a más", () => {
  const noAgent = resolveEntitlements(row({ plan: "pro", extraModules: PRO_WITHOUT_AGENT }));
  assert.equal(noAgent.label, "Pro sin agente");
  assert.ok(!noAgent.modules.includes("whatsapp"));
  assert.ok(noAgent.modules.includes("scheduling"), "la agenda (y sus recordatorios) sigue");
  assert.ok(noAgent.modules.includes("sales"));
  assert.deepEqual(noAgent.features, ["branding"], "reseñas, rescate y upsell son del agente: sin él no aplican");

  const weird = resolveEntitlements(row({ plan: "enterprise" }));
  assert.equal(weird.plan, "basic");
});

test("extra_modules: la API valida estricto; lo guardado se lee tolerante (lo inválido se ignora)", () => {
  assert.ok(ExtraModulesSchema.safeParse({ modules: { campaigns: true }, limits: { staff: 4 } }).success);
  assert.ok(!ExtraModulesSchema.safeParse({ modules: { inventado: true } }).success, "módulo desconocido");
  assert.ok(!ExtraModulesSchema.safeParse({ limits: { staff: -1 } }).success, "cupo negativo");
  assert.ok(!ExtraModulesSchema.safeParse({ limits: { locations: 0 } }).success, "al menos una sucursal");
  assert.ok(!ExtraModulesSchema.safeParse({ otra: 1 }).success, "clave de más");

  assert.deepEqual(readExtraModules({ modules: { campaigns: true, inventado: true, sales: "sí" }, limits: { staff: 4, users: -2, locations: null } }), {
    modules: { campaigns: true },
    limits: { staff: 4, locations: null },
  });
  assert.deepEqual(readExtraModules(null), { modules: {}, limits: {} });
  assert.deepEqual(readExtraModules("basura"), { modules: {}, limits: {} });
});

test("extra_modules: se normaliza contra el plan (sumar lo que ya trae o apagar lo que no trae no se guarda)", () => {
  assert.deepEqual(normalizeExtraModules("pro", { modules: { campaigns: true, whatsapp: false } }), { modules: { whatsapp: false } });
  assert.deepEqual(normalizeExtraModules("basic", { modules: { campaigns: true, sales: false } }), { modules: { campaigns: true } });
  assert.deepEqual(normalizeExtraModules("basic", { modules: {}, limits: {} }), {});
  assert.deepEqual(normalizeExtraModules("pro", { limits: { staff: 5, aiConversations: null } }), { limits: { staff: 5, aiConversations: null } }, "lo contratado se guarda tal cual");
});

test("moduleGate por plan: Básico sin ventas/reportes/campañas; Pro todo; Pro sin agente sin whatsapp; negocio inexistente → no", async () => {
  const plans = serviceWith({
    b: business("b"),
    p: business("p", { plan: "pro" }),
    n: business("n", { plan: "pro", extraModules: PRO_WITHOUT_AGENT }),
    c: business("c", { extraModules: { modules: { campaigns: true } } }),
  });
  for (const m of ["sales", "commissions", "reports", "campaigns"]) assert.equal(await plans.moduleGate("b", m), false, `básico: ${m}`);
  for (const m of ["scheduling", "clients", "whatsapp"]) assert.equal(await plans.moduleGate("b", m), true, `básico: ${m}`);
  for (const m of MODULES) assert.equal(await plans.moduleGate("p", m), true, `pro: ${m}`);
  assert.equal(await plans.moduleGate("n", "whatsapp"), false);
  assert.equal(await plans.moduleGate("n", "reports"), true);
  assert.equal(await plans.moduleGate("c", "campaigns"), true, "Básico + campañas");
  assert.equal(await plans.moduleGate("x", "scheduling"), false);
  assert.equal(await plans.moduleGate("p", "inventado"), false);
  assert.deepEqual(await plans.enabledModules("b"), ["scheduling", "clients", "whatsapp"]);
  assert.equal(await plans.hasFeature("b", "branding"), false);
  assert.equal(await plans.hasFeature("p", "branding"), true);
});

test("getPlanLimits y cupos: los del plan con lo contratado encima", async () => {
  const plans = serviceWith({ p: business("p", { plan: "pro", extraModules: { limits: { locations: 3, users: null } } }) });
  const limits = await plans.getPlanLimits("p");
  assert.equal(limits?.locations, 3);
  assert.equal(limits?.staff, PLANS.pro.limits.staff);
  assert.equal(limits?.users, null);
  assert.equal(await plans.quota("p", "locations"), 3);
  assert.equal(await plans.quota("p", "users"), null);
  assert.equal(await plans.getPlanLimits("x"), null);
});

test("getAiLimits: topes por plan (gasto en millonésimos), overrides por negocio y agente apagado si pausado o sin módulo", async () => {
  const plans = serviceWith({
    b: business("b"),
    o: business("o", { extraModules: { limits: { aiConversations: 1200, aiLlmUsd: 0.5 } } }),
    n: business("n", { plan: "pro", extraModules: PRO_WITHOUT_AGENT }),
    z: business("z", { status: "paused" }),
    u: business("u", { plan: "pro", extraModules: { limits: { aiConversations: null, aiLlmUsd: null } } }),
  });
  const basic = await plans.getAiLimits("b");
  assert.equal(basic.agentEnabled, true);
  assert.equal(basic.disabledReason, null);
  assert.equal(basic.monthlyConversations, PLANS.basic.limits.aiConversations);
  assert.equal(basic.monthlyLlmCostUsdMicros, Math.round((PLANS.basic.limits.aiLlmUsd ?? 0) * 1_000_000));

  const custom = await plans.getAiLimits("o");
  assert.equal(custom.monthlyConversations, 1200);
  assert.equal(custom.monthlyLlmCostUsdMicros, 500_000);

  assert.deepEqual([(await plans.getAiLimits("n")).agentEnabled, (await plans.getAiLimits("n")).disabledReason], [false, "module_not_in_plan"]);
  assert.deepEqual([(await plans.getAiLimits("z")).agentEnabled, (await plans.getAiLimits("z")).disabledReason], [false, "business_paused"]);
  assert.equal((await plans.getAiLimits("x")).disabledReason, "business_not_found");
  const unlimited = await plans.getAiLimits("u");
  assert.equal(unlimited.monthlyConversations, null);
  assert.equal(unlimited.monthlyLlmCostUsdMicros, null);
});

test("cola: un negocio pausado no corre trabajo (salvo los tipos permitidos); uno activo o inexistente sí", async () => {
  const plans = serviceWith({ a: business("a"), z: business("z", { status: "paused" }) }, { jobsAllowedWhilePaused: ["whatsapp.inbound"] });
  assert.equal(await plans.canRunJob("a", "email.send"), true);
  assert.equal(await plans.canRunJob("z", "email.send"), false);
  assert.equal(await plans.canRunJob("z", "whatsapp.inbound"), true);
  assert.equal(await plans.canRunJob("x", "email.send"), true, "inexistente: decide el handler");
});

test("caché: resolver el plan de la misma fila no vuelve a calcular (memo por fila)", async () => {
  const rowB = business("b", { extraModules: { modules: { campaigns: true } } });
  let loads = 0;
  const plans = createPlanService({} as Executor, { loadBusiness: async () => (loads++, rowB) });
  const first = await plans.resolve("b");
  const second = await plans.resolve("b");
  assert.equal(loads, 2, "la fila sale del caché del contexto en cada llamada");
  assert.equal(first, second, "lo resuelto es el mismo objeto");
});

test("mes del uso: en la zona del negocio (el 1.º a las 00:30 de Costa Rica ya es el mes nuevo)", () => {
  assert.equal(monthIn(new Date("2026-11-01T06:30:00Z"), "America/Costa_Rica"), "2026-11");
  assert.equal(monthIn(new Date("2026-11-01T05:30:00Z"), "America/Costa_Rica"), "2026-10");
  assert.equal(monthIn(new Date("2026-11-01T05:30:00Z"), "Zona/Inventada"), "2026-11", "zona inválida: UTC");
});
