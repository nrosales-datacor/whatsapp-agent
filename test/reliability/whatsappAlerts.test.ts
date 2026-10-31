import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { eq } from "drizzle-orm";

// ─────────────────────────────────────────────────────────────────────────────
// Alertas de «bot mudo» del módulo WhatsApp de punta a punta, sobre PGlite como el rol de
// la app (Graph, OpenAI y push son dobles de ../helpers):
//   • `llm_unavailable`: N turnos del agente que terminan en la disculpa → UNA alerta
//     (cooldown), contando el error transitorio del ÚLTIMO intento (que no relanza ni
//     llega al DLQ) y no los intentos que la cola todavía va a reintentar.
//   • `whatsapp_send_failing`: rechazos de Meta al enviar que no son de token.
//   • `whatsapp_inbound_silent`: horas hábiles sin entrantes en un negocio con tráfico.
// ─────────────────────────────────────────────────────────────────────────────

process.env.TOKENS_ENCRYPTION_KEY = "d".repeat(64);

const { registerJobHandlers } = await import("../../src/jobs");
const { conversations, messages } = await import("../../src/modules/whatsapp/schema");
const { locationHours } = await import("../../src/modules/business/schema");
const { invalidateBusinessContext } = await import("../../src/modules/business");
const { WHATSAPP_INBOUND_JOB } = await import("../../src/modules/whatsapp/ingest");
const { processWebhookBody } = await import("../../src/modules/whatsapp/webhook");
const { handleInboundJob } = await import("../../src/modules/whatsapp/pipeline");
const { GraphError } = await import("../../src/modules/whatsapp/graph");
const { LLM_UNAVAILABLE_ALERT, WHATSAPP_SEND_FAILING_ALERT } = await import("../../src/modules/whatsapp/alerts");
const { checkInboundSilence, WHATSAPP_INBOUND_SILENT_ALERT } = await import("../../src/modules/whatsapp/inboundWatch");
const { _resetChannelStateForTests } = await import("../../src/modules/whatsapp/channels");
const { _resetIngestBucketsForTests } = await import("../../src/modules/whatsapp/limits");
const { withSystem, withTenant } = await import("../../src/platform/db/scope");
const { jobs } = await import("../../src/platform/queue/schema");
const { _resetShutdownForTests } = await import("../../src/platform/net/shutdown");
const { _resetJobHandlersForTests } = await import("../../src/platform/queue/handlers");
const { _resetAlertsForTests, _setWebhookSenderForTests } = await import("../../src/platform/observability/alerts");
const { _resetRateAlertsForTests } = await import("../../src/platform/observability/rateAlert");
const { createEphemeralDb } = await import("../helpers/pgliteDb");
const { allJobs, silenceConsole } = await import("../helpers/queue");
const { createSchedulingWorld, crAt, crDay } = await import("../helpers/schedulingFixtures");
const { createChannel, fakeWhatsApp, inboundBody } = await import("../helpers/whatsappFixtures");

type Fake = ReturnType<typeof fakeWhatsApp>;

const base = await createEphemeralDb();
const { db } = base;
let restoreConsole: () => void;
let fake: Fake;
/** Alertas que salieron por el webhook: [tipo, negocio | null]. */
let alerts: { type: string; tenantId: string | null; text: string }[] = [];
const previousUrl = process.env.ALERTS_WEBHOOK_URL;

before(async () => {
  restoreConsole = silenceConsole();
  await base.client.exec("SET ROLE app_runtime");
  process.env.ALERTS_WEBHOOK_URL = "https://hooks.ejemplo.test/alertas";
});
after(async () => {
  restoreConsole();
  _setWebhookSenderForTests(null);
  if (previousUrl === undefined) delete process.env.ALERTS_WEBHOOK_URL;
  else process.env.ALERTS_WEBHOOK_URL = previousUrl;
  await base.close();
});
beforeEach(() => {
  _resetJobHandlersForTests();
  _resetShutdownForTests();
  _resetChannelStateForTests();
  _resetIngestBucketsForTests();
  _resetAlertsForTests();
  _resetRateAlertsForTests();
  alerts = [];
  _setWebhookSenderForTests(async (_url, body) => {
    // "🚨 [selyon-crm/test] tipo · tenant <id>: mensaje"
    const m = /\] ([a-z_]+)(?: · tenant ([0-9a-f-]+))?:/.exec(body.text);
    alerts.push({ type: m?.[1] ?? "?", tenantId: m?.[2] ?? null, text: body.text });
  });
  fake = fakeWhatsApp(db);
  registerJobHandlers({ whatsapp: fake.deps });
});

async function world() {
  const w = await createSchedulingWorld(db);
  const channel = await createChannel(db, w.businessId);
  return { ...w, ...channel };
}
type World = Awaited<ReturnType<typeof world>>;

let phoneSeq = 0;
const newPhone = () => `5068${String(8000000 + ++phoneSeq).padStart(7, "0")}`;

/** Un mensaje entrante de un cliente nuevo; devuelve su job pendiente. */
async function inboundJob(w: World) {
  const from = newPhone();
  const outcomes = await processWebhookBody(db, inboundBody({ phoneNumberId: w.phoneNumberId, from, text: "hola" }));
  assert.deepEqual(outcomes, ["queued"]);
  const [job] = (await allJobs(db)).filter((j) => j.businessId === w.businessId && j.status === "pending" && j.type === WHATSAPP_INBOUND_JOB);
  assert.ok(job, "hay un job whatsapp.inbound pendiente");
  return { job, from };
}

const ctxOf = (job: { id: string; businessId: string | null }, attempt: number, isLastAttempt: boolean) => ({
  jobId: job.id,
  type: WHATSAPP_INBOUND_JOB,
  businessId: job.businessId,
  attempt,
  maxAttempts: 5,
  isLastAttempt,
  signal: new AbortController().signal,
  db,
});

const markDone = (id: string) => withSystem(db, (tx) => tx.update(jobs).set({ status: "done" }).where(eq(jobs.id, id)));
const alertsOf = (type: string) => alerts.filter((a) => a.type === type);
const sentTo = (to: string) => fake.sent.filter((s) => s.to === `+${to}`);

// ── llm_unavailable ──────────────────────────────────────────────────────────

test("llm_unavailable: 6 turnos con el agente caído → UNA alerta del negocio (cooldown); cada cliente recibe la disculpa", async () => {
  const w = await world();
  fake.agentResult = () => {
    throw Object.assign(new Error("OpenAI 401: key revocada"), { status: 401 });
  };
  for (let i = 0; i < 6; i++) {
    const { job, from } = await inboundJob(w);
    await handleInboundJob(job.payload, ctxOf(job, 1, false), fake.deps); // no transitorio: no relanza
    assert.match(sentTo(from)[0].text!, /tuvimos un problemita/);
    await markDone(job.id);
    assert.equal(alertsOf(LLM_UNAVAILABLE_ALERT).length, i < 4 ? 0 : 1, `tras ${i + 1} fallos`);
  }
  assert.deepEqual(alertsOf(LLM_UNAVAILABLE_ALERT).map((a) => a.tenantId), [w.businessId]);
  assert.match(alertsOf(LLM_UNAVAILABLE_ALERT)[0].text, /^🚨 .*5 turnos del agente fallaron/);
});

test("llm_unavailable: el transitorio cuenta en el ÚLTIMO intento (sin DLQ), no en los que la cola reintenta", async () => {
  const w = await world();
  fake.agentResult = () => {
    throw Object.assign(new Error("OpenAI 503"), { transient: true });
  };
  for (let i = 0; i < 5; i++) {
    const { job } = await inboundJob(w);
    await assert.rejects(handleInboundJob(job.payload, ctxOf(job, 1, false), fake.deps), /OpenAI 503/);
    await assert.rejects(handleInboundJob(job.payload, ctxOf(job, 2, false), fake.deps), /OpenAI 503/);
    assert.equal(alertsOf(LLM_UNAVAILABLE_ALERT).length, 0, "los intentos con reintento por delante no cuentan");
    await handleInboundJob(job.payload, ctxOf(job, 3, true), fake.deps); // último: disculpa, el job termina «bien»
    await markDone(job.id);
  }
  assert.equal(alertsOf(LLM_UNAVAILABLE_ALERT).length, 1);
  assert.equal(alertsOf(LLM_UNAVAILABLE_ALERT)[0].tenantId, w.businessId);
});

// ── whatsapp_send_failing ────────────────────────────────────────────────────

test("whatsapp_send_failing: Meta rechaza 5 respuestas (cuenta bloqueada, no token) → alerta del negocio", async () => {
  const w = await world();
  for (let i = 0; i < 5; i++) {
    const { job } = await inboundJob(w);
    fake.failNextSend = new GraphError("Graph send (403): cuenta restringida", { status: 403, code: 368, transient: false });
    await handleInboundJob(job.payload, ctxOf(job, 1, false), fake.deps);
    await markDone(job.id);
  }
  assert.deepEqual(alertsOf(WHATSAPP_SEND_FAILING_ALERT).map((a) => a.tenantId), [w.businessId]);
  assert.equal(alertsOf(LLM_UNAVAILABLE_ALERT).length, 0, "el agente respondió bien");
});

test("whatsapp_send_failing: los rechazos por token (401 / 190) no cuentan (tienen su alerta propia)", async () => {
  const w = await world();
  for (let i = 0; i < 6; i++) {
    const { job } = await inboundJob(w);
    fake.failNextSend = new GraphError("Graph send (400): token vencido", { status: 400, code: 190, transient: false });
    await handleInboundJob(job.payload, ctxOf(job, 1, false), fake.deps);
    await markDone(job.id);
  }
  assert.equal(alertsOf(WHATSAPP_SEND_FAILING_ALERT).length, 0);
});

// ── whatsapp_inbound_silent ──────────────────────────────────────────────────

/**
 * Negocio con `count` entrantes repartidos en la semana previa a `last` (en horario) y el
 * último justo en `last`. Las sucursales del mundo abren 08:00–19:00 todos los días (CR).
 */
async function trafficWorld(count: number, last: Date) {
  const w = await world();
  const { job } = await inboundJob(w); // crea cliente + conversación + 1 mensaje
  await markDone(job.id);
  const [conv] = await withTenant(db, w.businessId, (tx) => tx.select().from(conversations).where(eq(conversations.businessId, w.businessId)));
  await withTenant(db, w.businessId, (tx) => tx.delete(messages).where(eq(messages.conversationId, conv.id)));
  const rows = Array.from({ length: count }, (_, i) => ({
    businessId: w.businessId,
    conversationId: conv.id,
    role: "user",
    content: "x",
    // de a una hora hacia atrás desde `last` (algunos caen de noche: para el ritmo da igual)
    createdAt: new Date(last.getTime() - i * 60 * 60_000),
  }));
  await withTenant(db, w.businessId, (tx) => tx.insert(messages).values(rows));
  return { ...w, conversationId: conv.id };
}

const day0 = crDay(1); // mañana: siempre en el futuro del reloj real (los mensajes quedan en el pasado de `now`)
const now1700 = crAt(day0, "17:00");

test("sin entrantes: 9 h hábiles de silencio en un negocio con tráfico → whatsapp_inbound_silent; al volver a entrar, se olvida", async () => {
  // Último entrante ayer 10:00 → silencio hábil: ayer 10–19 (9 h) + hoy 08–17 (9 h) = 18 h.
  const w = await trafficWorld(70, crAt(crDay(0), "10:00"));
  const result = await checkInboundSilence(db, { silenceHours: 6, minExpected: 5 }, now1700);
  const mine = result.find((r) => r.businessId === w.businessId);
  assert.ok(mine, "alertó este negocio");
  assert.equal(mine.silentOpenHours, 18);
  const alert = alertsOf(WHATSAPP_INBOUND_SILENT_ALERT).find((a) => a.tenantId === w.businessId);
  assert.match(alert!.text, /⚠️ .*18 h hábiles sin mensajes entrantes/);

  const again = await checkInboundSilence(db, { silenceHours: 6, minExpected: 5 }, new Date(now1700.getTime() + 30 * 60_000));
  assert.ok(!again.some((r) => r.businessId === w.businessId), "cooldown: no repite en el tick siguiente");

  // Entra un mensaje: el vigilante olvida la alerta; una recaída vuelve a salir sin esperar el cooldown.
  await withTenant(db, w.businessId, (tx) =>
    tx.insert(messages).values({ businessId: w.businessId, conversationId: w.conversationId, role: "user", content: "x", createdAt: crAt(day0, "16:30") }),
  );
  assert.ok(!(await checkInboundSilence(db, { silenceHours: 6, minExpected: 5 }, now1700)).some((r) => r.businessId === w.businessId));
  const relapse = await checkInboundSilence(db, { silenceHours: 6, minExpected: 5 }, crAt(crDay(2), "15:00"));
  assert.ok(relapse.some((r) => r.businessId === w.businessId), "silencio de nuevo (16:30 → 15:00 del día siguiente ≈ 9,5 h hábiles)");
});

test("sin entrantes: no alerta de noche, con poco tráfico, con silencio corto ni con el vigilante apagado", async () => {
  const w = await trafficWorld(70, crAt(crDay(0), "10:00"));
  const has = (r: { businessId: string }[]) => r.some((x) => x.businessId === w.businessId);
  assert.ok(!has(await checkInboundSilence(db, { silenceHours: 6, minExpected: 5 }, crAt(day0, "22:00"))), "cerrado: no despierta a nadie");
  assert.ok(!has(await checkInboundSilence(db, { silenceHours: 30, minExpected: 5 }, now1700)), "18 h < umbral de 30");
  assert.ok(!has(await checkInboundSilence(db, { silenceHours: 0, minExpected: 5 }, now1700)), "0 = apagado");

  const quiet = await trafficWorld(3, crAt(crDay(0), "10:00"));
  const r = await checkInboundSilence(db, { silenceHours: 6, minExpected: 5 }, now1700);
  assert.ok(!r.some((x) => x.businessId === quiet.businessId), "3 mensajes por semana: el silencio no es señal");
});

test("sin entrantes: sin horario cargado, cuentan todas las horas", async () => {
  const w = await trafficWorld(200, new Date(now1700.getTime() - 7 * 60 * 60_000));
  await withTenant(db, w.businessId, (tx) => tx.delete(locationHours).where(eq(locationHours.businessId, w.businessId)));
  invalidateBusinessContext(w.businessId);
  const r = await checkInboundSilence(db, { silenceHours: 6, minExpected: 5 }, now1700);
  assert.equal(r.find((x) => x.businessId === w.businessId)?.silentOpenHours, 7);
});
