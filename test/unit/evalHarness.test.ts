import assert from "node:assert/strict";
import { test } from "node:test";
import { AMOUNT_PATTERNS, evaluate, loadCases, mentionedServices, mentionedTools, resolveExpected, type ObservedResult } from "../../eval/assertions";
import { loadIndustryTemplate } from "../../src/modules/business";
import { TOOL_NAMES } from "../../src/modules/whatsapp/agent";

// ─────────────────────────────────────────────────────────────────────────────
// Arnés de evals (eval/), sin OpenAI: los casos cargan, nombran tools y servicios que
// existen de verdad, y las aserciones hacen lo que dicen (un bug acá no puede disfrazarse
// de "el agente falló").
// ─────────────────────────────────────────────────────────────────────────────

const reply = (text: string, extra: Partial<ObservedResult> = {}): ObservedResult => ({ replies: [{ text }], actions: [], ...extra });

test("evals: los casos cargan, con nombre único, y solo mencionan tools y servicios que existen", () => {
  const cases = loadCases();
  assert.ok(cases.length >= 12);
  assert.equal(new Set(cases.map((c) => c.name)).size, cases.length);
  const services = new Set(loadIndustryTemplate("aesthetics").catalog.categories.flatMap((c) => c.services.map((s) => s.name)));
  for (const c of cases) {
    assert.ok(c.user.trim(), c.name);
    for (const t of mentionedTools(c.expect)) assert.ok(TOOL_NAMES.includes(t), `${c.name}: la tool "${t}" no existe`);
    for (const s of mentionedServices(c)) assert.ok(services.has(s), `${c.name}: el servicio "${s}" no está en la plantilla de estética`);
  }
});

test("evaluate: tools usadas, no usadas y ninguna", () => {
  const tools = [{ name: "offer_slots", args: { date: "2026-10-22" } }];
  assert.deepEqual(evaluate({ tool: "offer_slots", notTool: "book_appointment" }, reply("x"), tools, "2026"), []);
  assert.equal(evaluate({ tool: "book_appointment" }, reply("x"), tools, "2026").length, 1);
  assert.equal(evaluate({ anyTool: ["check_availability", "offer_slots"] }, reply("x"), tools, "2026").length, 0);
  assert.equal(evaluate({ noTools: true }, reply("x"), tools, "2026").length, 1);
  assert.equal(evaluate({ currentYearDates: true }, reply("x"), [{ name: "offer_slots", args: { date: "2024-10-22" } }], "2026").length, 1);
});

test("evaluate: traspaso, botones, acciones, fuera de alcance y textos", () => {
  const handoff = reply("Dejame consultarlo", { actions: [{ type: "handoff", reason: "x" }] });
  assert.deepEqual(evaluate({ handoff: true }, handoff, [], "2026"), []);
  assert.equal(evaluate({ handoff: false }, handoff, [], "2026").length, 1);
  const withButtons: ObservedResult = { replies: [{ text: "Elegí", buttons: [{ id: "a", title: "jue 22 · 09:00" }] }], actions: [] };
  assert.deepEqual(evaluate({ buttons: true }, withButtons, [], "2026"), []);
  assert.equal(evaluate({ action: "appointment_booked" }, withButtons, [], "2026").length, 1);
  assert.deepEqual(evaluate({ outOfScope: true }, reply("Disculpá, solo puedo ayudarte con cosas de Estética Demo 🙂"), [], "2026"), []);
  assert.deepEqual(evaluate({ containsAny: ["ESCAZÚ"], notContains: ["usted"] }, reply("¿Escazú o Heredia?"), [], "2026"), []);
});

test("evaluate: montos y argumentos con servicios resueltos por nombre", () => {
  assert.equal(evaluate({ noAmount: true }, reply("Cuesta ₡25 000"), [], "2026").length, 1);
  assert.deepEqual(evaluate({ noAmount: true }, reply("Dura 30 min, a las 8:00 del 2026"), [], "2026"), []);
  assert.ok(AMOUNT_PATTERNS.some((p) => p.test("unos 50 mil colones")));

  const ids: Record<string, string> = { "Limpieza facial profunda": "svc-1" };
  const serviceId = (n: string) => ids[n];
  assert.deepEqual(resolveExpected(["$service:Limpieza facial profunda"], serviceId), ["svc-1"]);
  const calls = [{ name: "book_appointment", args: { service_ids: ["svc-1"], time: "10:00" } }];
  const expect = { argIncludes: { tool: "book_appointment", args: { service_ids: ["$service:Limpieza facial profunda"], time: "10:00" } } };
  assert.deepEqual(evaluate(expect, reply("Listo"), calls, "2026", serviceId), []);
  assert.equal(evaluate({ argIncludes: { tool: "book_appointment", args: { time: "11:00" } } }, reply("Listo"), calls, "2026").length, 1);
});
