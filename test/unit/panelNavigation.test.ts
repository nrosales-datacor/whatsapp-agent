import assert from "node:assert/strict";
import { test } from "node:test";
import {
  accessFor,
  getSection,
  homePathFor,
  navItemsFor,
  roleLabel,
  SETTINGS_PAGES,
  terminologyOf,
  type Access,
  type SectionId,
} from "../../web/src/app/navigation";
import { DEFAULT_TERMINOLOGY, type Me, type Plan, type Role } from "../../web/src/lib/contract";
import { PLAN_MODULES } from "../../web/src/lib/plans";

// ─────────────────────────────────────────────────────────────────────────────
// Menú del panel y acceso por rol × plan (web/src/app/navigation.ts): qué secciones ve
// cada sesión, cuáles con candado (upsell del Pro) y adónde cae "/". Un error acá muestra
// secciones a quien no corresponde (el backend igual rechaza, pero la UX se rompe).
// Sin DOM ni red.
// ─────────────────────────────────────────────────────────────────────────────

type PlanCase = "basic" | "pro" | "pro_no_agent" | "basic_plus_campaigns";

/** Lo que el backend manda en `me` para cada variante de plan (src/modules/billing/catalog.ts). */
const PLAN_CASES: Record<PlanCase, { plan: Plan; modules: string[]; clientsTier: "basic" | "full" }> = {
  basic: { plan: "basic", modules: [...PLAN_MODULES.basic], clientsTier: "basic" },
  pro: { plan: "pro", modules: [...PLAN_MODULES.pro], clientsTier: "full" },
  pro_no_agent: { plan: "pro", modules: PLAN_MODULES.pro.filter((m) => m !== "whatsapp"), clientsTier: "full" },
  basic_plus_campaigns: { plan: "basic", modules: [...PLAN_MODULES.basic, "campaigns"], clientsTier: "basic" },
};

function meFor(role: Role, planCase: PlanCase, terminology: Me["business"]["terminology"] = {}): Me {
  const { plan, modules, clientsTier } = PLAN_CASES[planCase];
  return {
    user: { id: "u1", name: "Ana", email: "ana@example.com", mustChangePassword: false, totpEnabled: false },
    business: {
      id: "b1",
      name: "Clínica Sonrisa",
      slug: "clinica-sonrisa",
      plan,
      industry: "dental",
      currency: "CRC",
      timezone: "America/Costa_Rica",
      terminology,
      branding: {},
    },
    role,
    locations: [{ id: "l1", name: "Central" }],
    allLocations: true,
    memberships: [],
    modules,
    plan: {
      id: plan,
      label: plan === "pro" ? "Pro" : "Básico",
      clientsTier,
      modules,
      features: [],
      billingStatus: "active",
      limits: { locations: 1, staff: 3, users: 3, aiConversations: 500 },
      usage: { month: "2026-10", locations: 1, staff: 1, users: 1, aiConversations: 0 },
    },
    staffId: role === "staff" ? "s1" : null,
  };
}

/** Menú esperado: sección → acceso ("open" o "locked"); lo que no está, oculto. */
type Menu = Partial<Record<SectionId, Exclude<Access, "hidden">>>;

const EXPECTED: Record<PlanCase, Record<Role, Menu>> = {
  basic: {
    owner: { home: "open", agenda: "open", clients: "open", sales: "locked", reports: "locked", whatsapp: "open", campaigns: "locked", settings: "open" },
    admin: { home: "open", agenda: "open", clients: "open", sales: "locked", reports: "locked", whatsapp: "open", campaigns: "locked", settings: "open" },
    front_desk: { home: "open", agenda: "open", clients: "open", sales: "locked", whatsapp: "open", settings: "open" },
    staff: { agenda: "open", clients: "open", sales: "locked" },
  },
  pro: {
    owner: { home: "open", agenda: "open", clients: "open", sales: "open", reports: "open", whatsapp: "open", campaigns: "open", settings: "open" },
    admin: { home: "open", agenda: "open", clients: "open", sales: "open", reports: "open", whatsapp: "open", campaigns: "open", settings: "open" },
    front_desk: { home: "open", agenda: "open", clients: "open", sales: "open", whatsapp: "open", settings: "open" },
    staff: { agenda: "open", clients: "open", sales: "open" },
  },
  // Pro sin agente: WhatsApp IA no es un upsell → oculto, no con candado.
  pro_no_agent: {
    owner: { home: "open", agenda: "open", clients: "open", sales: "open", reports: "open", campaigns: "open", settings: "open" },
    admin: { home: "open", agenda: "open", clients: "open", sales: "open", reports: "open", campaigns: "open", settings: "open" },
    front_desk: { home: "open", agenda: "open", clients: "open", sales: "open", settings: "open" },
    staff: { agenda: "open", clients: "open", sales: "open" },
  },
  // Básico con Campañas contratada como extra: se abre sin pasar al Pro.
  basic_plus_campaigns: {
    owner: { home: "open", agenda: "open", clients: "open", sales: "locked", reports: "locked", whatsapp: "open", campaigns: "open", settings: "open" },
    admin: { home: "open", agenda: "open", clients: "open", sales: "locked", reports: "locked", whatsapp: "open", campaigns: "open", settings: "open" },
    front_desk: { home: "open", agenda: "open", clients: "open", sales: "locked", whatsapp: "open", settings: "open" },
    staff: { agenda: "open", clients: "open", sales: "locked" },
  },
};

const ROLES: Role[] = ["owner", "admin", "front_desk", "staff"];

test("menú: matriz rol × plan — qué se ve, qué va con candado y qué se oculta", () => {
  for (const planCase of Object.keys(EXPECTED) as PlanCase[]) {
    for (const role of ROLES) {
      const me = meFor(role, planCase);
      const menu = Object.fromEntries(navItemsFor(me).map((item) => [item.section.id, item.access]));
      assert.deepEqual(menu, EXPECTED[planCase][role], `${planCase} × ${role}`);
    }
  }
});

test("menú: los ítems salen en el orden de SECTIONS y accessFor coincide con navItemsFor", () => {
  const me = meFor("owner", "pro");
  assert.deepEqual(
    navItemsFor(me).map((item) => item.section.id),
    ["home", "agenda", "clients", "sales", "reports", "whatsapp", "campaigns", "settings"],
  );
  for (const planCase of Object.keys(PLAN_CASES) as PlanCase[]) {
    for (const role of ROLES) {
      const m = meFor(role, planCase);
      for (const item of navItemsFor(m)) assert.equal(accessFor(m, item.section), item.access);
    }
  }
});

test("menú: el profesional ve Mis comisiones (módulo commissions), no Ventas", () => {
  // Un Pro al que le apagaron Comisiones pero conserva Ventas: el profesional no ve la sección.
  const me = meFor("staff", "pro");
  me.modules = me.modules.filter((m) => m !== "commissions");
  assert.equal(accessFor(me, getSection("sales")), "hidden", "en el Pro, lo que falta no se ofrece con candado");
  assert.equal(accessFor(meFor("owner", "pro"), getSection("sales")), "open");

  const labels = Object.fromEntries(navItemsFor(meFor("staff", "pro")).map((item) => [item.section.id, item.label]));
  assert.deepEqual(labels, { agenda: "Mi agenda", clients: "Mis clientes", sales: "Mis comisiones" });
});

test("menú: en el Pro, un módulo apagado se oculta (no hay a qué plan subir)", () => {
  const me = meFor("owner", "pro");
  me.modules = me.modules.filter((m) => m !== "campaigns" && m !== "reports");
  const ids = navItemsFor(me).map((item) => item.section.id);
  assert.ok(!ids.includes("campaigns") && !ids.includes("reports"), ids.join(","));
});

test("menú: los rótulos usan la terminología del negocio", () => {
  const dental = { client: "paciente", clients: "pacientes", staffMember: "doctora", staff: "doctoras" };
  const owner = Object.fromEntries(navItemsFor(meFor("owner", "pro", dental)).map((i) => [i.section.id, i.label]));
  assert.equal(owner.clients, "Pacientes");
  assert.equal(owner.agenda, "Agenda");
  assert.equal(owner.sales, "Ventas");
  const staff = Object.fromEntries(navItemsFor(meFor("staff", "pro", dental)).map((i) => [i.section.id, i.label]));
  assert.equal(staff.clients, "Mis pacientes");
  assert.equal(roleLabel("staff", terminologyOf(meFor("staff", "pro", dental))), "Doctora");
  assert.equal(roleLabel("front_desk", DEFAULT_TERMINOLOGY), "Recepción");
});

test("inicio: '/' para quien tiene Inicio; el profesional cae en su agenda", () => {
  for (const planCase of Object.keys(PLAN_CASES) as PlanCase[]) {
    assert.equal(homePathFor(meFor("owner", planCase)), "/", planCase);
    assert.equal(homePathFor(meFor("admin", planCase)), "/", planCase);
    assert.equal(homePathFor(meFor("front_desk", planCase)), "/", planCase);
    assert.equal(homePathFor(meFor("staff", planCase)), "/agenda", planCase);
  }
  // Sin ninguna sección abierta (rol desconocido de una versión nueva del backend): /agenda.
  assert.equal(homePathFor(meFor("intern" as Role, "pro")), "/agenda");
  assert.deepEqual(navItemsFor(meFor("intern" as Role, "pro")), []);
});

test("configuración: páginas por rol y plan (CRM completo y Ventas solo en el Pro, con candado en Básico)", () => {
  const pages = (role: Role, planCase: PlanCase) =>
    Object.fromEntries(
      SETTINGS_PAGES.map((page) => [page.slug, accessFor(meFor(role, planCase), page)]).filter(([, access]) => access !== "hidden"),
    );
  assert.deepEqual(pages("owner", "basic"), {
    business: "open",
    locations: "open",
    services: "open",
    team: "open",
    "custom-fields": "locked",
    "client-rules": "locked",
    "payment-methods": "locked",
    users: "open",
    plan: "open",
  });
  assert.deepEqual(pages("owner", "pro"), {
    business: "open",
    locations: "open",
    services: "open",
    team: "open",
    "custom-fields": "open",
    "client-rules": "open",
    "payment-methods": "open",
    users: "open",
    plan: "open",
  });
  const adminPro = pages("admin", "pro");
  assert.equal(adminPro.plan, undefined, "el Plan es solo del dueño");
  assert.equal(adminPro.users, "open");
  assert.deepEqual(pages("front_desk", "pro"), { business: "open", locations: "open", services: "open", team: "open" });
  assert.deepEqual(pages("staff", "pro"), {});
});

test("terminologyOf: completa con los defaults y descarta valores vacíos o que no son texto", () => {
  assert.deepEqual(terminologyOf(meFor("owner", "basic")), DEFAULT_TERMINOLOGY);
  const t = terminologyOf(
    meFor("owner", "basic", {
      client: "  paciente  ",
      clients: "   ",
      staff: 42 as unknown as string,
      location: "",
    }),
  );
  assert.equal(t.client, "paciente");
  assert.equal(t.clients, DEFAULT_TERMINOLOGY.clients);
  assert.equal(t.staff, DEFAULT_TERMINOLOGY.staff);
  assert.equal(t.location, DEFAULT_TERMINOLOGY.location);
  // Sin terminología (respuesta vieja): defaults, sin romper.
  const me = meFor("owner", "basic");
  (me.business as { terminology?: unknown }).terminology = undefined;
  assert.deepEqual(terminologyOf(me), DEFAULT_TERMINOLOGY);
});

test("getSection: una sección desconocida es un error de programación", () => {
  assert.equal(getSection("reports").path, "/reports");
  assert.throws(() => getSection("nope" as SectionId), /Sección desconocida/);
});
