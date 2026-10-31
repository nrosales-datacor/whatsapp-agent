import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, test } from "node:test";
import { and, eq } from "drizzle-orm";

// ─────────────────────────────────────────────────────────────────────────────
// Pipeline de mensajes entrantes (job `whatsapp.inbound`) con la cola real sobre PGlite
// como el rol de la app. Graph, OpenAI, Storage y push son dobles (./helpers). Casos:
// respuesta del agente con aviso de bot la primera vez, ráfagas (los de
// legacy/test/reliability/rafagaAcciones), modo humano y su vencimiento, pedir una
// persona, handoff del agente (y el runner por defecto), una persona que toma la
// conversación mientras el LLM piensa, audio transcripto, foto a Storage, adjuntos que el
// bot no lee, BAJA, "Confirmo"/"Cancelar", topes mensuales, frenos por cliente y
// reintentos ante errores transitorios.
// ─────────────────────────────────────────────────────────────────────────────

process.env.TOKENS_ENCRYPTION_KEY = "d".repeat(64);

const { registerJobHandlers } = await import("../../src/jobs");
const { bookAppointment, getAppointment } = await import("../../src/modules/scheduling");
const { appointments } = await import("../../src/modules/scheduling/schema");
const { clients } = await import("../../src/modules/clients/schema");
const { conversations, messages } = await import("../../src/modules/whatsapp/schema");
const { WHATSAPP_INBOUND_JOB } = await import("../../src/modules/whatsapp/ingest");
const { processWebhookBody } = await import("../../src/modules/whatsapp/webhook");
const { handleInboundJob } = await import("../../src/modules/whatsapp/pipeline");
const { handoffAgentRunner } = await import("../../src/modules/whatsapp/deps");
const { GraphError, MediaTooLargeError } = await import("../../src/modules/whatsapp/graph");
const { reminderButtonIds } = await import("../../src/modules/whatsapp/payload");
const { getAiUsage, incrementAiUsage } = await import("../../src/modules/whatsapp/usage");
const { _resetChannelStateForTests } = await import("../../src/modules/whatsapp/channels");
const { _resetIngestBucketsForTests } = await import("../../src/modules/whatsapp/limits");
const { readDailyUsage } = await import("../../src/platform/observability/dailyUsage");
const { pushSubscriptions } = await import("../../src/platform/db/schema");
const { withSystem, withTenant } = await import("../../src/platform/db/scope");
const { hasNewerGroupJob, enqueue } = await import("../../src/platform/queue");
const { jobs } = await import("../../src/platform/queue/schema");
const { _resetShutdownForTests } = await import("../../src/platform/net/shutdown");
const { _resetJobHandlersForTests } = await import("../../src/platform/queue/handlers");
const { startQueueWorker } = await import("../../src/platform/queue/worker");
const { createEphemeralDb } = await import("../helpers/pgliteDb");
const { allJobs, silenceConsole, waitFor } = await import("../helpers/queue");
const { createTestMember } = await import("../helpers/identityFixtures");
const { createSchedulingWorld, crAt, crDay } = await import("../helpers/schedulingFixtures");
const { createChannel, fakeWhatsApp, inboundBody, oggOpusAudio, okResult } = await import("../helpers/whatsappFixtures");

type Fake = ReturnType<typeof fakeWhatsApp>;

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
  fake = fakeWhatsApp(db);
  registerJobHandlers({ whatsapp: fake.deps });
});
afterEach(() => {
  _resetShutdownForTests();
});

/** Negocio con agenda, un número conectado y un miembro suscrito a push. */
async function world() {
  const w = await createSchedulingWorld(db);
  const channel = await createChannel(db, w.businessId);
  const member = await createTestMember(db, { businessId: w.businessId, role: "owner" });
  await withTenant(db, w.businessId, (tx) =>
    tx.insert(pushSubscriptions).values({
      businessId: w.businessId,
      userId: member.userId,
      sessionEpoch: 0,
      endpoint: `https://fcm.googleapis.com/fcm/send/${w.businessId}`,
      p256dh: "B".repeat(87),
      auth: "A".repeat(22),
    }),
  );
  return { ...w, ...channel };
}
type World = Awaited<ReturnType<typeof world>>;

let phoneSeq = 0;
const newPhone = () => `5068${String(7000000 + ++phoneSeq).padStart(7, "0")}`;

/** Ingesta como el webhook (sin HTTP). */
async function receive(w: World, from: string, input: { text?: string; type?: string; message?: Record<string, unknown> } = {}) {
  const outcomes = await processWebhookBody(db, inboundBody({ phoneNumberId: w.phoneNumberId, from, ...input }));
  assert.deepEqual(outcomes, ["queued"]);
}

/** Corre la cola real hasta que no quede nada pendiente. */
async function drain(): Promise<void> {
  const worker = startQueueWorker({ db, concurrency: 1, pollMs: 10, retentionDays: 0 });
  try {
    await waitFor(async () => (await allJobs(db)).every((j) => j.status === "done" || j.status === "dead"), "cola vacía", 30_000);
  } finally {
    await worker.stop();
  }
  const dead = (await allJobs(db)).filter((j) => j.status === "dead");
  assert.equal(dead.length, 0, `jobs en dead: ${dead.map((d) => d.lastError).join(" | ")}`);
}

async function conversationOf(w: World, from: string) {
  const [client] = await withTenant(db, w.businessId, (tx) => tx.select().from(clients).where(and(eq(clients.businessId, w.businessId), eq(clients.phone, `+${from}`))));
  const [conv] = await withTenant(db, w.businessId, (tx) => tx.select().from(conversations).where(eq(conversations.clientId, client.id)));
  return { client, conv };
}

const sentTo = (to: string) => fake.sent.filter((s) => s.to === `+${to}`);
const pushesFor = (w: World) => fake.pushes.filter((p) => p.target.endpoint.endsWith(w.businessId));
const historyTexts = (i: number) => fake.agentCalls[i].history.map((h) => h.text);

// ── Turno normal ─────────────────────────────────────────────────────────────

test("texto → el agente responde; la primera respuesta lleva el aviso de bot y queda guardada", async () => {
  const w = await world();
  const from = newPhone();
  await receive(w, from, { text: "Hola, ¿qué servicios tienen?" });
  await drain();
  assert.equal(fake.agentCalls.length, 1);
  const input = fake.agentCalls[0];
  assert.equal(input.businessId, w.businessId);
  assert.equal(input.clientPhone, `+${from}`);
  assert.equal(input.locationId, null);
  assert.deepEqual(historyTexts(0), ["Hola, ¿qué servicios tienen?"]);
  const [first] = sentTo(from);
  assert.equal(first.kind, "text");
  assert.match(first.text!, /asistente automatizado de Estética Agenda[\s\S]*¡Hola! ¿En qué te ayudo\?$/);

  const { conv } = await conversationOf(w, from);
  assert.ok(conv.botNoticeSentAt);
  const rows = await withTenant(db, w.businessId, (tx) => tx.select().from(messages).where(eq(messages.conversationId, conv.id)));
  assert.equal(rows.filter((m) => m.role === "assistant").length, 1);

  await receive(w, from, { text: "¿Y el precio de la limpieza?" });
  await drain();
  assert.equal(sentTo(from)[1].text, "¡Hola! ¿En qué te ayudo?", "el aviso de bot sale una sola vez");
  assert.deepEqual(historyTexts(1).slice(-1), ["¿Y el precio de la limpieza?"]);
  assert.equal(historyTexts(1).length, 3, "el historial trae lo anterior y el mensaje nuevo");

  const usage = await getAiUsage(db, w.businessId);
  assert.equal(usage.inputTokens, 200);
  assert.equal(usage.costMicros, 100);
  assert.equal(usage.messagesOut, 2);
});

test("el agente puede responder con botones", async () => {
  const w = await world();
  const from = newPhone();
  fake.agentResult = { replies: [{ text: "¿Qué horario preferís?", buttons: [{ id: "slot|1", title: "10:00" }, { id: "slot|2", title: "11:00" }] }], actions: [], usage: { inputTokens: 1, outputTokens: 1, costMicros: 1 } };
  await receive(w, from, { text: "Quiero una cita" });
  await drain();
  const [msg] = sentTo(from);
  assert.equal(msg.kind, "buttons");
  assert.deepEqual(msg.buttons?.map((b) => b.id), ["slot|1", "slot|2"]);
});

// ── Ráfagas ──────────────────────────────────────────────────────────────────

test("ráfaga: dos textos comunes se agrupan en un solo turno que lee los dos", async () => {
  const w = await world();
  const from = newPhone();
  await receive(w, from, { text: "Hola" });
  await receive(w, from, { text: "¿Tienen cita mañana?" });
  await drain();
  assert.equal(fake.agentCalls.length, 1);
  assert.deepEqual(historyTexts(0), ["Hola", "¿Tienen cita mañana?"]);
  assert.equal(sentTo(from).length, 1);
});

test("ráfaga: texto seguido de foto → el texto cede (la foto es un turno que lo lee)", async () => {
  const w = await world();
  const from = newPhone();
  await receive(w, from, { text: "Mirá cómo tengo las uñas" });
  await receive(w, from, { type: "image", message: { image: { id: "IMG1", mime_type: "image/jpeg" } } });
  await drain();
  assert.equal(fake.agentCalls.length, 1);
  assert.deepEqual(historyTexts(0), ["Mirá cómo tengo las uñas", "[foto]"]);
  assert.equal(fake.uploads.length, 1, "la foto queda en Storage");
  assert.match(fake.uploads[0].path, new RegExp(`^${w.businessId}/whatsapp/`));
});

test("ráfaga: foto seguida de texto → la foto se procesa igual (no la absorbe el texto)", async () => {
  const w = await world();
  const from = newPhone();
  await receive(w, from, { type: "image", message: { image: { id: "IMG2", caption: "así", mime_type: "image/jpeg" } } });
  await receive(w, from, { text: "¿Cuánto sale?" });
  await drain();
  assert.equal(fake.agentCalls.length, 2);
  assert.deepEqual(historyTexts(0), ["[foto] así"]);
  assert.deepEqual(historyTexts(1).slice(-2), ["[foto] así", "¿Cuánto sale?"]);
});

test("ráfaga: BAJA seguida de otro texto → la baja se procesa igual", async () => {
  const w = await world();
  const from = newPhone();
  await receive(w, from, { text: "BAJA" });
  await receive(w, from, { text: "Igual quiero una cita" });
  await drain();
  const { client } = await conversationOf(w, from);
  assert.ok(client.marketingOptOutAt, "quedó la baja de promociones");
  assert.match(sentTo(from)[0].text!, /no vas a recibir más promociones/);
  assert.equal(fake.agentCalls.length, 1, "el texto igual va al agente");
});

test("ráfaga: texto seguido de BAJA → el texto no cede ante una acción directa", async () => {
  const w = await world();
  const from = newPhone();
  await receive(w, from, { text: "Una consulta" });
  await receive(w, from, { text: "baja" });
  await drain();
  assert.equal(fake.agentCalls.length, 1);
  assert.deepEqual(historyTexts(0), ["Una consulta"]);
  assert.ok((await conversationOf(w, from)).client.marketingOptOutAt);
});

test("ráfaga: «Confirmo» del recordatorio seguido de un texto → la confirmación se procesa igual", async () => {
  const w = await world();
  const appt = await bookAppointment(db, w.businessId, {
    locationId: w.escazu,
    clientId: w.maria,
    serviceIds: [w.limpieza],
    staffId: w.ana,
    startsAt: crAt(crDay(2), "10:00"),
    channel: "panel",
  });
  await withTenant(db, w.businessId, (tx) => tx.update(appointments).set({ status: "pending" }).where(eq(appointments.id, appt.id)));
  const ids = reminderButtonIds(appt.id);
  await receive(w, "50688880001", { type: "interactive", message: { interactive: { type: "button_reply", button_reply: { id: ids.confirm, title: "Confirmo ✅" } } } });
  await receive(w, "50688880001", { text: "¡Gracias!" });
  await drain();
  assert.equal((await getAppointment(db, w.businessId, appt.id))?.status, "confirmed");
  assert.ok(sentTo("50688880001").some((s) => /Gracias por confirmar tu cita/.test(s.text ?? "")));
  assert.equal(fake.agentCalls.length, 1);
});

test("«Cancelar» del recordatorio cancela la cita del cliente; una cita ajena no se toca", async () => {
  const w = await world();
  const book = (clientId: string, hm: string) =>
    bookAppointment(db, w.businessId, { locationId: w.escazu, clientId, serviceIds: [w.limpieza], staffId: w.ana, startsAt: crAt(crDay(3), hm), channel: "panel" });
  const mine = await book(w.maria, "09:00");
  const other = await book(w.sofia, "14:00");
  await receive(w, "50688880001", { type: "button", message: { button: { payload: reminderButtonIds(other.id).cancel, text: "Cancelar" } } });
  await drain();
  assert.equal((await getAppointment(db, w.businessId, other.id))?.status, other.status, "la cita de otro cliente sigue igual");
  assert.match(sentTo("50688880001")[0].text!, /ya no está activa/);
  await receive(w, "50688880001", { type: "button", message: { button: { payload: reminderButtonIds(mine.id).cancel, text: "Cancelar" } } });
  await drain();
  const cancelled = await getAppointment(db, w.businessId, mine.id);
  assert.equal(cancelled?.status, "cancelled");
  assert.match(String(cancelled?.cancellationReason), /WhatsApp/);
  assert.equal(fake.agentCalls.length, 0);
});

test("regla de ráfagas en la cola: un job que vuelve de un fallo cede ante uno más nuevo ya respondido", async () => {
  const w = await world();
  const group = "grupo-de-prueba";
  const mk = (flag: boolean) =>
    enqueue(db, { type: WHATSAPP_INBOUND_JOB, businessId: w.businessId, groupKey: group, payload: { rereadsHistory: flag } });
  const old = await mk(false);
  const newer = await mk(true);
  await withSystem(db, (tx) => tx.update(jobs).set({ status: "done" }).where(eq(jobs.id, newer.id)));
  assert.equal(await hasNewerGroupJob(db, { jobId: old.id, businessId: w.businessId, payloadFlag: "rereadsHistory" }), false, "primer intento: no");
  assert.equal(await hasNewerGroupJob(db, { jobId: old.id, businessId: w.businessId, payloadFlag: "rereadsHistory", includeDone: true }), true, "reintento: sí");
  await withSystem(db, (tx) => tx.update(jobs).set({ status: "done" }).where(eq(jobs.id, old.id)));
});

// ── Modo humano ──────────────────────────────────────────────────────────────

test("modo humano: el bot no responde y se avisa al equipo por push", async () => {
  const w = await world();
  const from = newPhone();
  await receive(w, from, { text: "hola" });
  await drain();
  const { conv } = await conversationOf(w, from);
  await withTenant(db, w.businessId, (tx) => tx.update(conversations).set({ mode: "human", humanSince: new Date() }).where(eq(conversations.id, conv.id)));
  const sentBefore = sentTo(from).length;
  await receive(w, from, { text: "¿Me atienden?" });
  await drain();
  assert.equal(fake.agentCalls.length, 1, "el agente solo corrió para el primer mensaje");
  assert.equal(sentTo(from).length, sentBefore);
  const push = pushesFor(w).at(-1);
  assert.ok(push);
  assert.equal(push.payload.body, "¿Me atienden?");
  assert.equal(push.payload.url, `/panel/whatsapp/conversations/${conv.id}`);
});

test("modo humano vencido (nadie del equipo actuó en 12 h): vuelve al bot", async () => {
  const w = await world();
  const from = newPhone();
  await receive(w, from, { text: "hola" });
  await drain();
  const { conv } = await conversationOf(w, from);
  await withTenant(db, w.businessId, (tx) =>
    tx.update(conversations).set({ mode: "human", humanSince: new Date(Date.now() - 13 * 3_600_000) }).where(eq(conversations.id, conv.id)),
  );
  await receive(w, from, { text: "¿Hay alguien?" });
  await drain();
  assert.equal(fake.agentCalls.length, 2);
  assert.equal((await conversationOf(w, from)).conv.mode, "bot");
});

test("pedir una persona: modo humano, aviso al cliente y al equipo, cuenta como traspaso", async () => {
  const w = await world();
  const from = newPhone();
  await receive(w, from, { text: "quiero hablar con una persona" });
  await drain();
  assert.equal(fake.agentCalls.length, 0);
  assert.equal((await conversationOf(w, from)).conv.mode, "human");
  assert.match(sentTo(from)[0].text!, /Te paso con una persona del equipo/);
  assert.match(pushesFor(w).at(-1)!.payload.body, /Pidió hablar con una persona/);
  const today = new Date().toISOString().slice(0, 10);
  const handoffs = await readDailyUsage(db, w.businessId, { metric: "whatsapp_handoffs", from: "2000-01-01", to: "2100-01-01" });
  assert.equal(handoffs.reduce((n, r) => n + r.value, 0), 1, today);
});

test("handoff del agente: modo humano, su texto al cliente y push con el motivo", async () => {
  const w = await world();
  const from = newPhone();
  fake.agentResult = { replies: [{ text: "Lo consulto con el equipo." }], actions: [{ type: "handoff", reason: "pide un descuento" }], usage: { inputTokens: 1, outputTokens: 1, costMicros: 1 } };
  await receive(w, from, { text: "¿Me hacen descuento?" });
  await drain();
  assert.equal((await conversationOf(w, from)).conv.mode, "human");
  assert.match(sentTo(from)[0].text!, /Lo consulto con el equipo\.$/);
  assert.match(pushesFor(w).at(-1)!.payload.body, /El bot pasó este caso: pide un descuento/);
});

test("sin agente compuesto (runner por defecto): pasa a una persona con el texto de traspaso", async () => {
  _resetJobHandlersForTests();
  fake = fakeWhatsApp(db, { agent: handoffAgentRunner });
  registerJobHandlers({ whatsapp: fake.deps });
  const w = await world();
  const from = newPhone();
  await receive(w, from, { text: "hola" });
  await drain();
  assert.equal((await conversationOf(w, from)).conv.mode, "human");
  assert.match(sentTo(from)[0].text!, /Dejame consultarlo con una persona del equipo/);
});

test("si una persona toma la conversación mientras el LLM piensa, la respuesta se descarta", async () => {
  const w = await world();
  const from = newPhone();
  fake.agentResult = async (input) => {
    await withTenant(db, w.businessId, (tx) => tx.update(conversations).set({ mode: "human", humanSince: new Date() }).where(eq(conversations.id, input.conversationId)));
    return okResult("respuesta tardía");
  };
  await receive(w, from, { text: "hola" });
  await drain();
  assert.equal(fake.agentCalls.length, 1);
  assert.equal(sentTo(from).length, 0);
  assert.equal((await getAiUsage(db, w.businessId)).costMicros, 50, "lo gastado se cuenta igual");
});

// ── Adjuntos ─────────────────────────────────────────────────────────────────

test("audio: se guarda, se transcribe y el agente recibe el texto", async () => {
  const w = await world();
  const from = newPhone();
  await receive(w, from, { type: "audio", message: { audio: { id: "AUD1", mime_type: "audio/ogg" } } });
  await drain();
  assert.equal(fake.agentCalls.length, 1);
  assert.deepEqual(historyTexts(0), ["[audio] Quiero una cita para mañana"]);
  const { conv } = await conversationOf(w, from);
  const [msg] = await withTenant(db, w.businessId, (tx) => tx.select().from(messages).where(and(eq(messages.conversationId, conv.id), eq(messages.role, "user"))));
  assert.equal(msg.content, "[audio] Quiero una cita para mañana");
  assert.equal(msg.mediaType, "audio");
  assert.ok(msg.mediaPath);
  assert.ok((await getAiUsage(db, w.businessId)).costMicros >= 3000, "el costo de Whisper se suma al del agente");
});

test("audio que pide una persona → traspaso sin pasar por el agente", async () => {
  const w = await world();
  const from = newPhone();
  fake.transcript = "quiero hablar con una persona por favor";
  await receive(w, from, { type: "audio", message: { audio: { id: "AUD2", mime_type: "audio/ogg" } } });
  await drain();
  assert.equal(fake.agentCalls.length, 0);
  assert.equal((await conversationOf(w, from)).conv.mode, "human");
});

/** Rearma el doble con una descarga y una transcripción propias; cuenta las transcripciones. */
function audioFake(media: () => Promise<{ buffer: Buffer; mimeType: string }>, transcription: { text: string; durationSec: number }) {
  _resetJobHandlersForTests();
  const calls = { transcribe: 0 };
  fake = fakeWhatsApp(db, {
    transcribe: async () => {
      calls.transcribe++;
      return transcription;
    },
  });
  fake.deps.api.downloadMedia = media;
  registerJobHandlers({ whatsapp: fake.deps });
  return calls;
}

test("audio de más de 2 min (duración del ogg): ni se transcribe ni va al agente; aviso al cliente y al equipo", async () => {
  const calls = audioFake(async () => ({ buffer: oggOpusAudio(150), mimeType: "audio/ogg; codecs=opus" }), { text: "no debería", durationSec: 150 });
  const w = await world();
  const from = newPhone();
  await receive(w, from, { type: "audio", message: { audio: { id: "AUDL1", mime_type: "audio/ogg; codecs=opus", voice: true } } });
  await drain();
  assert.equal(calls.transcribe, 0, "Whisper no se paga");
  assert.equal(fake.agentCalls.length, 0);
  assert.match(sentTo(from).at(-1)!.text!, /Tu audio es muy largo\. ¿Me lo resumís en uno más corto \(de hasta 2 min\) o por escrito\?/);
  assert.match(pushesFor(w).at(-1)!.payload.body, /nota de voz de más de 2 min: no se transcribió \(escuchala en la bandeja\)/);
  assert.equal((await getAiUsage(db, w.businessId)).costMicros, 0);
  assert.equal(fake.uploads.length, 1, "el audio igual queda guardado para el equipo");
});

test("audio dentro del tope (ogg de 90 s): se transcribe como siempre", async () => {
  const calls = audioFake(async () => ({ buffer: oggOpusAudio(90), mimeType: "audio/ogg" }), { text: "Quiero una cita", durationSec: 90 });
  const w = await world();
  const from = newPhone();
  await receive(w, from, { type: "audio", message: { audio: { id: "AUDL2", mime_type: "audio/ogg" } } });
  await drain();
  assert.equal(calls.transcribe, 1);
  assert.equal(fake.agentCalls.length, 1);
});

test("audio por encima del tope de bytes (no se bajó): mismo aviso, sin transcribir", async () => {
  const calls = audioFake(
    async () => {
      throw new MediaTooLargeError("audio/mpeg", 9_000_000, 3 * 1024 * 1024);
    },
    { text: "no debería", durationSec: 0 },
  );
  const w = await world();
  const from = newPhone();
  await receive(w, from, { type: "audio", message: { audio: { id: "AUDL3", mime_type: "audio/mpeg" } } });
  await drain();
  assert.equal(calls.transcribe, 0);
  assert.equal(fake.agentCalls.length, 0);
  assert.match(sentTo(from).at(-1)!.text!, /Tu audio es muy largo/);
  assert.match(pushesFor(w).at(-1)!.payload.body, /no se transcribió\.$/, "sin adjunto guardado no se invita a escucharlo");
});

test("audio sin duración legible (mp3) que Whisper mide en más de 2 min: se cobra pero no va al agente", async () => {
  const calls = audioFake(async () => ({ buffer: Buffer.from("ID3 mp3 de mentira"), mimeType: "audio/mpeg" }), { text: "un monólogo larguísimo", durationSec: 400 });
  const w = await world();
  const from = newPhone();
  await receive(w, from, { type: "audio", message: { audio: { id: "AUDL4", mime_type: "audio/mpeg" } } });
  await drain();
  assert.equal(calls.transcribe, 1);
  assert.equal(fake.agentCalls.length, 0);
  assert.match(sentTo(from).at(-1)!.text!, /Tu audio es muy largo/);
  assert.ok((await getAiUsage(db, w.businessId)).costMicros > 0, "lo que cobró Whisper se cuenta");
});

test("audio: la transcripción guardada (y la que lee el agente) se corta a 4096 caracteres", async () => {
  audioFake(async () => ({ buffer: oggOpusAudio(100), mimeType: "audio/ogg" }), { text: "palabra ".repeat(1000), durationSec: 100 });
  const w = await world();
  const from = newPhone();
  await receive(w, from, { type: "audio", message: { audio: { id: "AUDL5", mime_type: "audio/ogg" } } });
  await drain();
  assert.equal(fake.agentCalls.length, 1);
  const { conv } = await conversationOf(w, from);
  const [msg] = await withTenant(db, w.businessId, (tx) => tx.select().from(messages).where(and(eq(messages.conversationId, conv.id), eq(messages.role, "user"))));
  assert.ok(msg.content.startsWith("[audio] palabra"));
  assert.equal(Array.from(msg.content).length, "[audio] ".length + 4096);
  assert.ok(msg.content.endsWith("…"));
});

test("documento o sticker: texto fijo al cliente y aviso al equipo, sin agente", async () => {
  const w = await world();
  const from = newPhone();
  await receive(w, from, { type: "document", message: { document: { id: "DOC1", filename: "receta.pdf" } } });
  await drain();
  assert.equal(fake.agentCalls.length, 0);
  assert.match(sentTo(from)[0].text!, /Recibí tu documento/);
  assert.match(pushesFor(w).at(-1)!.payload.body, /documento/);
});

test("foto que no se puede descargar: se le avisa al cliente, sin agente", async () => {
  _resetJobHandlersForTests();
  fake = fakeWhatsApp(db);
  fake.deps.api.downloadMedia = async () => {
    throw new GraphError("media vencida", { status: 404, transient: false });
  };
  registerJobHandlers({ whatsapp: fake.deps });
  const w = await world();
  const from = newPhone();
  await receive(w, from, { type: "image", message: { image: { id: "IMG3", mime_type: "image/jpeg" } } });
  await drain();
  assert.equal(fake.agentCalls.length, 0);
  assert.match(sentTo(from)[0].text!, /tuve un problema para verla/);
});

// ── Topes y frenos ───────────────────────────────────────────────────────────

test("tope mensual de conversaciones: sin LLM, aviso al cliente y pasa a una persona", async () => {
  _resetJobHandlersForTests();
  fake = fakeWhatsApp(db, { getAiLimits: () => ({ monthlyConversations: 0, monthlySpendMicros: null }) });
  registerJobHandlers({ whatsapp: fake.deps });
  const w = await world();
  const from = newPhone();
  await receive(w, from, { text: "hola" });
  await drain();
  assert.equal(fake.agentCalls.length, 0);
  assert.match(sentTo(from)[0].text!, /En un momento te atiende alguien del equipo/);
  assert.equal((await conversationOf(w, from)).conv.mode, "human");
});

test("tope mensual de gasto de IA: mismo tratamiento con texto neutro", async () => {
  _resetJobHandlersForTests();
  fake = fakeWhatsApp(db, { getAiLimits: () => ({ monthlyConversations: null, monthlySpendMicros: 1_000_000 }) });
  registerJobHandlers({ whatsapp: fake.deps });
  const w = await world();
  await incrementAiUsage(db, w.businessId, { costMicros: 1_000_000 });
  const from = newPhone();
  await receive(w, from, { text: "hola" });
  await drain();
  assert.equal(fake.agentCalls.length, 0);
  assert.match(sentTo(from)[0].text!, /te atiende una persona del equipo/);
});

test("freno por cliente: pasado el límite de turnos por hora, un aviso y después silencio", async () => {
  process.env.WHATSAPP_CLIENT_TURNS_PER_HOUR = "2";
  try {
    const w = await world();
    const from = newPhone();
    for (const text of ["uno", "dos", "tres", "cuatro"]) {
      await receive(w, from, { text });
      await drain();
    }
    assert.equal(fake.agentCalls.length, 2);
    const sent = sentTo(from).map((s) => s.text ?? "");
    assert.equal(sent.length, 3, "dos respuestas y un solo aviso");
    assert.match(sent[2], /Recibimos varios mensajes tuyos seguidos/);
  } finally {
    delete process.env.WHATSAPP_CLIENT_TURNS_PER_HOUR;
  }
});

test("bucle con otro bot: el mismo texto muchas veces pausa el bot sin escribirle", async () => {
  const w = await world();
  const from = newPhone();
  for (let i = 1; i <= 5; i++) {
    await receive(w, from, { text: `Ticket #${i} recibido, gracias por escribir` });
    await drain();
  }
  assert.equal(fake.agentCalls.length, 4);
  assert.equal(sentTo(from).length, 4, "al detectar el bucle no se le manda nada");
  assert.equal((await conversationOf(w, from)).conv.mode, "human");
  assert.match(pushesFor(w).at(-1)!.payload.body, /Posible bucle/);
});

// ── Reintentos ───────────────────────────────────────────────────────────────

test("error transitorio del agente: relanza para que la cola reintente; en el último intento, disculpa", async () => {
  const w = await world();
  const from = newPhone();
  await receive(w, from, { text: "hola" });
  const [job] = (await allJobs(db)).filter((j) => j.businessId === w.businessId && j.status === "pending");
  const ctx = (attempt: number, isLastAttempt: boolean) => ({
    jobId: job.id,
    type: WHATSAPP_INBOUND_JOB,
    businessId: w.businessId,
    attempt,
    maxAttempts: 2,
    isLastAttempt,
    signal: new AbortController().signal,
    db,
  });
  fake.agentResult = () => {
    throw Object.assign(new Error("OpenAI 503"), { transient: true });
  };
  await assert.rejects(handleInboundJob(job.payload, ctx(1, false), fake.deps), /OpenAI 503/);
  assert.equal(sentTo(from).length, 0);
  await handleInboundJob(job.payload, ctx(2, true), fake.deps);
  assert.match(sentTo(from)[0].text!, /tuvimos un problemita/);
  assert.match(pushesFor(w).at(-1)!.payload.body, /El bot no pudo responder/);
  await withSystem(db, (tx) => tx.update(jobs).set({ status: "done" }).where(eq(jobs.id, job.id)));
});

test("envío caído un rato: la cola reintenta el turno y el cliente recibe UNA respuesta", async () => {
  const w = await world();
  const from = newPhone();
  fake.failNextSend = new GraphError("Graph 503", { status: 503, transient: true });
  await receive(w, from, { text: "hola" });
  const worker = startQueueWorker({ db, concurrency: 1, pollMs: 10, retentionDays: 0 });
  try {
    await waitFor(() => sentTo(from).length === 1, "respuesta tras el reintento", 30_000);
  } finally {
    await worker.stop();
  }
  assert.equal(fake.agentCalls.length, 2, "el turno se corrió de nuevo");
  assert.equal(sentTo(from).length, 1);
});
