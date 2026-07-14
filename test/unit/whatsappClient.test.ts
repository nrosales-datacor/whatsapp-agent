import assert from "node:assert/strict";
import crypto from "node:crypto";
import { test } from "node:test";
import {
  botonesPostServicio,
  botonesRecordatorio,
  esConfirmacionCita,
  firmaValida,
  opcionHorario,
  parsearEntrante,
  respuestaPostServicio,
  verificarWebhook,
} from "../../src/whatsapp/client";

// ─── Verificación del webhook (GET) ────────────────────────────────────────

test("verificarWebhook: ok cuando mode y token coinciden", () => {
  process.env.WHATSAPP_VERIFY_TOKEN = "token-secreto";
  const params = new URLSearchParams({ "hub.mode": "subscribe", "hub.verify_token": "token-secreto", "hub.challenge": "abc123" });
  assert.deepEqual(verificarWebhook(params), { ok: true, challenge: "abc123" });
});

test("verificarWebhook: rechaza token incorrecto", () => {
  process.env.WHATSAPP_VERIFY_TOKEN = "token-secreto";
  const params = new URLSearchParams({ "hub.mode": "subscribe", "hub.verify_token": "otro", "hub.challenge": "abc123" });
  assert.deepEqual(verificarWebhook(params), { ok: false });
});

// ─── Firma del webhook (POST) ──────────────────────────────────────────────

test("firmaValida: acepta una firma HMAC-SHA256 correcta", () => {
  process.env.WHATSAPP_APP_SECRET = "app-secret";
  const rawBody = '{"hola":"mundo"}';
  const firma = "sha256=" + crypto.createHmac("sha256", "app-secret").update(rawBody).digest("hex");
  assert.equal(firmaValida(rawBody, firma), true);
});

test("firmaValida: rechaza firma incorrecta o ausente", () => {
  process.env.WHATSAPP_APP_SECRET = "app-secret";
  assert.equal(firmaValida("{}", "sha256=deadbeef"), false);
  assert.equal(firmaValida("{}", null), false);
});

// ─── Parseo del mensaje entrante ────────────────────────────────────────────

function payloadTexto(texto: string, extra: Record<string, unknown> = {}) {
  return {
    entry: [
      {
        changes: [
          {
            value: {
              metadata: { phone_number_id: "1234567890" },
              messages: [{ id: "wamid.1", from: "+506 8888-7777", type: "text", text: { body: texto }, ...extra }],
            },
          },
        ],
      },
    ],
  };
}

test("parsearEntrante: decodifica un mensaje de texto y sanea el número del cliente", () => {
  const r = parsearEntrante(payloadTexto("Hola, quiero una cita"));
  assert.equal(r?.esTexto, true);
  assert.equal(r?.texto, "Hola, quiero una cita");
  assert.equal(r?.clienteWa, "50688887777"); // solo dígitos
  assert.equal(r?.phoneNumberId, "1234567890");
  assert.equal(r?.messageId, "wamid.1");
});

test("parsearEntrante: mensaje de audio expone audioId sin texto", () => {
  const body = payloadTexto("", {});
  body.entry[0].changes[0].value.messages[0] = { id: "w2", from: "50688887777", type: "audio", audio: { id: "media-1" } } as any;
  const r = parsearEntrante(body);
  assert.equal(r?.esTexto, false);
  assert.equal(r?.audioId, "media-1");
});

test("parsearEntrante: mensaje de imagen expone imagenId y caption", () => {
  const body = payloadTexto("");
  body.entry[0].changes[0].value.messages[0] = {
    id: "w3",
    from: "50688887777",
    type: "image",
    image: { id: "media-2", caption: "¿cuánto cuesta esto?" },
  } as any;
  const r = parsearEntrante(body);
  assert.equal(r?.imagenId, "media-2");
  assert.equal(r?.imagenCaption, "¿cuánto cuesta esto?");
});

test("parsearEntrante: botón interactivo se decodifica a frase legible y trae interactiveId", () => {
  const body = payloadTexto("");
  body.entry[0].changes[0].value.messages[0] = {
    id: "w4",
    from: "50688887777",
    type: "interactive",
    interactive: { button_reply: { id: "confirmar|cita-1", title: "Confirmo ✅" } },
  } as any;
  const r = parsearEntrante(body);
  assert.equal(r?.interactiveId, "confirmar|cita-1");
  assert.equal(r?.esTexto, true);
  assert.match(r!.texto, /Confirmo mi cita/);
});

test("parsearEntrante: status (sin messages) devuelve null, no revienta", () => {
  const body = { entry: [{ changes: [{ value: { metadata: { phone_number_id: "1" }, statuses: [{ id: "s1" }] } }] }] };
  assert.equal(parsearEntrante(body), null);
});

test("parsearEntrante: payload corrupto devuelve null en vez de lanzar", () => {
  assert.equal(parsearEntrante(null), null);
  assert.equal(parsearEntrante({}), null);
  assert.equal(parsearEntrante({ entry: "no es un arreglo" }), null);
});

// ─── Protocolo de botones/listas (round-trip) ──────────────────────────────

test("opcionHorario: codifica fecha/hora en el id y formatea el título amigable", () => {
  const o = opcionHorario("2026-07-20", "14:00");
  assert.equal(o.id, "slot|2026-07-20|14:00");
  assert.equal(o.titulo, "2:00 p.m.");
});

test("opcionHorario: formatea correctamente medianoche y mediodía", () => {
  assert.equal(opcionHorario("2026-07-20", "00:00").titulo, "12:00 a.m.");
  assert.equal(opcionHorario("2026-07-20", "12:00").titulo, "12:00 p.m.");
});

test("botonesRecordatorio + esConfirmacionCita: round-trip de confirmación", () => {
  const [confirmar, mover] = botonesRecordatorio("cita-42");
  assert.equal(esConfirmacionCita(confirmar.id), "cita-42");
  assert.equal(esConfirmacionCita(mover.id), null); // "mover" no es confirmación
  assert.equal(esConfirmacionCita(undefined), null);
});

test("botonesPostServicio + respuestaPostServicio: round-trip de satisfacción", () => {
  const [bien, mal] = botonesPostServicio("cita-7");
  assert.deepEqual(respuestaPostServicio(bien.id), { citaId: "cita-7", bien: true });
  assert.deepEqual(respuestaPostServicio(mal.id), { citaId: "cita-7", bien: false });
  assert.equal(respuestaPostServicio("otro|cita-7"), null);
  assert.equal(respuestaPostServicio(undefined), null);
});
