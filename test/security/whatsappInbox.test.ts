import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { and, eq } from "drizzle-orm";

// ─────────────────────────────────────────────────────────────────────────────
// API del módulo WhatsApp por HTTP con la app real sobre PGlite como el rol de la app
// (RLS): contrato de la bandeja (lista, detalle, paginación, búsqueda, filtros), respuesta
// humana y ventana de 24 h, modo/estado/leído, reapertura con plantilla, resumen y
// métricas, canales (lista sin token, configuración, prueba, Embedded Signup, alta del
// superadmin), push por usuario, permisos por rol y por sucursal, aislamiento entre
// negocios, el borrador de datos en la anonimización del cliente y el Inicio.
// ─────────────────────────────────────────────────────────────────────────────

process.env.TRUST_PROXY = "loopback";
process.env.PANEL_SESSION_SECRET = "test-whatsapp-inbox-session-secret-01234";
process.env.TOKENS_ENCRYPTION_KEY = "d".repeat(64);
process.env.PANEL_LOGIN_RATE_LIMIT_MAX_IP = "500";
process.env.PANEL_SUPERADMIN_USERNAME = "root";
process.env.META_APP_ID = "123456";
process.env.META_ES_CONFIG_ID = "654321";
process.env.WHATSAPP_APP_SECRET = "test-app-secret";
process.env.VAPID_PUBLIC_KEY = "BPublicKeyDePrueba";
process.env.VAPID_PRIVATE_KEY = "privada-de-prueba";
delete process.env.PANEL_SUPERADMIN_TOTP_SECRET;
const ADMIN_PASSWORD = "clave-del-superadmin-1";
const { hashPassword } = await import("../../src/platform/auth/password");
process.env.PANEL_SUPERADMIN_HASH = await hashPassword(ADMIN_PASSWORD);

const { createAppHandler } = await import("../../src/app");
const { bookAppointment } = await import("../../src/modules/scheduling");
const { clients } = await import("../../src/modules/clients/schema");
const { conversations, messages, whatsappChannels } = await import("../../src/modules/whatsapp/schema");
const { processWebhookBody } = await import("../../src/modules/whatsapp/webhook");
const { WHATSAPP_MEDIA_ERASE_JOB } = await import("../../src/modules/whatsapp/eraser");
const { _resetChannelStateForTests } = await import("../../src/modules/whatsapp/channels");
const { pushSubscriptions } = await import("../../src/platform/db/schema");
const { withSystem, withTenant } = await import("../../src/platform/db/scope");
const { auditLog } = await import("../../src/platform/db/schema");
const { createEphemeralDb } = await import("../helpers/pgliteDb");
const { Browser, startTestServer } = await import("../helpers/panelClient");
const { allJobs, silenceConsole } = await import("../helpers/queue");
const { createTestMember } = await import("../helpers/identityFixtures");
const { createSchedulingWorld, crAt, crDay } = await import("../helpers/schedulingFixtures");
const { createChannel, fakeWhatsApp, inboundBody } = await import("../helpers/whatsappFixtures");

type B = InstanceType<typeof Browser>;
const API = "/api/panel";

const base = await createEphemeralDb();
const { db } = base;
let app: Awaited<ReturnType<typeof startTestServer>>;
let restoreConsole: () => void;
const fake = fakeWhatsApp(db);

let w: Awaited<ReturnType<typeof createSchedulingWorld>>;
let escazuChannel: { channelId: string; phoneNumberId: string };
let herediaChannel: { channelId: string; phoneNumberId: string };
let owner: B;
let frontDesk: B; // solo Heredia
let staffUser: B;
let otherOwner: B; // otro negocio
let ownerUserId: string;

async function loggedIn(email: string, password: string | null): Promise<B> {
  const b = new Browser(app.baseUrl);
  const res = await b.post(`${API}/auth/login`, { email, password });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return b;
}

async function receive(phoneNumberId: string, from: string, input: { text?: string; name?: string; type?: string; message?: Record<string, unknown> } = {}) {
  const outcomes = await processWebhookBody(db, inboundBody({ phoneNumberId, from, ...input }));
  assert.deepEqual(outcomes, ["queued"]);
}

async function conversationIdOf(from: string, businessId = w.businessId): Promise<string> {
  const [row] = await withTenant(db, businessId, (tx) =>
    tx
      .select({ id: conversations.id })
      .from(conversations)
      .innerJoin(clients, eq(clients.id, conversations.clientId))
      .where(and(eq(conversations.businessId, businessId), eq(clients.phone, `+${from}`))),
  );
  assert.ok(row, `sin conversación para ${from}`);
  return row.id;
}

before(async () => {
  restoreConsole = silenceConsole();
  await base.client.exec("SET ROLE app_runtime");
  app = await startTestServer(createAppHandler({ db, role: "all", whatsapp: fake.deps }));
  w = await createSchedulingWorld(db);
  escazuChannel = await createChannel(db, w.businessId, { locationId: w.escazu });
  herediaChannel = await createChannel(db, w.businessId, { locationId: w.heredia });
  const o = await createTestMember(db, { businessId: w.businessId, role: "owner" });
  ownerUserId = o.userId;
  owner = await loggedIn(o.email, o.password);
  const fd = await createTestMember(db, { businessId: w.businessId, role: "front_desk", locationIds: [w.heredia] });
  frontDesk = await loggedIn(fd.email, fd.password);
  const st = await createTestMember(db, { businessId: w.businessId, role: "staff" });
  staffUser = await loggedIn(st.email, st.password);
  const other = await createSchedulingWorld(db);
  const oo = await createTestMember(db, { businessId: other.businessId, role: "owner" });
  otherOwner = await loggedIn(oo.email, oo.password);

  // María (cliente existente) y Laura por Escazú; Pedro por Heredia.
  await receive(escazuChannel.phoneNumberId, "50688880001", { text: "Hola, soy María" });
  await receive(escazuChannel.phoneNumberId, "50677770001", { text: "Buenas, ¿precios?", name: "Laura Mora" });
  await receive(herediaChannel.phoneNumberId, "50677770002", { text: "Hola desde Heredia", name: "Pedro Rojas" });
  await bookAppointment(db, w.businessId, { locationId: w.escazu, clientId: w.maria, serviceIds: [w.limpieza], staffId: w.ana, startsAt: crAt(crDay(4), "10:00"), channel: "panel" });
});

after(async () => {
  await app?.close();
  await base.close();
  restoreConsole();
});

// ── Bandeja ──────────────────────────────────────────────────────────────────

test("lista: contrato de cada ítem (cliente, último mensaje, no leídos, modo, estado, ventana, próxima cita)", async () => {
  const res = await owner.get(`${API}/whatsapp/conversations?status=all`);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const { items, nextCursor } = res.body.data;
  assert.equal(nextCursor, null);
  assert.equal(items.length, 3);
  for (const item of items) {
    assert.deepEqual(Object.keys(item).sort(), ["client", "id", "lastMessage", "mode", "nextAppointment", "status", "unread", "windowOpen"]);
    assert.deepEqual(Object.keys(item.client).sort(), ["id", "name", "phone"]);
    assert.deepEqual(Object.keys(item.lastMessage).sort(), ["at", "direction", "text"]);
  }
  const maria = items.find((i: any) => i.client.phone === "+50688880001");
  assert.equal(maria.client.name, "María Fernández", "el cliente existente conserva su nombre");
  assert.equal(maria.lastMessage.text, "Hola, soy María");
  assert.equal(maria.lastMessage.direction, "in");
  assert.equal(maria.unread, 1);
  assert.equal(maria.mode, "bot");
  assert.equal(maria.status, "open");
  assert.equal(maria.windowOpen, true);
  assert.ok(maria.nextAppointment?.id && maria.nextAppointment?.startsAt);
  assert.equal(items.find((i: any) => i.client.name === "Laura Mora").nextAppointment, null);
});

test("lista: paginación por cursor sin repetidos, búsqueda y filtro por estado", async () => {
  const page1 = await owner.get(`${API}/whatsapp/conversations?status=all&limit=2`);
  assert.equal(page1.body.data.items.length, 2);
  assert.ok(page1.body.data.nextCursor);
  const page2 = await owner.get(`${API}/whatsapp/conversations?status=all&limit=2&cursor=${encodeURIComponent(page1.body.data.nextCursor)}`);
  assert.equal(page2.body.data.items.length, 1);
  assert.equal(page2.body.data.nextCursor, null);
  const ids = [...page1.body.data.items, ...page2.body.data.items].map((i: any) => i.id);
  assert.equal(new Set(ids).size, 3);
  assert.equal((await owner.get(`${API}/whatsapp/conversations?cursor=basura`)).status, 400);

  const search = await owner.get(`${API}/whatsapp/conversations?status=all&q=Laura`);
  assert.deepEqual(search.body.data.items.map((i: any) => i.client.name), ["Laura Mora"]);
  const byPhone = await owner.get(`${API}/whatsapp/conversations?status=all&q=77770002`);
  assert.deepEqual(byPhone.body.data.items.map((i: any) => i.client.name), ["Pedro Rojas"]);

  const lauraId = await conversationIdOf("50677770001");
  assert.equal((await owner.post(`${API}/whatsapp/conversations/${lauraId}/status`, { status: "attended" })).body.data.status, "attended");
  const open = await owner.get(`${API}/whatsapp/conversations?status=open`);
  assert.ok(!open.body.data.items.some((i: any) => i.id === lauraId));
  const attended = await owner.get(`${API}/whatsapp/conversations?status=attended`);
  assert.deepEqual(attended.body.data.items.map((i: any) => i.id), [lauraId]);
  await owner.post(`${API}/whatsapp/conversations/${lauraId}/status`, { status: "open" });
});

test("permisos: sin sesión 401, profesional 403, recepción solo ve las conversaciones de su sucursal", async () => {
  assert.equal((await new Browser(app.baseUrl).get(`${API}/whatsapp/conversations`)).status, 401);
  const forbidden = await staffUser.get(`${API}/whatsapp/conversations`);
  assert.equal(forbidden.status, 403);
  assert.equal(forbidden.body.code, "forbidden_role");

  const fd = await frontDesk.get(`${API}/whatsapp/conversations?status=all`);
  assert.equal(fd.status, 200);
  assert.deepEqual(fd.body.data.items.map((i: any) => i.client.name), ["Pedro Rojas"]);
  const mariaId = await conversationIdOf("50688880001");
  assert.equal((await frontDesk.get(`${API}/whatsapp/conversations/${mariaId}`)).status, 404, "una conversación de Escazú no existe para ella");
  assert.equal((await frontDesk.post(`${API}/whatsapp/conversations/${mariaId}/messages`, { text: "hola" })).status, 404);
  assert.equal((await frontDesk.get(`${API}/whatsapp/channels`)).status, 403, "los canales son de dueño/admin");
});

test("aislamiento entre negocios: otro negocio no ve ni toca una conversación ajena", async () => {
  const mariaId = await conversationIdOf("50688880001");
  assert.equal((await otherOwner.get(`${API}/whatsapp/conversations/${mariaId}`)).status, 404);
  assert.equal((await otherOwner.post(`${API}/whatsapp/conversations/${mariaId}/mode`, { mode: "human" })).status, 404);
  assert.deepEqual((await otherOwner.get(`${API}/whatsapp/conversations?status=all`)).body.data.items, []);
});

test("detalle: mensajes en orden con autor y adjunto firmado; paginación hacia atrás", async () => {
  await receive(escazuChannel.phoneNumberId, "50677770003", { text: "primero", name: "Ana Foto" });
  await receive(escazuChannel.phoneNumberId, "50677770003", { type: "image", message: { image: { id: "IMG9", mime_type: "image/jpeg" } } });
  const id = await conversationIdOf("50677770003");
  await withTenant(db, w.businessId, async (tx) => {
    await tx.update(messages).set({ mediaPath: `${w.businessId}/whatsapp/${id}/IMG9.jpg` }).where(and(eq(messages.conversationId, id), eq(messages.mediaType, "image")));
    const t0 = Date.now() + 1000;
    await tx.insert(messages).values([
      { businessId: w.businessId, conversationId: id, role: "assistant", content: "respuesta del bot", createdAt: new Date(t0), updatedAt: new Date(t0) },
      { businessId: w.businessId, conversationId: id, role: "assistant", content: "respuesta humana", byHuman: true, createdAt: new Date(t0 + 1), updatedAt: new Date(t0 + 1) },
    ]);
  });
  const res = await owner.get(`${API}/whatsapp/conversations/${id}`);
  assert.equal(res.status, 200);
  const { conversation, messages: list, nextBefore } = res.body.data;
  assert.equal(conversation.id, id);
  assert.equal(nextBefore, null);
  assert.deepEqual(list.map((m: any) => [m.by, m.direction]), [["client", "in"], ["client", "in"], ["bot", "out"], ["human", "out"]]);
  const photo = list[1];
  assert.equal(photo.mediaType, "image");
  assert.match(photo.mediaUrl, /^https:\/\/storage\.test\/.*IMG9\.jpg\?token=/);
  assert.equal(list[0].mediaUrl, undefined);

  // 55 mensajes más: página de 50 y el resto con `before`.
  await withTenant(db, w.businessId, (tx) =>
    tx.insert(messages).values(
      Array.from({ length: 55 }, (_, i) => ({ businessId: w.businessId, conversationId: id, role: "user", content: `m${i}`, createdAt: new Date(Date.now() + 5000 + i), updatedAt: new Date() })),
    ),
  );
  const first = await owner.get(`${API}/whatsapp/conversations/${id}`);
  assert.equal(first.body.data.messages.length, 50);
  assert.equal(first.body.data.messages.at(-1).text, "m54");
  assert.ok(first.body.data.nextBefore);
  const older = await owner.get(`${API}/whatsapp/conversations/${id}?before=${encodeURIComponent(first.body.data.nextBefore)}`);
  assert.equal(older.body.data.messages.length, 9);
  assert.equal(older.body.data.messages[0].text, "primero");
  assert.equal(older.body.data.nextBefore, null);
});

test("respuesta humana: dentro de la ventana se manda, toma la conversación y la deja leída; fuera, 409 window_closed", async () => {
  const id = await conversationIdOf("50677770001");
  const res = await owner.post(`${API}/whatsapp/conversations/${id}/messages`, { text: "¡Hola Laura! Te paso los precios." });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.data.by, "human");
  assert.equal(res.body.data.direction, "out");
  assert.deepEqual(fake.sent.at(-1), { kind: "text", phoneNumberId: escazuChannel.phoneNumberId, to: "+50677770001", text: "¡Hola Laura! Te paso los precios." });
  const item = (await owner.get(`${API}/whatsapp/conversations/${id}`)).body.data.conversation;
  assert.equal(item.mode, "human");
  assert.equal(item.unread, 0);
  assert.equal((await owner.post(`${API}/whatsapp/conversations/${id}/messages`, { text: "" })).status, 400);

  // Último mensaje del cliente hace más de 24 h.
  await withTenant(db, w.businessId, (tx) =>
    tx.update(messages).set({ createdAt: new Date(Date.now() - 25 * 3_600_000) }).where(and(eq(messages.conversationId, id), eq(messages.role, "user"))),
  );
  const closed = await owner.post(`${API}/whatsapp/conversations/${id}/messages`, { text: "¿Seguís ahí?" });
  assert.equal(closed.status, 409);
  assert.equal(closed.body.code, "window_closed");

  // Reapertura: sin plantilla 409; con plantilla se manda.
  const noTemplate = await owner.post(`${API}/whatsapp/conversations/${id}/reopen`);
  assert.equal(noTemplate.body.code, "template_missing");
  const patch = await owner.patch(`${API}/whatsapp/channels/${escazuChannel.channelId}`, { templates: { reopen: { name: "retomar_conversacion", language: "es" } } });
  assert.equal(patch.status, 200, JSON.stringify(patch.body));
  const reopened = await owner.post(`${API}/whatsapp/conversations/${id}/reopen`);
  assert.equal(reopened.status, 200, JSON.stringify(reopened.body));
  assert.equal(fake.sent.at(-1)?.template?.name, "retomar_conversacion");

  // Con la ventana abierta no hace falta reabrir.
  const maria = await conversationIdOf("50688880001");
  assert.equal((await owner.post(`${API}/whatsapp/conversations/${maria}/reopen`)).body.code, "window_open");
});

test("modo y leído", async () => {
  const id = await conversationIdOf("50677770002");
  const human = await owner.post(`${API}/whatsapp/conversations/${id}/mode`, { mode: "human" });
  assert.equal(human.body.data.mode, "human");
  assert.equal((await owner.post(`${API}/whatsapp/conversations/${id}/mode`, { mode: "robot" })).status, 400);
  const read = await frontDesk.post(`${API}/whatsapp/conversations/${id}/read`);
  assert.equal(read.status, 200);
  assert.equal(read.body.data.unread, 0);
  // El Inicio cuenta las que esperan a una persona.
  const home = await owner.get(`${API}/home/today`);
  assert.ok(home.body.data.conversationsWaiting >= 1);
  await owner.post(`${API}/whatsapp/conversations/${id}/mode`, { mode: "bot" });
});

test("resumen y métricas: formas del contrato y validación del rango", async () => {
  const summary = await owner.get(`${API}/whatsapp/summary`);
  assert.equal(summary.status, 200);
  assert.deepEqual(Object.keys(summary.body.data).sort(), ["bookingsByAgentThisWeek", "conversationsThisWeek", "conversationsWaiting", "handoffsThisWeek", "openConversations"]);
  assert.ok(summary.body.data.conversationsThisWeek >= 3);
  const fd = await frontDesk.get(`${API}/whatsapp/summary`);
  assert.equal(fd.body.data.conversationsThisWeek, 1, "recepción cuenta solo lo de su sucursal");

  const metrics = await owner.get(`${API}/whatsapp/metrics`);
  assert.equal(metrics.status, 200);
  const m = metrics.body.data;
  assert.deepEqual(Object.keys(m).sort(), ["aiCostMicros", "bookingsByAgent", "byDay", "conversations", "handoffs", "resolvedWithoutHuman"]);
  assert.equal(m.byDay.length, 30);
  assert.deepEqual(Object.keys(m.byDay[0]).sort(), ["bookings", "conversations", "date"]);
  assert.ok(m.conversations >= 3);
  assert.ok(m.resolvedWithoutHuman < m.conversations, "las que atendió una persona no cuentan");
  assert.equal((await owner.get(`${API}/whatsapp/metrics?from=2026-10-10&to=2026-10-01`)).status, 400);
  assert.equal((await owner.get(`${API}/whatsapp/metrics?from=2024-01-01&to=2026-01-01`)).status, 400);
  assert.equal((await owner.get(`${API}/whatsapp/metrics?from=2026-10-01&to=2026-10-03`)).body.data.byDay.length, 3);
});

// ── Canales ──────────────────────────────────────────────────────────────────

test("canales: lista sin token, configuración (sucursal y plantillas) y prueba del token", async () => {
  const list = await owner.get(`${API}/whatsapp/channels`);
  assert.equal(list.status, 200);
  const channel = list.body.data.find((c: any) => c.id === herediaChannel.channelId);
  assert.equal(channel.tokenStatus, "valid");
  assert.equal(JSON.stringify(list.body).includes("token-de-prueba"), false, "el token nunca sale por la API");
  assert.equal(JSON.stringify(list.body).includes("accessToken"), false);

  const patched = await owner.patch(`${API}/whatsapp/channels/${herediaChannel.channelId}`, {
    locationId: null,
    templates: { reminder: { name: "recordatorio_cita", language: "es_MX" } },
  });
  assert.equal(patched.status, 200);
  assert.equal(patched.body.data.locationId, null);
  assert.deepEqual(patched.body.data.templates.reminder, { name: "recordatorio_cita", language: "es_MX" });
  const removed = await owner.patch(`${API}/whatsapp/channels/${herediaChannel.channelId}`, { locationId: w.heredia, templates: { reminder: null } });
  assert.equal(removed.body.data.templates.reminder, undefined);
  const badLocation = await owner.patch(`${API}/whatsapp/channels/${herediaChannel.channelId}`, { locationId: "00000000-0000-4000-8000-000000000000" });
  assert.equal(badLocation.status, 400);
  const badTemplate = await owner.patch(`${API}/whatsapp/channels/${herediaChannel.channelId}`, { templates: { reminder: { name: "Con Espacios", language: "es" } } });
  assert.equal(badTemplate.status, 400);

  const tested = await owner.post(`${API}/whatsapp/channels/${herediaChannel.channelId}/test`);
  assert.equal(tested.status, 200);
  assert.deepEqual([tested.body.data.ok, tested.body.data.tokenStatus], [true, "valid"]);
  assert.equal((await otherOwner.post(`${API}/whatsapp/channels/${herediaChannel.channelId}/test`)).status, 404);
});

test("Embedded Signup: config pública, conexión con el código y número ya tomado por otro negocio", async () => {
  const config = await owner.get(`${API}/whatsapp/channels/signup-config`);
  assert.deepEqual(config.body.data, { appId: "123456", configId: "654321", graphVersion: config.body.data.graphVersion });
  assert.equal(JSON.stringify(config.body).includes("test-app-secret"), false);

  const bad = await owner.post(`${API}/whatsapp/channels/connect`, { code: "bad" });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.code, "signup_failed");

  const ok = await owner.post(`${API}/whatsapp/channels/connect`, { code: "codigo-del-popup" });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.equal(ok.body.data.phoneNumberId, "5550001111");
  assert.equal(ok.body.data.wabaId, "1234567890");
  assert.equal(ok.body.data.displayPhone, "+506 8888 0000", "el número visible sale de los datos del número en Meta");
  assert.equal(ok.body.data.status, "active");
  const [row] = await withTenant(db, w.businessId, (tx) => tx.select().from(whatsappChannels).where(eq(whatsappChannels.id, ok.body.data.id)));
  assert.ok(row.accessTokenEncrypted?.startsWith("v1:"), "el token queda cifrado");
  assert.equal(row.accessTokenEncrypted?.includes("token-del-waba"), false);
  const audit = await withTenant(db, w.businessId, (tx) => tx.select().from(auditLog).where(eq(auditLog.businessId, w.businessId)));
  assert.ok(audit.some((a) => a.action === "whatsapp_channel_connected" && !JSON.stringify(a.details).includes("token-del-waba")));

  const taken = await otherOwner.post(`${API}/whatsapp/channels/connect`, { code: "otro-codigo" });
  assert.equal(taken.status, 409);
  assert.equal(taken.body.code, "channel_taken");
});

test("superadmin: alta manual de un número para un negocio", async () => {
  const admin = new Browser(app.baseUrl);
  assert.equal((await admin.post(`${API}/admin/login`, { username: "root", password: ADMIN_PASSWORD })).status, 200);
  const res = await admin.post(`${API}/admin/businesses/${w.businessId}/whatsapp`, { phoneNumberId: "4440009999", accessToken: "token-manual-de-prueba-123456" });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.data.tokenStatus, "valid");
  const pending = await admin.post(`${API}/admin/businesses/${w.businessId}/whatsapp`, { phoneNumberId: "4440008888" });
  assert.equal(pending.body.data.status, "pending");
  assert.equal(pending.body.data.tokenStatus, "missing");
  assert.equal((await owner.post(`${API}/admin/businesses/${w.businessId}/whatsapp`, { phoneNumberId: "4440007777" })).status, 401);
  assert.equal((await admin.post(`${API}/admin/businesses/00000000-0000-4000-8000-000000000000/whatsapp`, { phoneNumberId: "4440006666" })).status, 404);
});

// ── Push ─────────────────────────────────────────────────────────────────────

test("push: llave pública, suscripción por usuario, endpoints no permitidos y prueba solo a quien la pide", async () => {
  assert.deepEqual((await owner.get(`${API}/push/public-key`)).body.data, { key: "BPublicKeyDePrueba" });
  const keys = { p256dh: "B".repeat(87), auth: "A".repeat(22) };
  const endpoint = "https://fcm.googleapis.com/fcm/send/dispositivo-del-dueno";
  assert.equal((await owner.post(`${API}/push/subscribe`, { endpoint, keys })).status, 200);
  assert.equal((await frontDesk.post(`${API}/push/subscribe`, { endpoint: "https://web.push.apple.com/recepcion", keys })).status, 200);
  const ssrf = await owner.post(`${API}/push/subscribe`, { endpoint: "https://169.254.169.254/latest/meta-data", keys });
  assert.equal(ssrf.status, 400);
  const rows = await withTenant(db, w.businessId, (tx) => tx.select().from(pushSubscriptions).where(eq(pushSubscriptions.businessId, w.businessId)));
  assert.ok(rows.some((r) => r.endpoint === endpoint && r.userId === ownerUserId));

  fake.pushes.length = 0;
  const tested = await owner.post(`${API}/push/test`);
  assert.equal(tested.status, 200);
  assert.deepEqual(tested.body.data, { sent: 1, failed: 0 });
  assert.equal(fake.pushes[0].target.endpoint, endpoint);

  assert.deepEqual((await owner.post(`${API}/push/unsubscribe`, { endpoint })).body.data, { removed: true });
  assert.deepEqual((await frontDesk.post(`${API}/push/unsubscribe`, { endpoint: "https://web.push.apple.com/recepcion" })).body.data, { removed: true });
  assert.equal((await staffUser.post(`${API}/push/subscribe`, { endpoint, keys })).status, 403);
});

// ── Borrador de datos ────────────────────────────────────────────────────────

test("anonimizar un cliente borra sus conversaciones y mensajes y encola el borrado de sus adjuntos", async () => {
  await receive(escazuChannel.phoneNumberId, "50677770009", { text: "borrame", name: "Para Borrar" });
  const id = await conversationIdOf("50677770009");
  await withTenant(db, w.businessId, (tx) =>
    tx.insert(messages).values({ businessId: w.businessId, conversationId: id, role: "user", content: "[foto]", mediaType: "image", mediaPath: `${w.businessId}/whatsapp/${id}/x.jpg` }),
  );
  const [client] = await withTenant(db, w.businessId, (tx) => tx.select().from(clients).where(eq(clients.phone, "+50677770009")));
  const res = await owner.post(`${API}/clients/${client.id}/anonymize`, { confirmation: "+50677770009" });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const left = await withTenant(db, w.businessId, (tx) => tx.select().from(conversations).where(eq(conversations.id, id)));
  assert.equal(left.length, 0);
  const leftMessages = await withTenant(db, w.businessId, (tx) => tx.select().from(messages).where(eq(messages.conversationId, id)));
  assert.equal(leftMessages.length, 0);
  const erase = (await allJobs(db)).find((j) => j.type === WHATSAPP_MEDIA_ERASE_JOB && j.businessId === w.businessId);
  assert.deepEqual((erase?.payload as { paths: string[] }).paths, [`${w.businessId}/whatsapp/${id}/x.jpg`]);
  const audit = await withSystem(db, (tx) => tx.select().from(auditLog).where(and(eq(auditLog.businessId, w.businessId), eq(auditLog.action, "client_anonymized"))));
  const details = audit.at(-1)?.details as Record<string, unknown>;
  assert.deepEqual([details.whatsappConversations, details.whatsappMessages, details.whatsappMedia], [1, 2, 1]);
});

test("module gate: sin el módulo whatsapp en el plan, la bandeja responde 403", async () => {
  const gated = createAppHandler({ db, role: "all", whatsapp: fake.deps, panelApi: { moduleGate: (_b, m) => m !== "whatsapp" } });
  const server = await startTestServer(gated);
  try {
    const b = new Browser(server.baseUrl);
    for (const [k, v] of owner.cookies) b.cookies.set(k, v);
    const res = await b.get(`${API}/whatsapp/conversations`);
    assert.equal(res.status, 403);
    assert.equal(res.body.code, "module_not_in_plan");
  } finally {
    await server.close();
  }
  _resetChannelStateForTests();
});
