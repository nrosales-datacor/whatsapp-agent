import assert from "node:assert/strict";
import { test } from "node:test";
import { MODULES as SERVER_MODULES, PLANS } from "../../src/modules/billing";
import {
  atLimit,
  BILLING_STATUS_LABELS,
  MODULES,
  moduleLabel,
  monthLabel,
  pausesAtText,
  PLAN_MODULES,
  trialDaysLeft,
  trialEndsText,
  usageText,
} from "../../web/src/lib/plans";

// ─────────────────────────────────────────────────────────────────────────────
// Textos y cuentas de los planes en el panel (web/src/lib/plans.ts): cupos, días de prueba
// y el espejo del catálogo del backend. Sin DOM ni red.
// ─────────────────────────────────────────────────────────────────────────────

const DAY = 86_400_000;

test("planes: usageText y atLimit con tope, sin tope (null) y en cero", () => {
  assert.equal(usageText(1, 3), "1 de 3");
  assert.equal(usageText(0, 0), "0 de 0");
  assert.equal(usageText(2, null), "2 · sin tope");
  assert.equal(atLimit(2, 3), false);
  assert.equal(atLimit(3, 3), true);
  assert.equal(atLimit(4, 3), true, "por encima del tope (bajó de plan) tampoco entra otro");
  assert.equal(atLimit(0, 0), true, "tope 0: no entra ninguno");
  assert.equal(atLimit(10_000, null), false, "sin tope nunca se llega");
});

test("planes: trialDaysLeft redondea hacia arriba, nunca negativo, null sin fecha válida", () => {
  const now = new Date("2026-10-31T15:00:00.000Z");
  assert.equal(trialDaysLeft(null, now), null);
  assert.equal(trialDaysLeft(undefined, now), null);
  assert.equal(trialDaysLeft("", now), null);
  assert.equal(trialDaysLeft("no es fecha", now), null);
  assert.equal(trialDaysLeft(now.toISOString(), now), 0, "vence ahora");
  assert.equal(trialDaysLeft(new Date(now.getTime() - 3 * DAY).toISOString(), now), 0, "ya venció");
  assert.equal(trialDaysLeft(new Date(now.getTime() + 1).toISOString(), now), 1, "un milisegundo cuenta como un día");
  assert.equal(trialDaysLeft(new Date(now.getTime() + DAY).toISOString(), now), 1);
  assert.equal(trialDaysLeft(new Date(now.getTime() + DAY + 1).toISOString(), now), 2);
  assert.equal(trialDaysLeft(new Date(now.getTime() + 14 * DAY).toISOString(), now), 14);
  // Con offset de zona horaria: es el mismo instante, cuenta igual.
  assert.equal(trialDaysLeft("2026-11-01T09:00:00-06:00", now), 1);
});

test("planes: trialEndsText para hoy, mañana y varios días", () => {
  assert.equal(trialEndsText(0), "Tu prueba gratis termina hoy");
  assert.equal(trialEndsText(-2), "Tu prueba gratis termina hoy");
  assert.equal(trialEndsText(1), "Tu prueba gratis termina mañana");
  assert.equal(trialEndsText(5), "Tu prueba gratis termina en 5 días");
});

test("planes: monthLabel y pausesAtText con fechas válidas e inválidas", () => {
  assert.equal(monthLabel("2026-10"), "octubre de 2026");
  assert.equal(monthLabel("2027-01"), "enero de 2027");
  assert.equal(monthLabel("octubre"), "octubre", "lo que no es YYYY-MM vuelve tal cual");
  assert.equal(monthLabel(""), "");
  assert.equal(pausesAtText(null), null);
  assert.equal(pausesAtText(undefined), null);
  assert.equal(pausesAtText("mañana"), null);
  // Mediodía UTC: el mismo día en cualquier zona entre UTC−11 y UTC+11 (la del navegador).
  assert.equal(pausesAtText("2026-11-05T12:00:00Z"), "Si no se resuelve, la cuenta se pausa el 5 de noviembre");
});

test("planes: módulos y planes del panel son espejo del catálogo del backend", () => {
  assert.deepEqual(
    MODULES.map((m) => m.id),
    [...SERVER_MODULES],
  );
  for (const plan of Object.keys(PLANS) as (keyof typeof PLANS)[]) {
    assert.deepEqual([...PLAN_MODULES[plan]].sort(), [...PLANS[plan].modules].sort(), plan);
  }
  assert.deepEqual(Object.keys(PLAN_MODULES).sort(), Object.keys(PLANS).sort());
  assert.equal(moduleLabel("whatsapp"), "WhatsApp IA");
  assert.equal(moduleLabel("modulo_nuevo"), "modulo_nuevo", "un módulo nuevo del backend se muestra por su id");
  assert.deepEqual(Object.keys(BILLING_STATUS_LABELS).sort(), ["active", "cancelled", "past_due", "trial"]);
});
