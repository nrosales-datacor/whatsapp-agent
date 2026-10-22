import assert from "node:assert/strict";
import { test } from "node:test";
import { ClientStatusRulesInput, DEFAULT_CLIENT_STATUS_RULES, listIndustryTemplates, loadIndustryTemplate, parseIndustryTemplate, readClientStatusRules } from "../../src/modules/business";
import { clientStatusRulesOverrides } from "../../src/modules/business/statusRules";

// ─────────────────────────────────────────────────────────────────────────────
// Reglas del estado del cliente (src/modules/business/statusRules.ts): las de cada
// plantilla de rubro, la lectura tolerante de lo guardado, lo que se guarda (solo lo que
// difiere de los defaults) y la validación estricta del PUT.
// ─────────────────────────────────────────────────────────────────────────────

test("plantillas: cada rubro trae reglas completas y coherentes (inactivo después de en riesgo)", () => {
  for (const template of listIndustryTemplates()) {
    const rules = readClientStatusRules(template.clientStatusRules);
    assert.ok(rules.inactiveAfterDays > rules.atRiskAfterDays, template.industry);
    assert.deepEqual(readClientStatusRules({ ...rules }), rules, `${template.industry}: leer lo leído no cambia nada`);
  }
  // Lo propio de cada rubro: dental mide en meses, uñas y estética por frecuencia.
  const dental = readClientStatusRules(loadIndustryTemplate("dental").clientStatusRules);
  assert.equal(dental.atRiskMode, "fixed");
  assert.equal(dental.atRiskAfterDays, 210);
  assert.equal(dental.newDays, 90);
  for (const industry of ["nails", "aesthetics"] as const) {
    const rules = readClientStatusRules(loadIndustryTemplate(industry).clientStatusRules);
    assert.equal(rules.atRiskMode, "frequency", industry);
    assert.equal(rules.atRiskFrequencyFactor, 2, industry);
  }
  assert.deepEqual(readClientStatusRules(loadIndustryTemplate("generic").clientStatusRules), { ...DEFAULT_CLIENT_STATUS_RULES });
});

test("plantillas: una regla inválida o desconocida rompe al validar la plantilla", () => {
  const template = structuredClone(loadIndustryTemplate("generic")) as Record<string, unknown>;
  assert.throws(() => parseIndustryTemplate({ ...template, clientStatusRules: { newMaxVisits: 1 } }), /clientStatusRules/);
  assert.throws(() => parseIndustryTemplate({ ...template, clientStatusRules: { atRiskAfterDays: 90, inactiveAfterDays: 60 } }), /inactivo/);
  assert.throws(() => parseIndustryTemplate({ ...template, clientStatusRules: { atRiskMode: "sometimes" } }), /clientStatusRules/);
});

test("lectura tolerante: lo inválido o viejo cae al default sin romper la lista", () => {
  assert.deepEqual(readClientStatusRules(null), DEFAULT_CLIENT_STATUS_RULES);
  assert.deepEqual(readClientStatusRules({ newMaxVisits: 1, atRiskAfterDays: "mucho", newDays: 45 }), { ...DEFAULT_CLIENT_STATUS_RULES, newDays: 45 });
  // Par incoherente guardado a mano: vuelven los defaults de esos dos.
  const fixed = readClientStatusRules({ atRiskAfterDays: 300, inactiveAfterDays: 200 });
  assert.ok(fixed.inactiveAfterDays > fixed.atRiskAfterDays);
});

test("se guarda solo lo que difiere de los defaults; el PUT valida estricto y redondea el factor", () => {
  assert.deepEqual(clientStatusRulesOverrides({ ...DEFAULT_CLIENT_STATUS_RULES }), {});
  assert.deepEqual(clientStatusRulesOverrides({ ...DEFAULT_CLIENT_STATUS_RULES, newDays: 45, vipMinSpentCents: 5_000_000 }), { newDays: 45, vipMinSpentCents: 5_000_000 });

  const ok = ClientStatusRulesInput.safeParse({ ...DEFAULT_CLIENT_STATUS_RULES, atRiskMode: "frequency", atRiskFrequencyFactor: 1.55 });
  assert.equal(ok.success, true);
  assert.equal(ok.success && ok.data.atRiskFrequencyFactor, 1.6);
  assert.equal(ClientStatusRulesInput.safeParse({ ...DEFAULT_CLIENT_STATUS_RULES, extra: 1 }).success, false, "sin claves de más");
  assert.equal(ClientStatusRulesInput.safeParse({ ...DEFAULT_CLIENT_STATUS_RULES, newDays: 0 }).success, false);
  assert.equal(ClientStatusRulesInput.safeParse({ ...DEFAULT_CLIENT_STATUS_RULES, atRiskFrequencyFactor: 0.5 }).success, false);
  const incoherent = ClientStatusRulesInput.safeParse({ ...DEFAULT_CLIENT_STATUS_RULES, atRiskAfterDays: 120, inactiveAfterDays: 120 });
  assert.equal(incoherent.success, false);
  assert.deepEqual(!incoherent.success && incoherent.error.issues[0].path, ["inactiveAfterDays"]);
});
