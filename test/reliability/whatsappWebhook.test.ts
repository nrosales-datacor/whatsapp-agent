import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { and, eq } from "drizzle-orm";

// ─────────────────────────────────────────────────────────────────────────────
// Webhook de WhatsApp por HTTP con la app real sobre PGlite como el rol de la app (RLS):
// verificación de Meta, firma, tope del cuerpo, ruteo por phone_number_id → canal →
// negocio, idempotencia por wamid (mensaje y job), estados ignorados, red de seguridad
// raw_webhooks (número desconocido y payload ilegible) con su reproceso, negocio pausado
// y la conversación que vuelve a "abierta" cuando el cliente escribe.
// ─────────────────────────────────────────────────────────────────────────────

process.env.TRUST_PROXY = "loopback";
process.env.PANEL_SESSION_SECRET = "test-whatsapp-webhook-secret-0123456789";
process.env.TOKENS_ENCRYPTION_KEY = "d".repeat(64);
process.env.WHATSAPP_APP_SECRET = "test-app-secret";
process.env.WHATSAPP_VERIFY_TOKEN = "test-verify-token";

const { createAppHandler } = await import("../../src/app");
const { clients } = await import("../../src/modules/clients/schema");
const { conversations, messages, rawWebhooks } = await import("../../src/modules/whatsapp/schema");
const { WHATSAPP_INBOUND_JOB } = await import("../../src/modules/whatsapp/ingest");
const { reprocessForPhoneNumber, reingestRawPayload } = await import("../../src/modules/whatsapp/webhook");
const { reprocessRawWebhooks, purgeRawWebhooks } = await import("../../src/modules/whatsapp/rawWebhooks");
const { getAiUsage } = await import("../../src/modules/whatsapp/usage");
const { _resetChannelStateForTests } = await import("../../src/modules/whatsapp/channels");
const { _resetIngestBucketsForTests } = await import("../../src/modules/whatsapp/limits");
const { withSystem, withTenant } = await import("../../src/platform/db/scope");
const { createEphemeralDb } = await import("../helpers/pgliteDb");
const { startTestServer } = await import("../helpers/panelClient");
const { allJobs, silenceConsole } = await import("../helpers/queue");
const { createTestBusiness } = await import("../helpers/identityFixtures");
const { createChannel, fakeWhatsApp, inboundBody, sign, statusBody } = await import("../helpers/whatsappFixtures");

const base = await createEphemeralDb();
const { db } = base;
let app: Awaited<ReturnType<typeof startTestServer>>;
let restoreConsole: () => void;

before(async () => {
  restoreConsole = silenceConsole();
  await base.client.exec("SET ROLE app_runtime");
  app = await startTestServer(createAppHandler({ db, role: "all", whatsapp: fakeWhatsApp(db).deps }));
});
after(async () => {
  await app?.close();
  await base.close();
  restoreConsole();
});
beforeEach(() => {
  _resetChannelStateForTests();
  _resetIngestBucketsForTests();
});

async function post(body: unknown, options: { signature?: string | null; raw?: string } = {}) {
  const raw = options.raw ?? JSON.stringify(body);
  const headers: Record<string, string> = { "content-type": "application/json" };
  const signature = options.signature === undefined ? sign(raw) : options.signature;
  if (signature) headers["x-hub-signature-256"] = signature;
  return fetch(`${app.baseUrl}/webhook/whatsapp`, { method: "POST", headers, body: raw });
}

async function world(options: { status?: "active" | "paused" } = {}) {
  const business = await createTestBusiness(db, { status: options.status });
  const channel = await createChannel(db, business.businessId);
  return { ...business, ...channel };
}

const messagesOf = (businessId: string) => withTenant(db, businessId, (tx) => tx.select().from(messages).where(eq(messages.businessId, businessId)));
const jobsOf = async (businessId: string) => (await allJobs(db)).filter((j) => j.businessId === businessId && j.type === WHATSAPP_INBOUND_JOB);
const rawRows = () => withSystem(db, (tx) => tx.select().from(rawWebhooks));

test("GET: verificación de la suscripción de Meta", async () => {
  const ok = await fetch(`${app.baseUrl}/webhook/whatsapp?hub.mode=subscribe&hub.verify_token=test-verify-token&hub.challenge=987`);
  assert.equal(ok.status, 200);
  assert.equal(await ok.text(), "987");
  const bad = await fetch(`${app.baseUrl}/webhook/whatsapp?hub.mode=subscribe&hub.verify_token=otro&hub.challenge=987`);
  assert.equal(bad.status, 403);
  const put = await fetch(`${app.baseUrl}/webhook/whatsapp`, { method: "PUT" });
  assert.equal(put.status, 405);
});

test("POST: sin firma o con firma ajena → 401 y no se guarda nada; cuerpo enorme → 413", async () => {
  const w = await world();
  const body = inboundBody({ phoneNumberId: w.phoneNumberId, from: "50688881111" });
  assert.equal((await post(body, { signature: null })).status, 401);
  assert.equal((await post(body, { signature: sign(JSON.stringify(body), "otro-secreto") })).status, 401);
  assert.equal((await messagesOf(w.businessId)).length, 0);
  const huge = "x".repeat(1024 * 1024 + 10);
  assert.equal((await post(null, { raw: huge })).status, 413);
});

test("ruteo e idempotencia: un mensaje (y su reintento) → cliente, conversación, mensaje y UN job agrupado", async () => {
  const w = await world();
  const other = await world();
  const body = inboundBody({ phoneNumberId: w.phoneNumberId, from: "50688882222", name: "Laura Mora", text: "Hola, ¿tienen cita mañana?" });
  assert.equal((await post(body)).status, 200);
  assert.equal((await post(body)).status, 200, "el reintento de Meta también recibe 200");

  const rows = await messagesOf(w.businessId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].role, "user");
  assert.equal(rows[0].content, "Hola, ¿tienen cita mañana?");
  assert.equal((await messagesOf(other.businessId)).length, 0, "el otro negocio no recibe nada");

  const [conv] = await withTenant(db, w.businessId, (tx) => tx.select().from(conversations).where(eq(conversations.businessId, w.businessId)));
  assert.equal(conv.channelId, w.channelId);
  assert.equal(conv.status, "open");
  assert.equal(conv.mode, "bot");
  const [client] = await withTenant(db, w.businessId, (tx) => tx.select().from(clients).where(eq(clients.id, conv.clientId)));
  assert.equal(client.phone, "+50688882222");
  assert.equal(client.name, "Laura Mora");
  assert.equal(client.source, "WhatsApp");

  const jobs = await jobsOf(w.businessId);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].groupKey, conv.id);
  assert.match(String(jobs[0].dedupeKey), /^wa-in:wamid\./);
  const payload = jobs[0].payload as Record<string, unknown>;
  assert.equal(payload.messageId, rows[0].id);
  assert.equal(payload.groupable, true);
  assert.equal(payload.rereadsHistory, true);
  assert.equal(JSON.stringify(payload).includes("tienen cita"), false, "el job lleva ids, no el contenido");

  const usage = await getAiUsage(db, w.businessId);
  assert.equal(usage.messagesIn, 1);
  assert.equal(usage.conversationsStarted, 1);
});

test("acciones directas y adjuntos salen marcados para no ceder en una ráfaga", async () => {
  const w = await world();
  await post(inboundBody({ phoneNumberId: w.phoneNumberId, from: "50688883333", text: "BAJA" }));
  await post(inboundBody({ phoneNumberId: w.phoneNumberId, from: "50688883333", type: "image", message: { image: { id: "M1", mime_type: "image/jpeg" } } }));
  const payloads = (await jobsOf(w.businessId)).map((j) => j.payload as Record<string, unknown>);
  const optOut = payloads.find((p) => p.action === "opt_out");
  const photo = payloads.find((p) => p.kind === "image");
  assert.deepEqual([optOut?.groupable, optOut?.rereadsHistory], [false, false]);
  assert.deepEqual([photo?.groupable, photo?.rereadsHistory, photo?.mediaId], [false, true, "M1"]);
  const stored = (await messagesOf(w.businessId)).map((m) => [m.content, m.mediaType]);
  assert.ok(stored.some(([c, t]) => c === "[foto]" && t === "image"));
});

test("estados (entregado/leído) se ignoran: ni mensaje ni raw_webhooks", async () => {
  const w = await world();
  const before = (await rawRows()).length;
  assert.equal((await post(statusBody(w.phoneNumberId))).status, 200);
  assert.equal((await messagesOf(w.businessId)).length, 0);
  assert.equal((await rawRows()).length, before);
});

test("número sin canal → raw_webhooks; al conectarlo, el reproceso lo ingesta", async () => {
  const business = await createTestBusiness(db);
  const pnid = "998877665544";
  const body = inboundBody({ phoneNumberId: pnid, from: "50688884444", text: "¿Hay alguien?" });
  assert.equal((await post(body)).status, 200);
  assert.equal((await post(body)).status, 200);
  const pending = (await rawRows()).filter((r) => r.phoneNumberId === pnid);
  assert.equal(pending.length, 1, "un mismo wamid no se guarda dos veces");
  assert.equal(pending[0].reason, "unknown_channel");
  assert.equal(pending[0].status, "pending");

  // Sigue sin canal: suma un intento.
  await reprocessForPhoneNumber(db, pnid);
  assert.equal((await rawRows()).find((r) => r.phoneNumberId === pnid)?.attempts, 1);

  await createChannel(db, business.businessId, { phoneNumberId: pnid });
  const result = await reprocessForPhoneNumber(db, pnid);
  assert.equal(result.processed, 1);
  assert.equal((await rawRows()).find((r) => r.phoneNumberId === pnid)?.status, "processed");
  const rows = await messagesOf(business.businessId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].content, "¿Hay alguien?");
  assert.equal((await jobsOf(business.businessId)).length, 1);
});

test("payload ilegible (firmado) → raw_webhooks; no se reinyecta y se descarta al tope; la purga borra lo viejo", async () => {
  process.env.WHATSAPP_RAW_WEBHOOK_MAX_ATTEMPTS = "2";
  try {
    assert.equal((await post(null, { raw: "esto no es json" })).status, 200);
    assert.equal((await post({ object: "otra_cosa" })).status, 200);
    const unparseable = (await rawRows()).filter((r) => r.reason === "unparseable" && r.status === "pending");
    assert.ok(unparseable.length >= 2);
    await reprocessRawWebhooks(db, reingestRawPayload(db));
    const second = await reprocessRawWebhooks(db, reingestRawPayload(db));
    assert.ok(second.discarded >= 2);
    const rows = await rawRows();
    assert.ok(rows.filter((r) => r.reason === "unparseable").every((r) => r.status === "discarded"));
    const purged = await purgeRawWebhooks(db, 1, new Date(Date.now() + 2 * 86_400_000));
    assert.ok(purged >= 2);
  } finally {
    delete process.env.WHATSAPP_RAW_WEBHOOK_MAX_ATTEMPTS;
  }
});

test("negocio pausado: el mensaje se guarda para el equipo, pero no se encola respuesta", async () => {
  const w = await world({ status: "paused" });
  assert.equal((await post(inboundBody({ phoneNumberId: w.phoneNumberId, from: "50688885555", text: "hola" }))).status, 200);
  assert.equal((await messagesOf(w.businessId)).length, 1);
  assert.equal((await jobsOf(w.businessId)).length, 0);
});

test("una conversación atendida vuelve a abierta cuando el cliente escribe", async () => {
  const w = await world();
  await post(inboundBody({ phoneNumberId: w.phoneNumberId, from: "50688886666", text: "uno" }));
  await withTenant(db, w.businessId, (tx) => tx.update(conversations).set({ status: "resolved" }).where(eq(conversations.businessId, w.businessId)));
  await post(inboundBody({ phoneNumberId: w.phoneNumberId, from: "50688886666", text: "dos" }));
  const [conv] = await withTenant(db, w.businessId, (tx) => tx.select().from(conversations).where(and(eq(conversations.businessId, w.businessId))));
  assert.equal(conv.status, "open");
  const usage = await getAiUsage(db, w.businessId);
  assert.equal(usage.conversationsStarted, 1, "el segundo mensaje dentro de 24 h no inicia otra conversación");
  assert.equal(usage.messagesIn, 2);
});
