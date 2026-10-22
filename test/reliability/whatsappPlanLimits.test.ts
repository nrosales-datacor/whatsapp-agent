import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, test } from "node:test";
import { and, eq } from "drizzle-orm";

// ─────────────────────────────────────────────────────────────────────────────
// Planes × WhatsApp (I2-D sobre I2-A/B), con la composición real (src/plans.ts): el
// servicio de billing le da al pipeline los topes del agente (`aiLimitsFromPlan`) y a la
// cola el chequeo de negocio pausado (`createJobGate`). Cola real sobre PGlite como el
// rol de la app; Graph, OpenAI, Storage y push son dobles. Casos:
//   • Básico que agotó su tope de conversaciones del mes → el agente no corre, aviso al
//     cliente y la conversación pasa a una persona (y por debajo del tope, sí corre);
//   • Pro sin agente → el agente no corre ni se le responde nada al cliente;
//   • negocio pausado → el entrante se guarda y no se responde: el job en vuelo corre
//     igual (guarda el adjunto, no responde) y el resto del trabajo se posterga.
// ─────────────────────────────────────────────────────────────────────────────

process.env.TOKENS_ENCRYPTION_KEY = "d".repeat(64);

const { createJobGate, registerJobHandlers } = await import("../../src/jobs");
const { aiLimitsFromPlan, createPlans } = await import("../../src/plans");
const { PRO_WITHOUT_AGENT } = await import("../../src/modules/billing");
const { invalidateBusinessContext } = await import("../../src/modules/business");
const { businesses } = await import("../../src/modules/business/schema");
const { clients } = await import("../../src/modules/clients/schema");
const { conversations, messages } = await import("../../src/modules/whatsapp/schema");
const { WHATSAPP_INBOUND_JOB } = await import("../../src/modules/whatsapp/ingest");
const { WHATSAPP_REMINDER_JOB } = await import("../../src/modules/whatsapp/reminders");
const { processWebhookBody } = await import("../../src/modules/whatsapp/webhook");
const { incrementAiUsage } = await import("../../src/modules/whatsapp/usage");
const { _resetChannelStateForTests } = await import("../../src/modules/whatsapp/channels");
const { _resetIngestBucketsForTests } = await import("../../src/modules/whatsapp/limits");
const { withSystem, withTenant } = await import("../../src/platform/db/scope");
const { enqueue } = await import("../../src/platform/queue");
const { _resetShutdownForTests } = await import("../../src/platform/net/shutdown");
const { _resetJobHandlersForTests } = await import("../../src/platform/queue/handlers");
const { startQueueWorker } = await import("../../src/platform/queue/worker");
const { createEphemeralDb } = await import("../helpers/pgliteDb");
const { allJobs, getJob, silenceConsole, waitFor } = await import("../helpers/queue");
const { createTestBusiness } = await import("../helpers/identityFixtures");
const { createChannel, fakeWhatsApp, inboundBody } = await import("../helpers/whatsappFixtures");

type Fake = ReturnType<typeof fakeWhatsApp>;
type ExtraModules = NonNullable<Parameters<typeof createTestBusiness>[1]>["extraModules"];

const base = await createEphemeralDb();
const { db } = base;
let restoreConsole: () => void;
let fake: Fake;

before(async () => {
  restoreConsole = silenceConsole();
  await base.client.exec("SET ROLE app_runtime");
});
after(async () => {
  restoreConsole();
  await base.close();
});
beforeEach(() => {
  _resetJobHandlersForTests();
  _resetShutdownForTests();
  _resetChannelStateForTests();
  _resetIngestBucketsForTests();
  // Los dobles de Graph y del agente, con los límites REALES del plan (lo que compone src/jobs.ts).
  fake = fakeWhatsApp(db, { getAiLimits: aiLimitsFromPlan(createPlans(db)) });
  registerJobHandlers({ whatsapp: fake.deps });
});
afterEach(() => {
  _resetShutdownForTests();
});

async function world(options: { plan: "basic" | "pro"; extraModules?: ExtraModules }) {
  const business = await createTestBusiness(db, { plan: options.plan, locations: ["Central"], extraModules: options.extraModules });
  const channel = await createChannel(db, business.businessId);
  return { ...business, ...channel };
}
type World = Awaited<ReturnType<typeof world>>;

let phoneSeq = 0;
const newPhone = () => `5068${String(8000000 + ++phoneSeq).padStart(7, "0")}`;

async function receive(w: World, from: string, input: { text?: string; type?: string; message?: Record<string, unknown> } = {}) {
  return processWebhookBody(db, inboundBody({ phoneNumberId: w.phoneNumberId, from, ...input }));
}

/** Corre la cola real (con el chequeo de pausa de la composición) hasta que no quede nada por correr ya. */
async function drain(jobIds?: string[]): Promise<void> {
  const worker = startQueueWorker({ db, concurrency: 1, pollMs: 10, retentionDays: 0, canRunJob: createJobGate(db) });
  try {
    await waitFor(
      async () => (await allJobs(db)).filter((j) => !jobIds || jobIds.includes(j.id)).every((j) => j.status === "done" || j.status === "dead"),
      "cola vacía",
      30_000,
    );
  } finally {
    await worker.stop();
  }
  const dead = (await allJobs(db)).filter((j) => j.status === "dead");
  assert.equal(dead.length, 0, `jobs en dead: ${dead.map((d) => d.lastError).join(" | ")}`);
}

async function conversationOf(w: World, from: string) {
  const [client] = await withTenant(db, w.businessId, (tx) => tx.select().from(clients).where(and(eq(clients.businessId, w.businessId), eq(clients.phone, `+${from}`))));
  const [conv] = await withTenant(db, w.businessId, (tx) => tx.select().from(conversations).where(eq(conversations.clientId, client.id)));
  return conv;
}

const messagesOf = (w: World) => withTenant(db, w.businessId, (tx) => tx.select().from(messages).where(eq(messages.businessId, w.businessId)));
const inboundJobsOf = async (w: World) => (await allJobs(db)).filter((j) => j.businessId === w.businessId && j.type === WHATSAPP_INBOUND_JOB);
const sentTo = (to: string) => fake.sent.filter((s) => s.to === `+${to}`);

async function setStatus(businessId: string, status: "active" | "paused"): Promise<void> {
  await withSystem(db, (tx) => tx.update(businesses).set({ status }).where(eq(businesses.id, businessId)));
  invalidateBusinessContext(businessId);
}

// ── Tope del plan ────────────────────────────────────────────────────────────

test("Básico por debajo de su tope: el agente responde (límites del plan, no un default)", async () => {
  const w = await world({ plan: "basic", extraModules: { limits: { aiConversations: 2 } } });
  await incrementAiUsage(db, w.businessId, { conversationsStarted: 1 });
  const from = newPhone();
  assert.deepEqual(await receive(w, from, { text: "hola" }), ["queued"]);
  await drain();
  assert.equal(fake.agentCalls.length, 1);
  assert.equal(sentTo(from).length, 1);
  assert.equal((await conversationOf(w, from)).mode, "bot");
});

test("Básico que agotó el tope de conversaciones del mes: el agente no corre y la conversación pasa a una persona", async () => {
  const w = await world({ plan: "basic", extraModules: { limits: { aiConversations: 2 } } });
  await incrementAiUsage(db, w.businessId, { conversationsStarted: 2 });
  const from = newPhone();
  assert.deepEqual(await receive(w, from, { text: "hola, quiero una cita" }), ["queued"]);
  await drain();
  assert.equal(fake.agentCalls.length, 0, "sin LLM pasado el tope");
  assert.equal(sentTo(from).length, 1);
  assert.match(sentTo(from)[0].text!, /En un momento te atiende alguien del equipo/);
  assert.equal((await conversationOf(w, from)).mode, "human");
});

test("Pro sin agente: el entrante queda guardado, el agente no corre y no se le responde al cliente", async () => {
  const w = await world({ plan: "pro", extraModules: { ...PRO_WITHOUT_AGENT } });
  const from = newPhone();
  assert.deepEqual(await receive(w, from, { text: "hola" }), ["queued"]);
  await drain();
  assert.equal(fake.agentCalls.length, 0);
  assert.equal(sentTo(from).length, 0);
  assert.equal((await messagesOf(w)).length, 1);
  assert.equal((await conversationOf(w, from)).mode, "bot", "no se pasa a una bandeja que el plan no tiene");
});

// ── Negocio pausado ──────────────────────────────────────────────────────────

test("negocio pausado: el job en vuelo corre igual (guarda la foto, no responde), lo que entra después solo se guarda y lo demás se posterga", async () => {
  const w = await world({ plan: "basic" });
  const from = newPhone();
  // Entran un texto y una foto con el negocio activo (jobs encolados) y lo pausan antes de que corran.
  assert.deepEqual(await receive(w, from, { text: "hola" }), ["queued"]);
  assert.deepEqual(await receive(w, from, { type: "image", message: { image: { id: "IMG-PAUSA", mime_type: "image/jpeg" } } }), ["queued"]);
  const reminder = await enqueue(db, {
    type: WHATSAPP_REMINDER_JOB,
    businessId: w.businessId,
    payload: { reminderId: crypto.randomUUID(), appointmentId: crypto.randomUUID(), clientId: crypto.randomUUID(), kind: "day_before" },
  });
  await setStatus(w.businessId, "paused");

  const inbound = await inboundJobsOf(w);
  assert.equal(inbound.length, 2);
  await drain(inbound.map((j) => j.id));

  // Los entrantes corrieron (no se postergan hasta la reactivación) sin responder.
  for (const job of inbound) assert.equal((await getJob(db, job.id)).status, "done");
  assert.equal(fake.agentCalls.length, 0);
  assert.equal(sentTo(from).length, 0, "nadie le responde a un negocio pausado");
  assert.equal(fake.uploads.length, 1, "la foto quedó en Storage para que el equipo la vea al reactivar");
  // El recordatorio (trabajo que no es guardar lo entrante) se posterga sin gastar el intento.
  const deferred = await getJob(db, reminder.id);
  assert.equal(deferred.status, "pending");
  assert.equal(deferred.attempts, 0);
  assert.ok(new Date(deferred.runAfter).getTime() > Date.now(), "postergado");

  // Lo que entra con el negocio ya pausado se guarda sin encolar respuesta.
  assert.deepEqual(await receive(w, from, { text: "¿hay alguien?" }), ["stored"]);
  assert.equal((await messagesOf(w)).length, 3);
  assert.equal((await inboundJobsOf(w)).length, 2);
  assert.equal(sentTo(from).length, 0);
});
