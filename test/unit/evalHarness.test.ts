import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { ChatCompletion } from "openai/resources/chat/completions";
import {
  AMOUNT_PATTERNS,
  caseTemplate,
  evaluate,
  loadCases,
  mentionedServices,
  mentionedTools,
  resolveExpected,
  validateCase,
  type EvalCase,
  type ObservedResult,
} from "../../eval/assertions";
import {
  baselineNote,
  baselineRefusal,
  buildReport,
  caseIcon,
  caseResult,
  CRITICAL_PASS_RATE,
  DEFAULT_MAX_COST_USD,
  DEFAULT_MIN_PASS_RATE,
  parseMaxCostUsd,
  parseMinPassRate,
  parseRepeat,
  resultFileName,
  VERBOSE_REPLY_PREFIX,
} from "../../eval/report";
import { buildTurnInput, prepareWorld, TEMPLATE_PRICES, type CaseWorld } from "../../eval/world";
import { loadIndustryTemplate } from "../../src/modules/business";
import { getAiSettings } from "../../src/modules/whatsapp";
import { createAgentRunner, TOOL_NAMES, type ChatCompletionsClient } from "../../src/modules/whatsapp/agent";
import { addDays, localDate } from "../../src/modules/whatsapp/agent/time";
import { loadAgentContext } from "../../src/modules/whatsapp/agent/context";
import { listUpcomingAppointmentsForClient } from "../../src/modules/scheduling";
import { createEphemeralDb } from "../helpers/pgliteDb";

// ─────────────────────────────────────────────────────────────────────────────
// Arnés de evals (eval/), sin OpenAI: los casos cargan, nombran tools y servicios que
// existen de verdad en la plantilla que eligen, la suite cubre los grupos acordados, las
// aserciones y el umbral hacen lo que dicen (un bug acá no puede disfrazarse de "el agente
// falló"), el mundo de cada caso se siembra, y sin OPENAI_API_KEY la corrida se salta.
// ─────────────────────────────────────────────────────────────────────────────

const reply = (text: string, extra: Partial<ObservedResult> = {}): ObservedResult => ({ replies: [{ text }], actions: [], ...extra });

test("evals: ≥ 25 casos válidos, con nombre único, que solo mencionan tools y servicios de su plantilla", () => {
  const cases = loadCases();
  assert.ok(cases.length >= 25, `hay ${cases.length} casos`);
  assert.equal(new Set(cases.map((c) => c.name)).size, cases.length);
  for (const c of cases) {
    assert.deepEqual(validateCase(c), [], c.name);
    // Redundante con validateCase a propósito: si alguien la afloja, esto sigue mirando.
    for (const t of mentionedTools(c.expect)) assert.ok(TOOL_NAMES.includes(t), `${c.name}: la tool "${t}" no existe`);
    const services = new Set(loadIndustryTemplate(caseTemplate(c)).catalog.categories.flatMap((cat) => cat.services.map((s) => s.name)));
    for (const s of mentionedServices(c)) assert.ok(services.has(s), `${c.name}: el servicio "${s}" no está en la plantilla "${caseTemplate(c)}"`);
  }
});

test("evals: la suite cubre registro, idioma, rubros, confirmación negativa, voz, bandeja y crecimiento", () => {
  const cases = loadCases();
  const some = (label: string, pred: (c: EvalCase) => boolean) => assert.ok(cases.some(pred), `falta un caso de: ${label}`);
  some("registro tú", (c) => c.register === "tu");
  some("registro usted", (c) => c.register === "usted" || (c.template === "dental" && !c.register));
  some("cliente en inglés", (c) => /^(hi|hello|can i)\b/i.test(c.user));
  // Rubros prioritarios para el primer cliente (decisión del usuario): uñas y dental.
  some("plantilla de uñas", (c) => c.template === "nails");
  some("plantilla dental", (c) => c.template === "dental");
  some("propone y sin sí no agenda", (c) => c.expect.notTool === "book_appointment" && (c.history ?? []).length > 0);
  some("nota de voz", (c) => c.user.startsWith("[audio] "));
  some("mensaje tras una persona del equipo", (c) => (c.history ?? []).some((m) => m.byHuman));
  some("cotización", (c) => c.growth?.quoteRecovery === true && c.expect.tool === "record_quote");
  some("upsell aceptado", (c) => c.expect.tool === "add_service_to_appointment");
  some("upsell rechazado", (c) => c.expect.tool === "decline_upsell");
  // Críticos (100 %): no inventa precios y no agenda fuera de horario.
  const critical = cases.filter((c) => c.critical);
  assert.ok(critical.some((c) => c.expect.noAmount), "falta un crítico de 'no inventa precios'");
  assert.ok(critical.some((c) => c.expect.notAction === "appointment_booked"), "falta un crítico de 'no agenda fuera de horario'");
});

test("validateCase: atrapa los errores de forma antes de gastar tokens", () => {
  const base: EvalCase = { name: "x", user: "hola", expect: {} };
  assert.deepEqual(validateCase(base), []);
  const errors = (c: Partial<EvalCase>) => validateCase({ ...base, ...c } as EvalCase);
  assert.equal(errors({ template: "spa" as never }).length, 1);
  assert.equal(errors({ register: "voseo" as never }).length, 1);
  assert.equal(errors({ expect: { tool: "agendar_cita" } }).length, 1);
  // Servicio de otra plantilla: "Valoración inicial" es dental, no estética.
  assert.equal(errors({ seedAppointments: [{ service: "Valoración inicial", inDays: 1, time: "10:00" }] }).length, 1);
  assert.deepEqual(errors({ template: "dental", seedAppointments: [{ service: "Valoración inicial", inDays: 1, time: "10:00" }] }), []);
  // Tools de crecimiento sin activar el crecimiento del caso.
  assert.equal(errors({ expect: { tool: "record_quote" } }).length, 1);
  assert.equal(errors({ expect: { tool: "decline_upsell" } }).length, 1);
  assert.deepEqual(errors({ growth: { quoteRecovery: true }, expect: { tool: "record_quote" } }), []);
  assert.equal(errors({ growth: { upsell: [{ service: "Manicura", suggest: "Blanqueamiento" }] } }).length, 1);
  // byHuman solo en mensajes del asistente.
  assert.equal(errors({ history: [{ role: "user", text: "hola", byHuman: true }] }).length, 1);
  assert.deepEqual(errors({ history: [{ role: "assistant", text: "hola", byHuman: true }] }), []);
  assert.equal(errors({ template: "nails", channel: "all" }).length, 1);
  // Un servicio que no se agenda en línea no lo ve el agente: el caso sería imposible.
  assert.equal(errors({ growth: { quoteRecovery: true }, expect: { argIncludes: { tool: "record_quote", args: { service_id: "$service:Peeling químico" } } } }).length, 1);
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
  const booked = reply("Listo", { actions: [{ type: "appointment_booked", appointmentId: "a" }] });
  assert.equal(evaluate({ notAction: "appointment_booked" }, booked, [], "2026").length, 1);
  assert.deepEqual(evaluate({ notAction: "appointment_booked" }, reply("Ese día está cerrado"), [], "2026"), []);
  const english = reply("The deep facial cleansing is ₡25 000");
  assert.deepEqual(evaluate({ containsEach: [["25 000", "25.000"], ["the", "price"]] }, english, [], "2026"), []);
  assert.equal(evaluate({ containsEach: [["25 000"], ["precio", "cuesta"]] }, english, [], "2026").length, 1);
});

test("evaluate: montos y argumentos con servicios resueltos por nombre", () => {
  assert.equal(evaluate({ noAmount: true }, reply("Cuesta ₡25 000"), [], "2026").length, 1);
  assert.deepEqual(evaluate({ noAmount: true }, reply("Dura 30 min, a las 8:00 del 2026"), [], "2026"), []);
  assert.ok(AMOUNT_PATTERNS.some((p) => p.test("unos 50 mil colones")));
  // Montos reales permitidos (el de la valoración) no cuentan; uno inventado al lado, sí.
  const allowed = { noAmount: true, allowedAmounts: ["15 000"] };
  assert.deepEqual(evaluate(allowed, reply("Se cotiza en la valoración (₡15 000)"), [], "2026"), []);
  assert.equal(evaluate(allowed, reply("Valoración ₡15 000 y la resina unos ₡30 000"), [], "2026").length, 1);

  const ids: Record<string, string> = { "Limpieza facial profunda": "svc-1" };
  const serviceId = (n: string) => ids[n];
  assert.deepEqual(resolveExpected(["$service:Limpieza facial profunda"], serviceId), ["svc-1"]);
  const calls = [{ name: "book_appointment", args: { service_ids: ["svc-1"], time: "10:00" } }];
  const expect = { argIncludes: { tool: "book_appointment", args: { service_ids: ["$service:Limpieza facial profunda"], time: "10:00" } } };
  assert.deepEqual(evaluate(expect, reply("Listo"), calls, "2026", serviceId), []);
  assert.equal(evaluate({ argIncludes: { tool: "book_appointment", args: { time: "11:00" } } }, reply("Listo"), calls, "2026").length, 1);
});

test("umbral: 90 % general, 100 % en los críticos, y lectura de las env", () => {
  assert.equal(DEFAULT_MIN_PASS_RATE, 0.9);
  assert.equal(CRITICAL_PASS_RATE, 1);
  assert.equal(parseMinPassRate(undefined), 0.9);
  assert.equal(parseMinPassRate("0,8"), 0.8);
  assert.throws(() => parseMinPassRate("90"), /EVAL_MIN_PASS_RATE/);
  assert.throws(() => parseMinPassRate("0"), /EVAL_MIN_PASS_RATE/);
  assert.equal(parseMaxCostUsd(undefined), DEFAULT_MAX_COST_USD);
  assert.equal(parseMaxCostUsd("0.5"), 0.5);
  assert.throws(() => parseMaxCostUsd("-1"), /EVAL_MAX_COST_USD/);
  assert.equal(parseRepeat(undefined), 1);
  assert.equal(parseRepeat("3"), 3);
  assert.throws(() => parseRepeat("1.5"), /EVAL_REPEAT/);

  const outcome = (passed: number, runs: number, critical = false) => ({ name: "c", critical, runs, passed, failures: [] });
  // Con 3 repeticiones, 90 % exige 3/3; con 10, alcanza 9/10.
  assert.equal(caseResult(outcome(2, 3), 0.9).ok, false);
  assert.equal(caseResult(outcome(3, 3), 0.9).ok, true);
  assert.equal(caseResult(outcome(9, 10), 0.9).ok, true);
  assert.equal(caseResult(outcome(9, 10, true), 0.9).ok, false);
  assert.equal(caseResult(outcome(0, 0), 0.9).ok, null);
  assert.equal(caseIcon(caseResult(outcome(3, 3), 0.9)), "✅");
  assert.equal(caseIcon(caseResult(outcome(9, 10), 0.9)), "🟡");
  assert.equal(caseIcon(caseResult(outcome(1, 3), 0.9)), "❌");
});

test("reporte: JSON sin respuestas del agente, corrida incompleta por gasto y línea base", () => {
  const date = new Date("2026-10-31T15:30:00Z");
  const report = buildReport({
    date,
    model: "gpt-4o-mini",
    repeat: 3,
    minPassRate: 0.9,
    filter: null,
    maxCostUsd: 1,
    costMicros: 123_456,
    tokens: { input: 1000, output: 100 },
    outcomes: [
      { name: "a", critical: true, runs: 3, passed: 3, failures: [] },
      { name: "b", critical: false, runs: 3, passed: 2, failures: ["esperaba la tool \"offer_slots\"", `${VERBOSE_REPLY_PREFIX}Hola Marco, …`, "esperaba la tool \"offer_slots\""] },
      { name: "c", critical: false, runs: 0, passed: 0, failures: [] },
    ],
  });
  assert.equal(report.costUsd, 0.123456);
  assert.deepEqual(report.summary, { cases: 3, ok: 1, belowThreshold: 1, notRun: 1 });
  assert.equal(report.complete, false);
  assert.equal(report.passed, false);
  assert.deepEqual(report.cases[1].failures, ['esperaba la tool "offer_slots"']);
  assert.ok(!JSON.stringify(report).includes("Hola Marco"), "el reporte no lleva la respuesta del agente");
  assert.equal(resultFileName(date, "gpt-4o-mini"), "2026-10-31-1530-gpt-4o-mini.json");
  assert.equal(resultFileName(date, "ft:gpt/4o"), "2026-10-31-1530-ft_gpt_4o.json");

  assert.match(baselineRefusal(report) ?? "", /tope de gasto/);
  assert.match(baselineRefusal({ complete: true, filter: "upsell", repeat: 3 }) ?? "", /EVAL_CASE/);
  assert.match(baselineRefusal({ complete: true, filter: null, repeat: 1 }) ?? "", /EVAL_REPEAT=3/);
  assert.equal(baselineRefusal({ complete: true, filter: null, repeat: 3 }), null);
  assert.equal(baselineNote("a", report), " (línea base 3/3)");
  assert.equal(baselineNote("z", report), " (nuevo: no está en la línea base)");
  assert.equal(baselineNote("a", null), "");
});

test("mundo de eval: cada plantilla se siembra como un alta real y el caso aplica registro, citas y crecimiento", async () => {
  const { db, close } = await createEphemeralDb();
  try {
    const now = new Date("2026-11-03T15:00:00Z"); // martes 09:00 en Costa Rica
    for (const template of ["dental", "nails", "generic"] as const) {
      const world = await prepareWorld(db, { name: template, template, user: "hola", expect: {} }, now);
      const ctx = await loadAgentContext(db, world.businessId);
      if (!ctx) throw new Error(`${template}: el agente no ve el negocio`);
      assert.deepEqual(ctx.locations.map((l) => l.name), ["Escazú"], template);
      assert.equal(ctx.staff.length, 2, template);
      assert.equal(ctx.settings.register, loadIndustryTemplate(template).ai.register, template);
      // Lo que ve el agente (solo lo que se agenda en línea), con el precio de demo de la tabla.
      const prices: Record<string, number | null> = TEMPLATE_PRICES[template];
      const seen = ctx.services.map((x) => [x.name, x.priceCents / 100] as const);
      assert.ok(seen.length > 0, template);
      for (const [name, colones] of seen) assert.equal(colones, prices[name] ?? 0, `${template}: ${name}`);
    }

    const upsell: EvalCase = {
      name: "upsell",
      register: "usted",
      growth: { quoteRecovery: true, upsell: [{ service: "Limpieza facial profunda", suggest: "Hidratación facial" }] },
      seedAppointments: [{ service: "Limpieza facial profunda", inDays: 1, time: "10:00" }],
      user: "sí",
      expect: {},
    };
    const world = await prepareWorld(db, upsell, now);
    assert.equal((await getAiSettings(db, world.businessId)).register, "usted");
    assert.deepEqual(world.growth, {
      quoteRecovery: true,
      upsellRules: [{ serviceId: world.serviceId("Limpieza facial profunda"), suggestServiceId: world.serviceId("Hidratación facial") }],
    });
    const appointments = await listUpcomingAppointmentsForClient(db, world.businessId, world.clientId, { now });
    assert.deepEqual(appointments.map((a) => a.services.map((l) => l.name)), [["Limpieza facial profunda"]]);
    // Sin `growth` en el caso, el turno va sin crecimiento (como un negocio que no lo activó).
    assert.equal((await prepareWorld(db, { name: "plain", user: "hola", expect: {} }, now)).growth, undefined);
  } finally {
    await close();
  }
});

type ScriptStep = string | { tool: string; args: (w: CaseWorld, tomorrow: string) => Record<string, unknown> };

/** Modelo guionado: pide las tools del guion en orden y termina con su texto. Junta lo que devolvieron las tools. */
function scriptedModel(steps: ScriptStep[], world: CaseWorld, tomorrow: string, toolResults: string[]): ChatCompletionsClient {
  let i = 0;
  return {
    chat: {
      completions: {
        create: async (body) => {
          const last = body.messages.at(-1);
          if (last?.role === "tool") toolResults.push(String(last.content));
          const step = steps[i++] ?? "ok";
          const message =
            typeof step === "string"
              ? { role: "assistant" as const, content: step, refusal: null }
              : {
                  role: "assistant" as const,
                  content: null,
                  refusal: null,
                  tool_calls: [{ id: `call_${i}`, type: "function" as const, function: { name: step.tool, arguments: JSON.stringify(step.args(world, tomorrow)) } }],
                };
          return { id: "s", object: "chat.completion", created: 0, model: "scripted", choices: [{ index: 0, finish_reason: "stop", logprobs: null, message }] } as ChatCompletion;
        },
      },
    },
  };
}

const slotArgs = (service: string) => (w: CaseWorld, tomorrow: string) => ({
  location_id: w.locationId,
  service_ids: [w.serviceId(service)],
  date: tomorrow,
  staff_id: null,
  part_of_day: "any",
});

const bookArgs = (service: string, time: string) => (w: CaseWorld, tomorrow: string) => ({
  location_id: w.locationId,
  service_ids: [w.serviceId(service)],
  date: tomorrow,
  time,
  staff_id: null,
  client_name: null,
  notes: null,
});

test("casos alcanzables: con un modelo que hace lo correcto, los de crecimiento y horario pasan sus aserciones", async () => {
  // Un caso que ni el modelo perfecto puede pasar (una hora que el mundo no tiene libre, una
  // regla de upsell que no aplica) se leería como "el agente falló": acá se descarta.
  const scripts: Record<string, { steps: ScriptStep[]; toolResult?: RegExp }> = {
    "04-offers-slots": { steps: [{ tool: "offer_slots", args: slotArgs("Limpieza facial profunda") }, "Elegí tu horario para mañana en Escazú."] },
    "05-books": { steps: [{ tool: "book_appointment", args: bookArgs("Limpieza facial profunda", "10:00") }, "¡Listo!"], toolResult: /"ok":true/ },
    "07-reschedule": {
      // "El viernes": martes + 3.
      steps: [{ tool: "reschedule_appointment", args: (_w, tomorrow) => ({ appointment_id: null, date: addDays(tomorrow, 2), time: "10:00" }) }, "Listo, quedó el viernes a las 10:00."],
      toolResult: /"ok":true/,
    },
    "08-cancel": { steps: [{ tool: "cancel_appointment", args: () => ({ appointment_id: null, reason: null }) }, "Listo, quedó cancelada."], toolResult: /"ok":true/ },
    "17-english-slots": { steps: [{ tool: "offer_slots", args: slotArgs("Manicura") }, "Pick a time for tomorrow in Escazú."] },
    "20-nails-offers-slots": { steps: [{ tool: "offer_slots", args: slotArgs("Pedicura spa") }, "Elegí tu horario de mañana."] },
    "24-dental-offers-slots": { steps: [{ tool: "offer_slots", args: slotArgs("Valoración inicial") }, "Elija su horario para mañana."] },
    "28-no-book-after-hours": {
      steps: [{ tool: "book_appointment", args: bookArgs("Masaje relajante", "20:00") }, "A las 20:00 ya cerramos. ¿Te sirve a las 18:00?"],
      toolResult: /"ok":false/,
    },
    "32-quote-recorded": {
      steps: [{ tool: "record_quote", args: (w) => ({ service_id: w.serviceId("Drenaje linfático") }) }, "El drenaje linfático cuesta ₡24 000. ¿Querés agendarlo?"],
      toolResult: /"ok":true/,
    },
    "33-upsell-offered": {
      steps: [{ tool: "book_appointment", args: bookArgs("Limpieza facial profunda", "10:00") }, "¡Listo! ¿Te agrego una Hidratación facial (₡18 000) justo después?"],
      toolResult: /upsell_offer/,
    },
    "34-upsell-accepted": {
      steps: [{ tool: "add_service_to_appointment", args: (w) => ({ appointment_id: null, service_id: w.serviceId("Hidratación facial") }) }, "Listo, quedó agregada."],
      toolResult: /"ok":true/,
    },
    "35-upsell-declined": {
      steps: [{ tool: "decline_upsell", args: (w) => ({ service_id: w.serviceId("Hidratación facial") }) }, "¡Perfecto! Te esperamos mañana."],
      toolResult: /"ok":true/,
    },
  };
  const cases = loadCases().filter((c) => c.name in scripts);
  assert.equal(cases.length, Object.keys(scripts).length);
  const { db, close } = await createEphemeralDb();
  try {
    const now = new Date("2026-11-03T15:00:00Z"); // martes 09:00 en Costa Rica
    const tomorrow = addDays(localDate(now, "America/Costa_Rica"), 1);
    for (const c of cases) {
      const world = await prepareWorld(db, c, now);
      const toolResults: string[] = [];
      const calls: { name: string; args: Record<string, unknown> }[] = [];
      const { steps, toolResult } = scripts[c.name];
      const runner = createAgentRunner({ openai: scriptedModel(steps, world, tomorrow, toolResults), onToolCall: (e) => calls.push(e), reportError: () => {} });
      const result = await runner(db, buildTurnInput(c, world, now));
      if (toolResult) assert.match(toolResults.join("\n"), toolResult, c.name);
      assert.deepEqual(evaluate(c.expect, result, calls, now.toISOString().slice(0, 4), world.serviceId), [], c.name);
    }
  } finally {
    await close();
  }
});

test("runEval: sin OPENAI_API_KEY se salta con un aviso claro, sale con 0 y no corre nada", () => {
  const script = fileURLToPath(new URL("../../eval/runEval.ts", import.meta.url));
  // OPENAI_API_KEY vacía (dotenv no pisa una variable ya definida) y, por las dudas, un
  // filtro que no matchea nada: aunque hubiera key, no se gastaría un token.
  const env = { ...process.env, OPENAI_API_KEY: "", EVAL_DRY_RUN: "", EVAL_CASE: "__ningun_caso__" };
  const run = spawnSync(process.execPath, ["--import", "tsx", script], { env, encoding: "utf8", timeout: 60_000 });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /Evals SALTADAS: no hay OPENAI_API_KEY/);
  assert.match(run.stdout, /No se corrió ningún caso/);
});
