import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { and, eq } from "drizzle-orm";
import { loadIndustryTemplate } from "../../src/modules/business";
import { businesses } from "../../src/modules/business/schema";
import { aiSettings } from "../../src/modules/whatsapp/schema";
import { AiSettingsPatch, DEFAULT_TONE, getAiSettings, updateAiSettings } from "../../src/modules/whatsapp/settings";
import { configHistory } from "../../src/platform/db/schema";
import { withTenant } from "../../src/platform/db/scope";
import { createEphemeralDb } from "../helpers/pgliteDb";

// ─────────────────────────────────────────────────────────────────────────────
// Configuración del agente (ai_settings) contra el esquema real, con el rol de la app
// (RLS activo): defaults de la plantilla del rubro, creación perezosa e idempotente,
// cambios con su rastro en config_history y validación del PATCH.
// ─────────────────────────────────────────────────────────────────────────────

const base = await createEphemeralDb();
const { db } = base;

before(async () => {
  await base.client.exec("SET ROLE app_runtime");
});
after(() => base.close());

async function createBusiness(industry: string): Promise<string> {
  const businessId = randomUUID();
  await withTenant(db, businessId, (tx) => tx.insert(businesses).values({ id: businessId, slug: `ai-${businessId.slice(0, 8)}`, name: "Negocio IA", industry }));
  return businessId;
}

test("ai_settings: la primera lectura crea la fila con el registro y las instrucciones de la plantilla del rubro", async () => {
  const aesthetics = await createBusiness("aesthetics");
  const view = await getAiSettings(db, aesthetics);
  const template = loadIndustryTemplate("aesthetics");
  assert.equal(view.register, "vos");
  assert.equal(view.instructions, template.ai.instructions);
  assert.equal(view.tone, DEFAULT_TONE);
  assert.deepEqual(view.knowledge, []);
  assert.deepEqual(view.faq, []);
  assert.deepEqual(view.texts, {});

  const dental = await getAiSettings(db, await createBusiness("dental"));
  assert.equal(dental.register, "usted", "la clínica dental trata de usted");
  assert.equal(dental.instructions, loadIndustryTemplate("dental").ai.instructions);

  const unknown = await getAiSettings(db, await createBusiness("veterinaria"));
  assert.equal(unknown.instructions, loadIndustryTemplate("generic").ai.instructions, "rubro sin plantilla → genérico");
});

test("ai_settings: lecturas simultáneas terminan en UNA sola fila (creación idempotente)", async () => {
  const businessId = await createBusiness("nails");
  const views = await Promise.all(Array.from({ length: 5 }, () => getAiSettings(db, businessId)));
  assert.ok(views.every((v) => v.register === views[0].register));
  const rows = await withTenant(db, businessId, (tx) => tx.select().from(aiSettings).where(eq(aiSettings.businessId, businessId)));
  assert.equal(rows.length, 1);
});

test("ai_settings: un negocio inexistente es 404", async () => {
  await assert.rejects(getAiSettings(db, randomUUID()), (e: { status?: number }) => e.status === 404);
});

test("ai_settings: el PATCH cambia lo pedido, genera ids de sección y deja rastro en config_history", async () => {
  const businessId = await createBusiness("aesthetics");
  const patch = AiSettingsPatch.parse({
    tone: "  alegre y breve ",
    register: "tu",
    knowledge: [
      { title: "Formas de pago", items: ["SINPE Móvil", "", "Tarjeta"] },
      { title: "Formas de pago", items: ["Efectivo"] },
      { id: "parqueo", title: "Parqueo", items: ["Gratis frente al local"] },
    ],
    faq: [{ question: "¿Atienden niños?", answer: "Desde los 12 años." }],
    texts: { handoff: "Ya te paso con alguien 🙌", notUnderstood: "" },
  });
  const view = await updateAiSettings(db, { businessId, userId: null }, patch);
  assert.equal(view.tone, "alegre y breve");
  assert.equal(view.register, "tu");
  assert.deepEqual(
    view.knowledge.map((s) => s.id),
    ["formas-de-pago", "formas-de-pago-2", "parqueo"],
  );
  assert.deepEqual(view.knowledge[0].items, ["SINPE Móvil", "Tarjeta"], "las líneas vacías se descartan");
  assert.deepEqual(view.faq, [{ question: "¿Atienden niños?", answer: "Desde los 12 años." }]);
  assert.deepEqual(view.texts, { handoff: "Ya te paso con alguien 🙌" }, "un texto vacío vuelve al de catálogo");
  assert.equal(view.instructions, loadIndustryTemplate("aesthetics").ai.instructions, "lo no pedido no cambia");

  // Vacío = default.
  const cleared = await updateAiSettings(db, { businessId, userId: null }, AiSettingsPatch.parse({ tone: "", instructions: "" }));
  assert.equal(cleared.tone, DEFAULT_TONE);
  assert.equal(cleared.instructions, "");
  assert.deepEqual(await getAiSettings(db, businessId), cleared, "lo guardado es lo que se lee");

  const history = await withTenant(db, businessId, (tx) =>
    tx
      .select()
      .from(configHistory)
      .where(and(eq(configHistory.businessId, businessId), eq(configHistory.entity, "ai_settings"))),
  );
  assert.equal(history.length, 2);
});

test("ai_settings: facts/policies del esquema viejo se muestran como secciones", async () => {
  const businessId = await createBusiness("generic");
  await getAiSettings(db, businessId);
  await withTenant(db, businessId, (tx) =>
    tx
      .update(aiSettings)
      .set({ knowledge: { sections: [{ id: "a", title: "Servicios", items: ["Uno"] }], facts: ["Parqueo propio"], policies: ["Se cobra al final"] } })
      .where(eq(aiSettings.businessId, businessId)),
  );
  const view = await getAiSettings(db, businessId);
  assert.deepEqual(
    view.knowledge.map((s) => [s.id, s.items]),
    [
      ["a", ["Uno"]],
      ["facts", ["Parqueo propio"]],
      ["policies", ["Se cobra al final"]],
    ],
  );
});

test("AiSettingsPatch: rechaza registro inválido, campos desconocidos, cuerpo vacío y conocimiento demasiado largo", () => {
  assert.equal(AiSettingsPatch.safeParse({ register: "vosotros" }).success, false);
  assert.equal(AiSettingsPatch.safeParse({ tono: "x" }).success, false);
  assert.equal(AiSettingsPatch.safeParse({}).success, false);
  const long = Array.from({ length: 30 }, (_, i) => ({ title: `S${i}`, items: ["x".repeat(450)] }));
  assert.equal(AiSettingsPatch.safeParse({ knowledge: long }).success, false);
  assert.equal(AiSettingsPatch.safeParse({ texts: { "no válida!": "x" } }).success, false);
  assert.equal(AiSettingsPatch.safeParse({ faq: [{ question: "", answer: "x" }] }).success, false);
});
