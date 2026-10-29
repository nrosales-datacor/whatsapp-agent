import assert from "node:assert/strict";
import { after, afterEach, before, test } from "node:test";
import { APIConnectionError } from "openai";
import type { ChatCompletion, ChatCompletionCreateParamsNonStreaming } from "openai/resources/chat/completions";
import { listLocations } from "../../src/modules/business";
import { getServices } from "../../src/modules/catalog";
import { findOrCreateClientByPhone } from "../../src/modules/clients";
import { listAppointments, listUpcomingAppointmentsForClient } from "../../src/modules/scheduling";
import type { AgentTurnInput } from "../../src/modules/whatsapp/agentContract";
import {
  createAgentRunner,
  emptyEffects,
  executeTool,
  GENERIC_TOOL_ERROR,
  loadAgentContext,
  TOOL_DEFINITIONS,
  type ChatCompletionsClient,
  type ToolResult,
  type TurnEffects,
} from "../../src/modules/whatsapp/agent";
import type { Db } from "../../src/platform/db/scope";
import { seedDev } from "../../scripts/seedDev";
import { createEphemeralDb } from "../helpers/pgliteDb";

// ─────────────────────────────────────────────────────────────────────────────
// Agente de IA contra el esquema real (PGlite, rol de la app con RLS) y el negocio demo
// de `seed:dev` (estética, dos sucursales), con OpenAI MOCKEADO:
//   • cada tool contra los servicios del núcleo (sucursales, servicios, equipo,
//     disponibilidad, botones, reservar, consultar, reprogramar, cancelar, traspaso);
//   • los errores internos no llegan al modelo; solo se tocan las citas del cliente;
//   • el bucle: respuesta final, botones, acciones, límite de pasos, traspaso, uso y
//     costo, reintento ante un error transitorio, timeout y confirmación fija si OpenAI
//     falla después de agendar.
//
// Seed (ver scripts/seedDev.ts), "ahora" = miércoles 21/10/2026 09:00 en Costa Rica:
//   Escazú lun–vie 9–13 y 14–19, sáb 9–15 · Heredia mar–sáb 10–18.
//   Ana: lun/mié/vie Escazú, mar/jue Heredia · Carla: Escazú lun–sáb · Diego: Heredia mar–sáb.
//   Limpieza facial profunda 60+10 min ₡25 000 (Ana ₡28 000) · Manicura y Pedicura solo en
//   Escazú · Peeling químico no se agenda en línea · Pedicura spa con precio variable.
// ─────────────────────────────────────────────────────────────────────────────

const NOW = new Date("2026-10-21T15:00:00Z");
const THURSDAY = "2026-10-22";
const SATURDAY = "2026-10-24";

const base = await createEphemeralDb();
const db: Db = base.db;
let businessId = "";
let escazu = "";
let heredia = "";
const svc: Record<string, string> = {};
let phoneSeq = 0;

before(async () => {
  await base.client.exec("SET ROLE app_runtime");
  ({ businessId } = await seedDev(db, { now: NOW }));
  const locations = await listLocations(db, businessId);
  escazu = locations.find((l) => l.name === "Escazú")!.id;
  heredia = locations.find((l) => l.name === "Heredia")!.id;
  for (const s of await getServices(db, businessId)) svc[s.name] = s.id;
});
after(() => base.close());

const savedCap = process.env.AGENT_MAX_UPCOMING_APPOINTMENTS;
afterEach(() => {
  if (savedCap === undefined) delete process.env.AGENT_MAX_UPCOMING_APPOINTMENTS;
  else process.env.AGENT_MAX_UPCOMING_APPOINTMENTS = savedCap;
});

/** Cliente nuevo de WhatsApp (uno por test: el tope de citas es por cliente). */
async function newClient(name: string | null = "Marco Jiménez"): Promise<string> {
  phoneSeq++;
  const { client } = await findOrCreateClientByPhone(db, businessId, { phone: `+5068888${String(7000 + phoneSeq)}`, name, source: "WhatsApp" });
  return client.id;
}

function turn(clientId: string, overrides: Partial<AgentTurnInput> = {}): AgentTurnInput {
  return {
    businessId,
    conversationId: "00000000-0000-4000-8000-000000000001",
    clientId,
    clientPhone: "+50688887777",
    clientName: "Marco Jiménez",
    locationId: escazu,
    history: [{ role: "user", text: "hola", at: NOW }],
    now: NOW,
    ...overrides,
  };
}

async function tool(name: string, args: Record<string, unknown>, input: AgentTurnInput, reports: unknown[] = []): Promise<{ result: ToolResult; effects: TurnEffects }> {
  const ctx = await loadAgentContext(db, businessId);
  assert.ok(ctx);
  const effects = emptyEffects();
  const result = await executeTool(name, JSON.stringify(args), { executor: db, ctx, input, effects }, (e) => reports.push(e));
  return { result, effects };
}

const availability = (overrides: Record<string, unknown> = {}) => ({
  location_id: null,
  service_ids: [svc["Limpieza facial profunda"]],
  date: THURSDAY,
  staff_id: null,
  part_of_day: "any",
  ...overrides,
});

// ── Tools ───────────────────────────────────────────────────────────────────

test("tools: las definiciones son estrictas (todo requerido, sin propiedades extra)", () => {
  assert.equal(TOOL_DEFINITIONS.length, 10);
  for (const t of TOOL_DEFINITIONS) {
    assert.equal(t.function.strict, true, t.function.name);
    const params = t.function.parameters as { properties: object; required: string[]; additionalProperties: boolean };
    assert.equal(params.additionalProperties, false);
    assert.deepEqual([...params.required].sort(), Object.keys(params.properties).sort(), t.function.name);
  }
});

test("list_locations y list_services: por canal, sin servicios que no se agendan en línea, con precio o 'se cotiza'", async () => {
  const clientId = await newClient();
  const all = await tool("list_locations", {}, turn(clientId, { locationId: null }));
  assert.deepEqual(
    (all.result.locations as { name: string }[]).map((l) => l.name),
    ["Escazú", "Heredia"],
  );
  assert.match((all.result.locations as { hours: string }[])[0].hours, /lunes: 09:00–13:00 y 14:00–19:00/);
  const one = await tool("list_locations", {}, turn(clientId));
  assert.equal((one.result.locations as unknown[]).length, 1, "un canal de una sucursal solo muestra la suya");

  const escazuServices = (await tool("list_services", { location_id: null }, turn(clientId))).result.services as { name: string; price: string }[];
  const names = escazuServices.map((s) => s.name);
  assert.ok(names.includes("Manicura"));
  assert.ok(!names.includes("Peeling químico"), "solo panel: el agente no lo agenda");
  assert.match(escazuServices.find((s) => s.name === "Limpieza facial profunda")!.price, /25[\s.]000/);
  assert.match(escazuServices.find((s) => s.name === "Pedicura spa")!.price, /^desde .*12[\s.]000 \(se cotiza\)$/);

  const herediaServices = (await tool("list_services", { location_id: heredia }, turn(clientId, { locationId: null }))).result.services as { name: string }[];
  assert.ok(!herediaServices.some((s) => s.name === "Manicura"), "Manicura es solo de Escazú");
});

test("list_staff: quién atiende en la sucursal y quién hace un servicio, con su precio", async () => {
  const clientId = await newClient();
  const res = await tool("list_staff", { location_id: null, service_id: svc["Limpieza facial profunda"] }, turn(clientId));
  const staff = res.result.staff as { name: string; price: string }[];
  assert.deepEqual(staff.map((s) => s.name).sort(), ["Ana Rojas", "Carla Méndez"]);
  assert.match(staff.find((s) => s.name === "Ana Rojas")!.price, /28[\s.]000/, "precio propio de Ana");
});

test("check_availability: horarios de la grilla del día; próximas fechas si no hay; franja", async () => {
  const clientId = await newClient();
  const res = await tool("check_availability", availability(), turn(clientId));
  assert.equal(res.result.ok, true);
  const times = (res.result.available as { time: string; staff: string[] }[]).map((s) => s.time);
  assert.equal(times[0], "09:00");
  assert.ok(!times.includes("12:30"), "la limpieza no cabe antes del almuerzo de las 13:00");
  assert.ok((res.result.available as { staff: string[] }[])[0].staff.includes("Carla Méndez"));

  const afternoon = await tool("check_availability", availability({ part_of_day: "afternoon" }), turn(clientId));
  assert.ok((afternoon.result.available as { time: string }[]).every((s) => s.time >= "12:00"));

  // Ana el jueves está en Heredia: en Escazú no hay; se ofrecen las próximas fechas.
  const ctx = await loadAgentContext(db, businessId);
  const ana = ctx!.staff.find((s) => s.name === "Ana Rojas")!.id;
  const none = await tool("check_availability", availability({ staff_id: ana }), turn(clientId));
  assert.deepEqual(none.result.available, []);
  assert.equal((none.result.next_available as { date: string }[])[0].date, "2026-10-23");
  assert.equal(none.effects.buttons, null);
});

test("check_availability: errores del dominio cortos y seguros (sucursal, servicio, fecha)", async () => {
  const clientId = await newClient();
  const multi = await tool("check_availability", availability(), turn(clientId, { locationId: null }));
  assert.equal(multi.result.ok, false);
  assert.match(String(multi.result.error), /Falta la sucursal/);
  assert.equal((multi.result.locations as unknown[]).length, 2);

  const other = await tool("check_availability", availability({ location_id: heredia }), turn(clientId));
  assert.match(String(other.result.error), /atiende solo la sucursal Escazú/);

  const offline = await tool("check_availability", availability({ service_ids: [svc["Peeling químico"]] }), turn(clientId));
  assert.match(String(offline.result.error), /no se agenda por este medio/);

  const notHere = await tool("check_availability", availability({ location_id: heredia, service_ids: [svc.Manicura] }), turn(clientId, { locationId: null }));
  assert.match(String(notHere.result.error), /Manicura no se ofrece en la sucursal Heredia \(sí en: Escazú\)/);

  const past = await tool("check_availability", availability({ date: "2026-10-20" }), turn(clientId));
  assert.match(String(past.result.error), /ya pasó/);

  const badDate = await tool("check_availability", availability({ date: "22/10/2026" }), turn(clientId));
  assert.match(String(badDate.result.error), /^Argumentos inválidos: date: fecha inválida/);

  assert.match(String((await tool("drop_tables", {}, turn(clientId))).result.error), /Herramienta desconocida/);
});

test("offer_slots: hasta 3 botones repartidos en el día, con títulos de WhatsApp", async () => {
  const clientId = await newClient();
  const res = await tool("offer_slots", availability(), turn(clientId));
  const buttons = res.effects.buttons!;
  assert.equal(buttons.length, 3);
  assert.deepEqual(buttons[0], { id: `slot:${THURSDAY}T09:00`, title: "jue 22 · 09:00" });
  assert.ok(buttons.every((b) => b.title.length <= 20));
  assert.deepEqual(res.result.shown_as_buttons, buttons.map((b) => b.title.slice(-5)));
});

test("book → get → reschedule → cancel: el ciclo completo con acciones y confirmaciones fijas", async () => {
  const clientId = await newClient();
  const input = turn(clientId);

  const offGrid = await tool("book_appointment", { ...availability(), time: "09:07", client_name: null, notes: null }, input);
  assert.equal(offGrid.result.ok, false);
  assert.match(String(offGrid.result.error), /no está disponible/);
  assert.ok((offGrid.result.available as string[]).includes("09:00"));

  const booked = await tool("book_appointment", { ...availability(), time: "09:00", client_name: null, notes: "primera vez\n​" }, input);
  assert.equal(booked.result.ok, true, JSON.stringify(booked.result));
  const appointment = booked.result.appointment as { appointment_id: string; time: string; staff: string; location: string; price: string };
  assert.equal(appointment.time, "09:00");
  assert.equal(appointment.location, "Escazú");
  assert.equal(appointment.staff, "Carla Méndez");
  assert.deepEqual(booked.effects.actions, [{ type: "appointment_booked", appointmentId: appointment.appointment_id }]);
  assert.match(booked.effects.confirmations[0], /^✅ Tu cita quedó agendada: Limpieza facial profunda, jueves 22 de octubre a las 09:00 en Escazú\.$/);
  const [stored] = await listUpcomingAppointmentsForClient(db, businessId, clientId, { now: NOW });
  assert.equal(stored.channel, "whatsapp_ai");
  assert.equal(stored.notes, "primera vez", "texto libre saneado");

  const mine = await tool("get_my_appointments", {}, input);
  assert.equal(mine.result.count, 1);

  const busy = await tool("reschedule_appointment", { appointment_id: null, date: SATURDAY, time: "10:00" }, input);
  assert.equal(busy.result.ok, false, "Carla tiene una pedicura el sábado a las 10:00");
  assert.match(String(busy.result.error), /Carla Méndez no tiene libre esa hora/);

  const moved = await tool("reschedule_appointment", { appointment_id: null, date: THURSDAY, time: "11:00" }, input);
  assert.equal(moved.result.ok, true, JSON.stringify(moved.result));
  assert.deepEqual(moved.effects.actions, [{ type: "appointment_rescheduled", appointmentId: appointment.appointment_id }]);
  assert.equal((moved.result.appointment as { staff: string }).staff, "Carla Méndez", "se mueve con su persona");

  const cancelled = await tool("cancel_appointment", { appointment_id: appointment.appointment_id, reason: "Me surgió algo" }, input);
  assert.equal(cancelled.result.ok, true);
  assert.deepEqual(cancelled.effects.actions, [{ type: "appointment_cancelled", appointmentId: appointment.appointment_id }]);
  assert.match(cancelled.effects.confirmations[0], /quedó cancelada/);
  assert.equal((await tool("get_my_appointments", {}, input)).result.count, 0);
});

test("book_appointment: tope de citas próximas por cliente y nombre dado por WhatsApp a la nota", async () => {
  process.env.AGENT_MAX_UPCOMING_APPOINTMENTS = "1";
  const clientId = await newClient(null);
  const input = turn(clientId, { clientName: "Sin nombre" });
  const first = await tool(
    "book_appointment",
    { ...availability({ service_ids: [svc["Depilación de cejas"]], date: SATURDAY }), time: "12:00", client_name: "Laura Vargas", notes: null },
    input,
  );
  assert.equal(first.result.ok, true, JSON.stringify(first.result));
  const [stored] = await listUpcomingAppointmentsForClient(db, businessId, clientId, { now: NOW });
  assert.match(stored.notes ?? "", /Nombre dado por WhatsApp: Laura Vargas/);

  const second = await tool(
    "book_appointment",
    { ...availability({ service_ids: [svc["Depilación de cejas"]], date: SATURDAY }), time: "13:00", client_name: null, notes: null },
    input,
  );
  assert.equal(second.result.ok, false);
  assert.match(String(second.result.error), /el máximo por cliente es 1/);
  assert.equal((second.result.appointments as unknown[]).length, 1);
});

test("reprogramar o cancelar solo toca las citas DEL cliente (no por un id cualquiera)", async () => {
  const clientId = await newClient();
  const others = await listAppointments(db, businessId, { from: NOW, to: new Date("2026-10-26T06:00:00Z"), statuses: ["pending", "confirmed"] });
  const foreign = others.find((a) => a.clientId !== clientId)!;
  assert.ok(foreign, "el seed tiene citas futuras de otros clientes");
  const own = await tool(
    "book_appointment",
    { ...availability({ service_ids: [svc["Depilación de cejas"]], date: SATURDAY }), time: "14:00", client_name: null, notes: null },
    turn(clientId),
  );
  assert.equal(own.result.ok, true, JSON.stringify(own.result));
  for (const name of ["cancel_appointment", "reschedule_appointment"]) {
    const args = name === "cancel_appointment" ? { appointment_id: foreign.id, reason: null } : { appointment_id: foreign.id, date: SATURDAY, time: "14:30" };
    const res = await tool(name, args, turn(clientId));
    assert.equal(res.result.ok, false, name);
    assert.match(String(res.result.error), /No encontré esa cita entre las próximas del cliente/);
    assert.deepEqual(res.effects.actions, []);
  }
  const again = (await listAppointments(db, businessId, { from: NOW, to: new Date("2026-10-26T06:00:00Z") })).find((a) => a.id === foreign.id);
  assert.notEqual(again?.status, "cancelled");
});

test("handoff_to_human anota el traspaso con el motivo saneado", async () => {
  const res = await tool("handoff_to_human", { reason: "  Alergia a una crema\n\n reciente " }, turn(await newClient()));
  assert.equal(res.result.ok, true);
  assert.deepEqual(res.effects.handoff, { reason: "Alergia a una crema reciente" });
});

test("un error interno NO llega al modelo: mensaje genérico y el detalle al reporte", async () => {
  const ctx = await loadAgentContext(db, businessId);
  const broken = new Proxy(db, {
    get(target, prop, receiver) {
      if (prop === "transaction") return () => Promise.reject(new Error("connection to 10.0.0.5 failed: password=hunter2"));
      return Reflect.get(target, prop, receiver);
    },
  });
  const reports: unknown[] = [];
  const effects = emptyEffects();
  const result = await executeTool("get_my_appointments", "{}", { executor: broken, ctx: ctx!, input: turn(await newClient()), effects }, (e) => reports.push(e));
  assert.deepEqual(result, { ok: false, error: GENERIC_TOOL_ERROR });
  assert.doesNotMatch(JSON.stringify(result), /hunter2|10\.0\.0\.5/);
  assert.equal(reports.length, 1);
});

// ── Bucle (OpenAI mockeado) ─────────────────────────────────────────────────

type Step = ChatCompletion | Error | ((body: ChatCompletionCreateParamsNonStreaming, signal?: AbortSignal) => Promise<ChatCompletion>);

const USAGE = { prompt_tokens: 1000, completion_tokens: 50, total_tokens: 1050, prompt_tokens_details: { cached_tokens: 400 } };

function completion(message: { content?: string | null; tool_calls?: { name: string; args: Record<string, unknown> }[] }): ChatCompletion {
  return {
    id: "cmpl",
    object: "chat.completion",
    created: 0,
    model: "gpt-4o-mini",
    usage: USAGE,
    choices: [
      {
        index: 0,
        finish_reason: message.tool_calls ? "tool_calls" : "stop",
        logprobs: null,
        message: {
          role: "assistant",
          content: message.content ?? null,
          refusal: null,
          tool_calls: message.tool_calls?.map((c, i) => ({ id: `call_${i}`, type: "function" as const, function: { name: c.name, arguments: JSON.stringify(c.args) } })),
        },
      },
    ],
  } as ChatCompletion;
}

const say = (content: string) => completion({ content });
const call = (name: string, args: Record<string, unknown>) => completion({ tool_calls: [{ name, args }] });

function scripted(steps: Step[]): ChatCompletionsClient & { bodies: ChatCompletionCreateParamsNonStreaming[] } {
  const bodies: ChatCompletionCreateParamsNonStreaming[] = [];
  let i = 0;
  return {
    bodies,
    chat: {
      completions: {
        async create(body, options) {
          bodies.push(structuredClone(body));
          const step = steps[Math.min(i++, steps.length - 1)];
          if (step instanceof Error) throw step;
          if (typeof step === "function") return step(body, options?.signal);
          return step;
        },
      },
    },
  };
}

const runnerDeps = { model: "gpt-4o-mini", retryDelayMs: 1, timeoutMs: 5000, history: { maxMessages: 20, maxDays: 30 } };

test("runner: respuesta de texto, request con tools estrictas, caché por negocio y costo del turno", async () => {
  const openai = scripted([say("¡Hola Marco! ¿En qué te ayudo?")]);
  const result = await createAgentRunner({ ...runnerDeps, openai })(db, turn(await newClient()));
  assert.deepEqual(result.replies, [{ text: "¡Hola Marco! ¿En qué te ayudo?" }]);
  assert.deepEqual(result.actions, []);
  // 600 no cacheados × 0,15 + 400 cacheados × 0,075 + 50 × 0,60 (USD por 1M) = 150 micro-dólares.
  assert.deepEqual(result.usage, { inputTokens: 1000, outputTokens: 50, costMicros: 150 });
  const body = openai.bodies[0];
  assert.equal(body.parallel_tool_calls, false);
  assert.equal(body.prompt_cache_key, `business:${businessId}`);
  assert.equal(body.temperature, 0.3);
  assert.equal(body.tools?.length, 10);
  assert.match(String(body.messages[0].content), /asistente de WhatsApp de "Estética Demo", un negocio de estética/);
  assert.match(String(body.messages[0].content), /especialista/);
  assert.match(String(body.messages.at(-2)?.content), /atiende solo la sucursal Escazú/);
});

test("runner: offer_slots deja botones en la respuesta final; book_appointment devuelve la acción", async () => {
  const clientId = await newClient();
  const offer = scripted([call("offer_slots", availability()), say("Para la limpieza del jueves en Escazú tengo estos 👇")]);
  const offered = await createAgentRunner({ ...runnerDeps, openai: offer })(db, turn(clientId));
  assert.equal(offered.replies.length, 1);
  assert.equal(offered.replies[0].buttons?.length, 3);
  assert.equal(offered.usage.inputTokens, 2000, "uso sumado de los dos pasos");
  const toolMessage = offer.bodies[1].messages.at(-1);
  assert.equal(toolMessage?.role, "tool");
  assert.match(String(toolMessage?.content), /"shown_as_buttons"/);

  const book = scripted([
    call("book_appointment", { ...availability({ service_ids: [svc["Hidratación facial"]] }), time: "14:00", client_name: null, notes: null }),
    say("¡Listo! Te esperamos el jueves a las 14:00."),
  ]);
  const booked = await createAgentRunner({ ...runnerDeps, openai: book })(db, turn(clientId));
  assert.equal(booked.actions.length, 1);
  assert.equal(booked.actions[0].type, "appointment_booked");
  assert.deepEqual(booked.replies, [{ text: "¡Listo! Te esperamos el jueves a las 14:00." }]);
});

test("runner: handoff_to_human corta el turno con la acción y el aviso fijo en el registro del negocio", async () => {
  const openai = scripted([call("handoff_to_human", { reason: "Pregunta por una reacción alérgica" }), say("no debería llegar")]);
  const result = await createAgentRunner({ ...runnerDeps, openai })(db, turn(await newClient()));
  assert.deepEqual(result.actions, [{ type: "handoff", reason: "Pregunta por una reacción alérgica" }]);
  assert.equal(result.replies.length, 1);
  assert.match(result.replies[0].text, /^Dejame consultarlo con una persona del equipo/);
  assert.equal(openai.bodies.length, 1);
});

test("runner: al agotar los pasos sin respuesta pasa a una persona", async () => {
  const openai = scripted([call("list_locations", {})]);
  const result = await createAgentRunner({ ...runnerDeps, openai, maxSteps: 3 })(db, turn(await newClient()));
  assert.equal(openai.bodies.length, 3);
  assert.equal(result.actions.length, 1);
  assert.equal(result.actions[0].type, "handoff");
  assert.equal(result.usage.inputTokens, 3000);
});

test("runner: si OpenAI falla DESPUÉS de agendar, confirma con texto fijo (no relanza: no se duplica)", async () => {
  const openai = scripted([
    call("book_appointment", { ...availability({ service_ids: [svc["Depilación de cejas"]], date: SATURDAY }), time: "13:30", client_name: null, notes: null }),
    new Error("500 upstream"),
  ]);
  const reports: unknown[] = [];
  const result = await createAgentRunner({ ...runnerDeps, openai, retries: 0, reportError: (e) => reports.push(e) })(db, turn(await newClient()));
  assert.equal(result.actions[0].type, "appointment_booked");
  assert.match(result.replies[0].text, /^✅ Tu cita quedó agendada: Depilación de cejas, sábado 24 de octubre a las 13:30 en Escazú\.$/);
  assert.equal(reports.length, 1);
});

test("runner: sin nada guardado, un error de OpenAI se relanza; uno transitorio se reintenta", async () => {
  const fatal = new Error("401 invalid api key");
  await assert.rejects(createAgentRunner({ ...runnerDeps, openai: scripted([fatal]) })(db, turn(await newClient())), (e) => e === fatal);

  const flaky = scripted([new APIConnectionError({ message: "socket hang up" }), say("Hola de nuevo")]);
  const result = await createAgentRunner({ ...runnerDeps, openai: flaky, retries: 1 })(db, turn(await newClient()));
  assert.equal(flaky.bodies.length, 2);
  assert.deepEqual(result.replies, [{ text: "Hola de nuevo" }]);
});

test("runner: cada llamada tiene timeout (y el timeout cuenta como transitorio)", async () => {
  const hang = (_body: unknown, signal?: AbortSignal) =>
    new Promise<ChatCompletion>((_resolve, reject) => {
      signal?.addEventListener("abort", () => reject(signal.reason));
    });
  const clientId = await newClient();
  await assert.rejects(
    createAgentRunner({ ...runnerDeps, openai: scripted([hang]), timeoutMs: 50, retries: 0 })(db, turn(clientId)),
    (e: Error) => e.name === "TimeoutError",
  );
  const recovered = scripted([hang, say("Perdón la demora")]);
  const result = await createAgentRunner({ ...runnerDeps, openai: recovered, timeoutMs: 50, retries: 1 })(db, turn(clientId));
  assert.deepEqual(result.replies, [{ text: "Perdón la demora" }]);
});

test("runner: un error interno de una tool no se filtra al siguiente request del modelo", async () => {
  const clientId = await newClient();
  let failing = false;
  const proxy = new Proxy(db, {
    get(target, prop, receiver) {
      if (prop === "transaction" && failing) return () => Promise.reject(new Error("deadlock detected on relation appointments (secreto)"));
      return Reflect.get(target, prop, receiver);
    },
  });
  const openai = scripted([
    async () => {
      failing = true; // el contexto ya se cargó: falla la tool
      return call("get_my_appointments", {});
    },
    async () => {
      failing = false;
      return say("Disculpá, tuve un problema. ¿Te paso con una persona?");
    },
  ]);
  const reports: unknown[] = [];
  await createAgentRunner({ ...runnerDeps, openai, reportError: (e) => reports.push(e) })(proxy, turn(clientId));
  const toolMessage = String(openai.bodies[1].messages.at(-1)?.content);
  assert.match(toolMessage, /problema técnico/);
  assert.doesNotMatch(toolMessage, /deadlock|secreto|appointments/);
  assert.equal(reports.length, 1);
});

test("runner: canal de varias sucursales → el contexto pide preguntar y la tool exige la sucursal", async () => {
  const openai = scripted([call("check_availability", availability()), say("¿En cuál sucursal te queda mejor, Escazú o Heredia?")]);
  const result = await createAgentRunner({ ...runnerDeps, openai })(db, turn(await newClient(), { locationId: null }));
  assert.match(String(openai.bodies[0].messages.at(-2)?.content), /atiende todas las sucursales/);
  assert.match(String(openai.bodies[1].messages.at(-1)?.content), /Falta la sucursal/);
  assert.equal(result.replies[0].text, "¿En cuál sucursal te queda mejor, Escazú o Heredia?");
});

test("runner: historial acotado y con fechas en el request", async () => {
  const old = Array.from({ length: 40 }, (_, i) => ({
    role: (i % 2 ? "assistant" : "user") as "user" | "assistant",
    text: `viejo ${i}`,
    at: new Date("2026-10-14T16:00:00Z"),
  }));
  const openai = scripted([say("ok")]);
  await createAgentRunner({ ...runnerDeps, openai, history: { maxMessages: 6, maxDays: 30 } })(
    db,
    turn(await newClient(), { history: [...old, { role: "user", text: "¿tienen campo mañana?", at: NOW }] }),
  );
  const contents = openai.bodies[0].messages.map((m) => String(m.content));
  assert.equal(contents.filter((c) => c.startsWith("viejo")).length, 5);
  assert.ok(contents.some((c) => /Mensajes del miércoles 14 de octubre \(hace 7 días\)/.test(c)));
  assert.equal(contents.at(-1), "¿tienen campo mañana?");
});
