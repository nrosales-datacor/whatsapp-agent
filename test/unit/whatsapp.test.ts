import assert from "node:assert/strict";
import { test } from "node:test";

// ─────────────────────────────────────────────────────────────────────────────
// Piezas puras del módulo WhatsApp: firma y verificación del webhook, lectura del payload
// de Meta, acciones directas (BAJA, pedir una persona, Confirmo/Cancelar), textos por
// registro, ventana de 24 h, vencimiento del modo humano, frenos de costo y el cliente de
// Graph contra un `fetch` falso (nunca sale a la red).
// ─────────────────────────────────────────────────────────────────────────────

process.env.TOKENS_ENCRYPTION_KEY = "e".repeat(64);

const { isValidSignature, verifySubscription } = await import("../../src/modules/whatsapp/webhook");
const { classifyWebhookPayload, splitWebhookPayload, storedContent, reminderButtonIds } = await import("../../src/modules/whatsapp/payload");
const { appointmentReplyOf, directActionOf, isOptOutRequest, requestsHuman } = await import("../../src/modules/whatsapp/commands");
const { pipelineText, registerFor } = await import("../../src/modules/whatsapp/texts");
const { humanModeExpired, windowState, WINDOW_MS } = await import("../../src/modules/whatsapp/rules");
const { allowIngest, capStatus, detectLoop, _resetIngestBucketsForTests } = await import("../../src/modules/whatsapp/limits");
const { createGraphApi, GraphError, MediaTooLargeError } = await import("../../src/modules/whatsapp/graph");
const { audioDurationSec, audioMaxSec, clipTranscript, MAX_TRANSCRIPT_CHARS } = await import("../../src/modules/whatsapp/media");
const { reminderWhen } = await import("../../src/modules/whatsapp/reminders");
const { isAllowedPushEndpoint } = await import("../../src/modules/whatsapp/push");
const { isTransientError } = await import("../../src/platform/net/transient");
const { inboundBody, oggOpusAudio, sign, statusBody } = await import("../helpers/whatsappFixtures");

// ── Firma y verificación ─────────────────────────────────────────────────────

test("firma X-Hub-Signature-256: acepta la de Meta y rechaza cualquier otra", () => {
  const raw = Buffer.from(JSON.stringify({ hola: "mundo" }));
  const good = sign(raw.toString(), "secreto");
  assert.equal(isValidSignature(raw, good, "secreto"), true);
  assert.equal(isValidSignature(raw, good, "otro-secreto"), false);
  assert.equal(isValidSignature(Buffer.from("{}"), good, "secreto"), false);
  assert.equal(isValidSignature(raw, undefined, "secreto"), false);
  assert.equal(isValidSignature(raw, good, undefined), false, "sin secreto configurado no se acepta nada");
  assert.equal(isValidSignature(raw, "sha256=corto", "secreto"), false);
});

test("verificación de la suscripción: devuelve el challenge solo con el token correcto", () => {
  const params = (mode: string, token: string) => new URLSearchParams({ "hub.mode": mode, "hub.verify_token": token, "hub.challenge": "1234" });
  assert.equal(verifySubscription(params("subscribe", "tok"), "tok"), "1234");
  assert.equal(verifySubscription(params("subscribe", "otro"), "tok"), null);
  assert.equal(verifySubscription(params("unsubscribe", "tok"), "tok"), null);
  assert.equal(verifySubscription(params("subscribe", "tok"), undefined), null);
});

// ── Payload ──────────────────────────────────────────────────────────────────

test("un POST con varios mensajes se parte en un pedazo por mensaje", () => {
  const body = inboundBody({ phoneNumberId: "111", from: "50688880001", text: "uno" }) as any;
  const second = { ...body.entry[0].changes[0].value.messages[0], id: "wamid.2", text: { body: "dos" } };
  body.entry[0].changes[0].value.messages.push(second);
  body.entry.push(statusBody("222").entry);
  const parts = splitWebhookPayload(body);
  assert.equal(parts.length, 3);
  const texts = parts.map((p) => classifyWebhookPayload(p)).map((c) => (c.type === "message" ? c.message.text : c.type));
  assert.deepEqual(texts.slice(0, 2), ["uno", "dos"]);
});

test("clasificación: estados y reacciones se ignoran; formas raras quedan para raw_webhooks", () => {
  assert.equal(classifyWebhookPayload(splitWebhookPayload(statusBody("111"))[0]).type, "ignorable");
  const reaction = inboundBody({ phoneNumberId: "111", from: "50688880001", type: "reaction", message: { reaction: { emoji: "👍" } } });
  assert.equal(classifyWebhookPayload(reaction).type, "ignorable");
  assert.equal(classifyWebhookPayload({ algo: "raro" }).type, "unparseable");
  const noId = inboundBody({ phoneNumberId: "111", from: "50688880001" }) as any;
  delete noId.entry[0].changes[0].value.messages[0].id;
  assert.equal(classifyWebhookPayload(noId).type, "unparseable", "sin wamid no hay idempotencia");
});

test("clasificación: texto, foto con leyenda, audio, ubicación, contacto y remitente saneado", () => {
  const text = classifyWebhookPayload(inboundBody({ phoneNumberId: "111", from: "+506 8888-0001", text: "hola", name: "Ana" }));
  assert.equal(text.type, "message");
  if (text.type === "message") {
    assert.equal(text.message.from, "50688880001");
    assert.equal(text.message.profileName, "Ana");
    assert.equal(text.message.kind, "text");
  }
  const photo = classifyWebhookPayload(inboundBody({ phoneNumberId: "111", from: "1", type: "image", message: { image: { id: "MEDIA1", caption: "así", mime_type: "image/jpeg" } } }));
  assert.ok(photo.type === "message" && photo.message.kind === "image" && photo.message.mediaId === "MEDIA1");
  if (photo.type === "message") assert.equal(storedContent(photo.message), "[foto] así");
  const audio = classifyWebhookPayload(inboundBody({ phoneNumberId: "111", from: "1", type: "audio", message: { audio: { id: "A1", mime_type: "audio/ogg" } } }));
  assert.ok(audio.type === "message" && audio.message.kind === "audio");
  const location = classifyWebhookPayload(inboundBody({ phoneNumberId: "111", from: "1", type: "location", message: { location: { latitude: 9.9, longitude: -84.1, name: "Plaza" } } }));
  assert.ok(location.type === "message" && location.message.kind === "text" && location.message.text.includes("Plaza"));
  const contact = classifyWebhookPayload(inboundBody({ phoneNumberId: "111", from: "1", type: "contacts", message: { contacts: [{ name: { formatted_name: "Beto" } }, { name: { formatted_name: "Caro" } }] } }));
  assert.ok(contact.type === "message" && contact.message.contactName === "Beto (+1 más)");
  const sticker = classifyWebhookPayload(inboundBody({ phoneNumberId: "111", from: "1", type: "sticker", message: { sticker: { id: "S" } } }));
  assert.ok(sticker.type === "message" && sticker.message.kind === "unsupported");
});

test("botones: el de la cita (nativo o de plantilla) se traduce a una frase y conserva el id", () => {
  const ids = reminderButtonIds("0b0f3c1e-9d8a-4c1b-8e5f-6a7b8c9d0e1f");
  const native = classifyWebhookPayload(
    inboundBody({ phoneNumberId: "111", from: "1", type: "interactive", message: { interactive: { type: "button_reply", button_reply: { id: ids.confirm, title: "Confirmo ✅" } } } }),
  );
  assert.ok(native.type === "message");
  if (native.type === "message") {
    assert.equal(native.message.text, "Confirmo mi cita ✅");
    assert.deepEqual(appointmentReplyOf(native.message), { action: "confirm", appointmentId: "0b0f3c1e-9d8a-4c1b-8e5f-6a7b8c9d0e1f" });
    assert.equal(directActionOf(native.message), "appointment_reply");
  }
  const template = classifyWebhookPayload(inboundBody({ phoneNumberId: "111", from: "1", type: "button", message: { button: { payload: ids.cancel, text: "Cancelar" } } }));
  assert.ok(template.type === "message" && appointmentReplyOf(template.message)?.action === "cancel");
  // Plantilla configurada sin nuestro payload: se reconoce por el texto (la cita se resuelve después).
  const loose = classifyWebhookPayload(inboundBody({ phoneNumberId: "111", from: "1", type: "button", message: { button: { payload: "OTRA_COSA", text: "Confirmo" } } }));
  assert.ok(loose.type === "message");
  if (loose.type === "message") assert.deepEqual(appointmentReplyOf(loose.message), { action: "confirm", appointmentId: null });
  // Un botón ajeno (del agente) llega como texto con su título y va al agente.
  const agentButton = classifyWebhookPayload(
    inboundBody({ phoneNumberId: "111", from: "1", type: "interactive", message: { interactive: { button_reply: { id: "slot|2026-10-22|10:00", title: "10:00 a.m." } } } }),
  );
  assert.ok(agentButton.type === "message" && agentButton.message.text === "10:00 a.m." && directActionOf(agentButton.message) === null);
});

// ── Acciones directas ────────────────────────────────────────────────────────

test("BAJA: el mensaje completo es el pedido (con cortesía alrededor); una frase con la palabra no", () => {
  for (const t of ["baja", "BAJA.", "Stop", "hola, baja por favor", "no quiero más promociones", "no me manden más mensajes", "darme de baja", "Quiero dejar de recibir ofertas", "no quiero recibir mas campañas"]) {
    assert.equal(isOptOutRequest(t), true, t);
  }
  for (const t of ["quiero cancelar mi cita", "¿baja el precio?", "", "la baja de presión", "no quiero más citas"]) {
    assert.equal(isOptOutRequest(t), false, t);
  }
});

test("pedir una persona: solo con un pedido explícito", () => {
  for (const t of ["agente", "Una persona por favor", "quiero hablar con una persona", "pasame con un asesor", "necesito un humano", "can I talk to a human"]) {
    assert.equal(requestsHuman(t), true, t);
  }
  for (const t of ["¿cuánto cuesta por persona?", "es para otra persona", "pasame el precio por persona", "hola"]) {
    assert.equal(requestsHuman(t), false, t);
  }
});

// ── Textos, ventana y modo humano ────────────────────────────────────────────

test("textos: registro configurado o del país; override del negocio con variables", () => {
  assert.equal(registerFor(null, "CR"), "vos");
  assert.equal(registerFor(null, "MX"), "tu");
  assert.equal(registerFor("usted", "CR"), "usted");
  const profile = { register: "vos" as const, overrides: {}, businessName: "Estética Sol" };
  assert.match(pipelineText(profile, "botNotice"), /Estética Sol.*Escribí \*agente\*/);
  assert.equal(pipelineText({ ...profile, overrides: { optOutAck: "Listo {negocio}" } }, "optOutAck"), "Listo Estética Sol");
});

test("ventana de 24 h desde el último mensaje del cliente", () => {
  const now = new Date("2026-10-21T12:00:00Z");
  assert.deepEqual(windowState(null, now), { open: false, closesAt: null });
  assert.equal(windowState(new Date(now.getTime() - WINDOW_MS + 60_000), now).open, true);
  assert.equal(windowState(new Date(now.getTime() - WINDOW_MS - 1), now).open, false);
});

test("modo humano: vence sin actividad del equipo; los mensajes del cliente no cuentan", () => {
  const now = new Date("2026-10-21T12:00:00Z");
  const h = (hours: number) => new Date(now.getTime() - hours * 3_600_000);
  assert.equal(humanModeExpired({ mode: "human", humanSince: h(13) }, null, now, 12), true);
  assert.equal(humanModeExpired({ mode: "human", humanSince: h(13) }, h(1), now, 12), false, "una persona respondió hace 1 h");
  assert.equal(humanModeExpired({ mode: "human", humanSince: h(13) }, null, now, 0), false, "0 = nunca vence");
  assert.equal(humanModeExpired({ mode: "human", humanSince: null }, null, now, 12), false, "sin marcas no vence");
  assert.equal(humanModeExpired({ mode: "bot", humanSince: h(20) }, null, now, 12), false);
});

// ── Frenos ───────────────────────────────────────────────────────────────────

test("bucle con otro bot: el mismo texto (números aparte) muchas veces; multimedia no cuenta", () => {
  const msgs = (texts: string[]) => texts.map((content) => ({ content }));
  assert.deepEqual(detectLoop(msgs(["Ticket #1 recibido", "ticket #2 recibido", "Ticket #3 recibido", "TICKET #4 RECIBIDO", "Ticket #5 recibido"]), 5), { repeats: 5 });
  assert.equal(detectLoop(msgs(["hola", "hola", "hola"]), 5), null);
  assert.equal(detectLoop(msgs(Array(10).fill("[foto]")), 5), null);
  assert.equal(detectLoop(msgs(Array(10).fill("hola")), 0), null);
});

test("topes mensuales: conversaciones por encima del tope o gasto que lo alcanza", () => {
  const limits = { monthlyConversations: 10, monthlySpendMicros: 1_000_000 };
  assert.deepEqual(capStatus(limits, { conversationsStarted: 10, costMicros: 999_999 }), { conversationsExceeded: false, spendExceeded: false });
  assert.deepEqual(capStatus(limits, { conversationsStarted: 11, costMicros: 1_000_000 }), { conversationsExceeded: true, spendExceeded: true });
  assert.deepEqual(capStatus({ monthlyConversations: null, monthlySpendMicros: null }, { conversationsStarted: 1e6, costMicros: 1e12 }), {
    conversationsExceeded: false,
    spendExceeded: false,
  });
});

test("freno de ingesta: tolera la ráfaga y después difiere hasta que se recarga", () => {
  _resetIngestBucketsForTests();
  const t0 = 1_000_000;
  let allowed = 0;
  for (let i = 0; i < 25; i++) if (allowIngest("negocio-a", t0)) allowed++;
  assert.equal(allowed, 20);
  assert.equal(allowIngest("negocio-b", t0), true, "cada negocio tiene su balde");
  assert.equal(allowIngest("negocio-a", t0 + 1_000), true, "se recarga un token por segundo");
  _resetIngestBucketsForTests();
});

test("push: solo endpoints https de los servicios de push de los navegadores", () => {
  assert.equal(isAllowedPushEndpoint("https://fcm.googleapis.com/fcm/send/abc"), true);
  assert.equal(isAllowedPushEndpoint("https://web.push.apple.com/xyz"), true);
  assert.equal(isAllowedPushEndpoint("http://fcm.googleapis.com/x"), false);
  assert.equal(isAllowedPushEndpoint("https://169.254.169.254/latest"), false);
  assert.equal(isAllowedPushEndpoint("https://evil.com/push.apple.com"), false);
  assert.equal(isAllowedPushEndpoint("https://fcm.googleapis.com:8443/x"), false);
});

test("recordatorio: cuándo, en la zona de la sucursal", () => {
  const at = new Date("2026-10-23T16:00:00Z"); // 10:00 en Costa Rica
  assert.equal(reminderWhen(at, "America/Costa_Rica", "same_day"), "hoy a las 10:00");
  assert.match(reminderWhen(at, "America/Costa_Rica", "day_before"), /^mañana .*23.* a las 10:00$/);
});

// ── Cliente de Graph ─────────────────────────────────────────────────────────

const channel = { channelId: "c1", businessId: "b1", phoneNumberId: "555", accessToken: "TOKEN" };

function fakeFetch(responses: (Response | Error)[]) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const next = responses.shift();
    if (!next) throw new Error("sin respuesta configurada");
    if (next instanceof Error) throw next;
    return next;
  }) as typeof fetch;
  return { fn, calls };
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

test("Graph: reintenta en caliente lo transitorio y devuelve el id del mensaje", async () => {
  const { fn, calls } = fakeFetch([json(500, { error: { message: "caído" } }), json(200, { messages: [{ id: "wamid.OK" }] })]);
  const api = createGraphApi({ fetch: fn, retryDelayMs: () => 0 });
  const result = await api.sendText(channel, "+50688880001", "hola");
  assert.equal(calls.length, 2);
  assert.equal(result.messageId, "wamid.OK");
  const sent = JSON.parse(String(calls[1].init?.body));
  assert.equal(sent.to, "50688880001");
  assert.equal(sent.text.body, "hola");
  assert.equal((calls[1].init?.headers as Record<string, string>).Authorization, "Bearer TOKEN");
});

test("Graph: un error transitorio que persiste sale marcado como transitorio para la cola", async () => {
  const { fn, calls } = fakeFetch([json(503, {}), json(503, {}), json(429, {})]);
  const api = createGraphApi({ fetch: fn, retryDelayMs: () => 0 });
  await assert.rejects(api.sendText(channel, "1", "x"), (e: unknown) => e instanceof GraphError && e.transient && isTransientError(e));
  assert.equal(calls.length, 3);
});

test("Graph: token inválido (190) no se reintenta y avisa el estado del token", async () => {
  const statuses: boolean[] = [];
  const { fn, calls } = fakeFetch([json(400, { error: { code: 190, message: "Error validating access token" } }), json(200, { messages: [{ id: "w" }] })]);
  const api = createGraphApi({ fetch: fn, retryDelayMs: () => 0, onTokenStatus: (_c, valid) => statuses.push(valid) });
  await assert.rejects(api.sendText(channel, "1", "x"), (e: unknown) => e instanceof GraphError && e.tokenInvalid && !e.transient && !isTransientError(e));
  assert.equal(calls.length, 1);
  await api.sendText(channel, "1", "y");
  assert.deepEqual(statuses, [false, true]);
});

test("Graph: plantilla con variables y payloads de los botones; botones recortados a 3", async () => {
  const { fn, calls } = fakeFetch([json(200, { messages: [{ id: "a" }] }), json(200, { messages: [{ id: "b" }] })]);
  const api = createGraphApi({ fetch: fn, retryDelayMs: () => 0 });
  await api.sendTemplate(channel, "1", { name: "recordatorio", language: "es", bodyParams: ["Ana", "Limpieza", "mañana"], quickReplyPayloads: ["confirm|x", "cancel|x"] });
  const t = JSON.parse(String(calls[0].init?.body)).template;
  assert.equal(t.name, "recordatorio");
  assert.equal(t.language.code, "es");
  assert.deepEqual(t.components[0].parameters.map((p: { text: string }) => p.text), ["Ana", "Limpieza", "mañana"]);
  assert.deepEqual(t.components.slice(1).map((c: any) => [c.sub_type, c.index, c.parameters[0].payload]), [
    ["quick_reply", "0", "confirm|x"],
    ["quick_reply", "1", "cancel|x"],
  ]);
  await api.sendButtons(channel, "1", "¿Confirmás?", [1, 2, 3, 4].map((i) => ({ id: `b${i}`, title: `Botón número ${i} largo` })));
  const buttons = JSON.parse(String(calls[1].init?.body)).interactive.action.buttons;
  assert.equal(buttons.length, 3);
  assert.ok(buttons.every((b: any) => b.reply.title.length <= 20));
});

test("Graph: descarga de media en dos pasos (URL temporal y bytes)", async () => {
  const { fn, calls } = fakeFetch([json(200, { url: "https://lookaside.test/m", mime_type: "audio/ogg" }), new Response(Buffer.from("OGG"), { status: 200 })]);
  const api = createGraphApi({ fetch: fn });
  const media = await api.downloadMedia(channel, "MEDIA1");
  assert.equal(media.mimeType, "audio/ogg");
  assert.equal(media.buffer.toString(), "OGG");
  assert.match(calls[0].url, /\/MEDIA1$/);
  assert.equal(calls[1].url, "https://lookaside.test/m");
});

test("Graph: un audio por encima de WHATSAPP_AUDIO_MAX_BYTES (3 MB) ni se baja; una foto de ese tamaño sí", async () => {
  const big = 4 * 1024 * 1024;
  const audio = fakeFetch([json(200, { url: "https://lookaside.test/a", mime_type: "audio/ogg", file_size: big })]);
  await assert.rejects(createGraphApi({ fetch: audio.fn }).downloadMedia(channel, "AUD"), (e: unknown) => {
    assert.ok(e instanceof MediaTooLargeError && e instanceof GraphError);
    assert.equal(e.transient, false);
    assert.equal(e.maxBytes, 3 * 1024 * 1024);
    return true;
  });
  assert.equal(audio.calls.length, 1, "solo la consulta de metadatos: los bytes no se piden");

  const photo = fakeFetch([json(200, { url: "https://lookaside.test/p", mime_type: "image/jpeg", file_size: big }), new Response(Buffer.alloc(big), { status: 200 })]);
  const media = await createGraphApi({ fetch: photo.fn }).downloadMedia(channel, "IMG");
  assert.equal(media.buffer.length, big);

  // Sin file_size declarado: se chequea sobre los bytes bajados.
  const undeclared = fakeFetch([json(200, { url: "https://lookaside.test/a", mime_type: "audio/mpeg" }), new Response(Buffer.alloc(big), { status: 200 })]);
  await assert.rejects(createGraphApi({ fetch: undeclared.fn }).downloadMedia(channel, "AUD"), (e: unknown) => e instanceof MediaTooLargeError);
});

test("audio: duración del contenedor Ogg (opus) sin decodificar; null si no se puede leer", () => {
  assert.equal(audioDurationSec(oggOpusAudio(150), "audio/ogg; codecs=opus"), 150);
  assert.equal(audioDurationSec(oggOpusAudio(12.5), "audio/ogg"), 12.5);
  assert.equal(audioDurationSec(oggOpusAudio(30), ""), 30, "sin tipo declarado igual se reconoce por la firma");
  assert.equal(audioDurationSec(oggOpusAudio(30), "audio/mpeg"), null, "otro tipo: no se intenta");
  assert.equal(audioDurationSec(Buffer.from("no es un ogg"), "audio/ogg"), null);
  assert.equal(audioDurationSec(oggOpusAudio(30).subarray(0, 40), "audio/ogg"), null, "truncado: sin página con duración");
});

test("audio: tope de duración por env (default 2 min) y transcripción cortada a 4096", () => {
  const saved = process.env.AGENT_AUDIO_MAX_SEC;
  try {
    delete process.env.AGENT_AUDIO_MAX_SEC;
    assert.equal(audioMaxSec(), 120);
    process.env.AGENT_AUDIO_MAX_SEC = "300";
    assert.equal(audioMaxSec(), 300);
    process.env.AGENT_AUDIO_MAX_SEC = "5";
    assert.equal(audioMaxSec(), 120, "fuera de rango → default");
  } finally {
    if (saved === undefined) delete process.env.AGENT_AUDIO_MAX_SEC;
    else process.env.AGENT_AUDIO_MAX_SEC = saved;
  }
  assert.equal(clipTranscript("  hola  "), "hola");
  const long = clipTranscript("😀".repeat(5000));
  assert.equal(Array.from(long).length, MAX_TRANSCRIPT_CHARS);
  assert.ok(long.endsWith("…"));
});

test("Graph: corte de red = transitorio", async () => {
  const { fn } = fakeFetch([new TypeError("fetch failed"), new TypeError("fetch failed"), new TypeError("fetch failed")]);
  const api = createGraphApi({ fetch: fn, retryDelayMs: () => 0 });
  await assert.rejects(api.sendText(channel, "1", "x"), (e: unknown) => e instanceof GraphError && e.transient);
});
