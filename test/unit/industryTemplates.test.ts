import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { INDUSTRIES, listIndustryTemplates, loadIndustryTemplate, parseIndustryTemplate } from "../../src/modules/business";
import { DEFAULT_TERMINOLOGY } from "../../src/modules/business/settings";

// ─────────────────────────────────────────────────────────────────────────────
// Plantillas de rubro (src/modules/business/templates/*.json): que todas existan, pasen
// la validación y traigan lo que promete PLAN-GESTION.md §3 (catálogo de ejemplo,
// terminología, reglas de estado, campos personalizados y la sección `ai`); y que el
// validador rechace una plantilla rota.
// ─────────────────────────────────────────────────────────────────────────────

const TEMPLATES_DIR = fileURLToPath(new URL("../../src/modules/business/templates/", import.meta.url));

test("plantillas: hay exactamente una por rubro de INDUSTRIES y todas validan", () => {
  const files = readdirSync(TEMPLATES_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.replace(/\.json$/, ""))
    .sort();
  assert.deepEqual(files, [...INDUSTRIES].sort());
  const templates = listIndustryTemplates();
  assert.deepEqual(
    templates.map((t) => t.industry),
    [...INDUSTRIES],
  );
});

test("plantillas: catálogo de ejemplo sin precios, terminología, reglas, campos y sección ai", () => {
  for (const t of listIndustryTemplates()) {
    const services = t.catalog.categories.flatMap((c) => c.services);
    assert.ok(services.length >= 3, `${t.industry}: al menos 3 servicios de ejemplo`);
    assert.ok(services.every((s) => s.priceCents === null), `${t.industry}: precios de referencia en null`);
    assert.ok(services.every((s) => s.durationMin > 0 && s.durationMin % 5 === 0 && s.bufferMin >= 0));
    for (const key of Object.keys(t.terminology)) assert.ok(key in DEFAULT_TERMINOLOGY, `${t.industry}: término ${key}`);
    assert.ok(t.ai.instructions.length > 40);
    assert.match(t.ai.reminders.dayBefore, /\{clientName\}/);
    assert.match(t.ai.reminders.dayBefore, /\{time\}/);
  }
  const dental = loadIndustryTemplate("dental");
  assert.equal(dental.terminology.client, "paciente");
  assert.equal(dental.ai.register, "usted");
  assert.ok(dental.customFields.some((f) => f.key === "allergies" && f.entity === "client"));
  assert.equal(loadIndustryTemplate("nails").terminology.staffMember, "estilista");
  assert.equal(loadIndustryTemplate("aesthetics").terminology.staffMember, "especialista");
  const skin = loadIndustryTemplate("aesthetics").customFields.find((f) => f.key === "skin_type");
  assert.equal(skin?.type, "select");
  assert.ok((skin?.options.length ?? 0) >= 2);
});

test("plantillas: se leen una vez y quedan congeladas", () => {
  const a = loadIndustryTemplate("generic");
  assert.equal(loadIndustryTemplate("generic"), a, "misma instancia (caché)");
  assert.ok(Object.isFrozen(a) && Object.isFrozen(a.catalog.categories[0].services[0]));
});

test("plantillas: el validador rechaza una plantilla rota con el detalle del problema", () => {
  const good = JSON.parse(readFileSync(`${TEMPLATES_DIR}generic.json`, "utf8"));
  assert.doesNotThrow(() => parseIndustryTemplate(good));

  const broken = structuredClone(good);
  broken.catalog.categories[0].services.push({ ...broken.catalog.categories[0].services[0] }); // servicio repetido
  broken.catalog.categories[0].services[1].durationMin = 7; // no es múltiplo de 5
  broken.ai.reminders.sameDay = "Hola {clientName}, te esperamos el {fecha}."; // marcador desconocido
  broken.customFields = [{ entity: "client", key: "Forma", label: "Forma", type: "select", options: [] }];
  broken.terminology = { client: "Paciente" }; // mayúscula
  broken.extra = true; // clave desconocida
  assert.throws(
    () => parseIndustryTemplate(broken, "rota.json"),
    (e: Error) =>
      /rota\.json inválida/.test(e.message) &&
      /Servicio repetido/.test(e.message) &&
      /múltiplo de 5/.test(e.message) &&
      /Marcador desconocido/.test(e.message) &&
      /snake_case/.test(e.message) &&
      /minúscula/.test(e.message),
  );
});
