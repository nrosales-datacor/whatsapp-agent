import assert from "node:assert/strict";
import crypto from "node:crypto";
import { test } from "node:test";
import {
  botonesPostServicio,
  botonesPostServicioPro,
  botonesRecordatorio,
  clasificarEntrante,
  esConfirmacionCita,
  firmaValida,
  opcionHorario,
  parsearEntrante,
  respuestaPostServicio,
  puedeEnviarWhatsapp,
  dependeDelTokenGlobal,
  tokenDeTenant,
  verificarWebhook,
  separarPayloadWebhook,
} from "../../src/whatsapp/client";
import { crearTenant } from "../helpers/fixtures";

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

// ─── Quick-reply de PLANTILLA aprobada (BLOQ-01/E9): Meta manda `type: "button"`
// con la carga en `msg.button.payload` (no `msg.interactive.button_reply`). Mismos
// casos que arriba pero por esta vía distinta, para asegurar que `parsearEntrante`
// la decodifica igual de bien ────────────────────────────────────────────────

test("parsearEntrante: quick-reply de plantilla (type: button) de confirmación de cita se decodifica igual que el interactivo nativo", () => {
  const body = payloadTexto("");
  body.entry[0].changes[0].value.messages[0] = {
    id: "w5",
    from: "50688887777",
    type: "button",
    button: { payload: "confirmar|cita-1", text: "Confirmo ✅" },
  } as any;
  const r = parsearEntrante(body);
  assert.equal(r?.interactiveId, "confirmar|cita-1");
  assert.equal(r?.esTexto, true);
  assert.match(r!.texto, /Confirmo mi cita/);
});

test("parsearEntrante: quick-reply de plantilla (type: button) de seguimiento post-servicio se decodifica igual que el interactivo nativo", () => {
  const body = payloadTexto("");
  body.entry[0].changes[0].value.messages[0] = {
    id: "w6",
    from: "50688887777",
    type: "button",
    button: { payload: "postbien|cita-2", text: "Todo bien 👍" },
  } as any;
  const r = parsearEntrante(body);
  assert.equal(r?.interactiveId, "postbien|cita-2");
  assert.equal(r?.esTexto, true);
  assert.match(r!.texto, /Todo bien con el servicio/);
});

test("parsearEntrante: quick-reply de plantilla con payload que no matchea ninguna convención cae al texto visible del botón", () => {
  const body = payloadTexto("");
  body.entry[0].changes[0].value.messages[0] = {
    id: "w7",
    from: "50688887777",
    type: "button",
    // Payload que el dueño configuró distinto en el WhatsApp Manager (no sigue
    // la convención `tipo|arg` que definimos nosotros para nuestros botones):
    // el código no puede inventar qué quiso decir, así que cae al texto visible.
    button: { payload: "otro-payload-cualquiera", text: "Sí, confirmo mi cita" },
  } as any;
  const r = parsearEntrante(body);
  assert.equal(r?.interactiveId, "otro-payload-cualquiera");
  assert.equal(r?.esTexto, true);
  assert.equal(r?.texto, "Sí, confirmo mi cita");
});

test("parsearEntrante: status (sin messages) devuelve null, no revienta", () => {
  const body = { entry: [{ changes: [{ value: { metadata: { phone_number_id: "1" }, statuses: [{ id: "s1" }] } }] }] };
  assert.equal(parsearEntrante(body), null);
});

// ─── E12: ubicación / documento / contacto / reacción ──────────────────────

test("parsearEntrante: una reacción (👍) se ignora por completo (devuelve null)", () => {
  const body = payloadTexto("");
  body.entry[0].changes[0].value.messages[0] = {
    id: "w5",
    from: "50688887777",
    type: "reaction",
    reaction: { message_id: "wamid.out.1", emoji: "👍" },
  } as any;
  assert.equal(parsearEntrante(body), null);
});

test("parsearEntrante: ubicación entra como TEXTO sintético con las coordenadas", () => {
  const body = payloadTexto("");
  body.entry[0].changes[0].value.messages[0] = {
    id: "w6",
    from: "50688887777",
    type: "location",
    location: { latitude: 9.9333, longitude: -84.0833, name: "Lavacar Rosales", address: "San José" },
  } as any;
  const r = parsearEntrante(body);
  assert.equal(r?.esTexto, true);
  assert.match(r!.texto, /lat: 9\.9333/);
  assert.match(r!.texto, /lon: -84\.0833/);
  assert.match(r!.texto, /Lavacar Rosales/);
  assert.match(r!.texto, /San José/);
});

test("parsearEntrante: ubicación sin nombre/dirección igual entra como texto (solo coordenadas)", () => {
  const body = payloadTexto("");
  body.entry[0].changes[0].value.messages[0] = {
    id: "w7",
    from: "50688887777",
    type: "location",
    location: { latitude: 9.9, longitude: -84.1 },
  } as any;
  const r = parsearEntrante(body);
  assert.equal(r?.esTexto, true);
  assert.match(r!.texto, /lat: 9\.9, lon: -84\.1/);
});

test("parsearEntrante: documento expone documentoId y documentoNombre, sin ser texto", () => {
  const body = payloadTexto("");
  body.entry[0].changes[0].value.messages[0] = {
    id: "w8",
    from: "50688887777",
    type: "document",
    document: { id: "doc-1", filename: "cedula.pdf", mime_type: "application/pdf" },
  } as any;
  const r = parsearEntrante(body);
  assert.equal(r?.esTexto, false);
  assert.equal(r?.documentoId, "doc-1");
  assert.equal(r?.documentoNombre, "cedula.pdf");
});

test("parsearEntrante: contacto compartido expone contactoNombre (un solo contacto)", () => {
  const body = payloadTexto("");
  body.entry[0].changes[0].value.messages[0] = {
    id: "w9",
    from: "50688887777",
    type: "contacts",
    contacts: [{ name: { formatted_name: "María Pérez" }, phones: [{ phone: "50688881111" }] }],
  } as any;
  const r = parsearEntrante(body);
  assert.equal(r?.esTexto, false);
  assert.equal(r?.contactoNombre, "María Pérez");
});

test("parsearEntrante: varios contactos compartidos indican cuántos más ('+N más')", () => {
  const body = payloadTexto("");
  body.entry[0].changes[0].value.messages[0] = {
    id: "w10",
    from: "50688887777",
    type: "contacts",
    contacts: [
      { name: { formatted_name: "María Pérez" }, phones: [] },
      { name: { formatted_name: "Juan Gómez" }, phones: [] },
    ],
  } as any;
  const r = parsearEntrante(body);
  assert.equal(r?.contactoNombre, "María Pérez (+1 más)");
});

test("parsearEntrante: video/sticker no traen ningún campo propio (caen al genérico)", () => {
  const body = payloadTexto("");
  body.entry[0].changes[0].value.messages[0] = {
    id: "w11",
    from: "50688887777",
    type: "video",
    video: { id: "vid-1" },
  } as any;
  const r = parsearEntrante(body);
  assert.equal(r?.esTexto, false);
  assert.equal(r?.texto, "");
  assert.equal(r?.audioId, undefined);
  assert.equal(r?.imagenId, undefined);
  assert.equal(r?.documentoId, undefined);
  assert.equal(r?.contactoNombre, undefined);
});

test("parsearEntrante: payload corrupto devuelve null en vez de lanzar", () => {
  assert.equal(parsearEntrante(null), null);
  assert.equal(parsearEntrante({}), null);
  assert.equal(parsearEntrante({ entry: "no es un arreglo" }), null);
});

// ─── clasificarEntrante (ROADMAP F3): distingue "ignorable" (status, alto volumen,
// no se guarda) de "no-parseable" (forma rara, SÍ se guarda para diagnóstico) ────

test("clasificarEntrante: un mensaje de texto válido clasifica 'ok'", () => {
  const r = clasificarEntrante(payloadTexto("hola"));
  assert.equal(r.tipo, "ok");
  if (r.tipo === "ok") assert.equal(r.mensaje.texto, "hola");
});

test("clasificarEntrante: un status (sin messages) clasifica 'ignorable', no 'no-parseable'", () => {
  const body = { entry: [{ changes: [{ value: { metadata: { phone_number_id: "1" }, statuses: [{ id: "s1" }] } }] }] };
  assert.deepEqual(clasificarEntrante(body), { tipo: "ignorable" });
});

test("clasificarEntrante: payloads sin la forma de un webhook de WhatsApp clasifican 'no-parseable'", () => {
  assert.deepEqual(clasificarEntrante(null), { tipo: "no-parseable" });
  assert.deepEqual(clasificarEntrante({}), { tipo: "no-parseable" });
  assert.deepEqual(clasificarEntrante({ entry: "no es un arreglo" }), { tipo: "no-parseable" });
});

test("clasificarEntrante: un mensaje sin phone_number_id ni remitente clasifica 'no-parseable' (no es un status)", () => {
  const body = { entry: [{ changes: [{ value: { messages: [{ id: "w1", type: "text", text: { body: "hola" } }] } }] }] };
  assert.deepEqual(clasificarEntrante(body), { tipo: "no-parseable" });
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

test("botonesPostServicio (Básico, 2 botones) + respuestaPostServicio: round-trip de satisfacción", () => {
  const [bien, mal] = botonesPostServicio("cita-7");
  assert.deepEqual(respuestaPostServicio(bien.id), { citaId: "cita-7", sentimiento: "positivo" });
  assert.deepEqual(respuestaPostServicio(mal.id), { citaId: "cita-7", sentimiento: "negativo" });
  assert.equal(respuestaPostServicio("otro|cita-7"), null);
  assert.equal(respuestaPostServicio(undefined), null);
});

// Carril D, 1.3: plan Pro manda 3 botones en vez de 2.
test("botonesPostServicioPro (Pro, 3 botones) + respuestaPostServicio: round-trip de los 3 sentimientos", () => {
  const [excelente, bien, mal] = botonesPostServicioPro("cita-8");
  assert.deepEqual(respuestaPostServicio(excelente.id), { citaId: "cita-8", sentimiento: "positivo" });
  assert.deepEqual(respuestaPostServicio(bien.id), { citaId: "cita-8", sentimiento: "neutral" });
  assert.deepEqual(respuestaPostServicio(mal.id), { citaId: "cita-8", sentimiento: "negativo" });
});

// ─── Access token de WhatsApp por tenant (auditoría ALTO-05) ────────────────
//
// El bug original: `tenant.accessToken ?? process.env.WHATSAPP_ACCESS_TOKEN` mandaba
// los mensajes de CUALQUIER tenant sin token propio con el token global, es decir
// desde el número de prueba de Meta de otro negocio. Estos tests fijan la regla,
// espejo de calendario.test.ts: el token sale del tenant, la env global solo cubre
// al tenant nombrado explícitamente, y cualquier otro sin token propio falla.

/** Ejecuta `fn` con estas env y restaura las anteriores al terminar. */
function conEnv(vars: Record<string, string | undefined>, fn: () => void): void {
  const previas = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  try {
    for (const [k, v] of Object.entries(vars)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fn();
  } finally {
    for (const [k, v] of Object.entries(previas)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test("tokenDeTenant: usa el token propio del negocio cuando existe", () => {
  const tenant = crearTenant({ id: "barberia", accessToken: "token-barberia" });
  conEnv({ WHATSAPP_ACCESS_TOKEN: undefined, WHATSAPP_ACCESS_TOKEN_TENANT_ID: undefined }, () => {
    assert.equal(tokenDeTenant(tenant), "token-barberia");
    assert.equal(puedeEnviarWhatsapp(tenant), true);
  });
});

test("tokenDeTenant: la env global solo aplica al tenant nombrado (compat. piloto)", () => {
  const piloto = crearTenant({ id: "lavacar", accessToken: undefined });
  conEnv(
    { WHATSAPP_ACCESS_TOKEN: "token-global-piloto", WHATSAPP_ACCESS_TOKEN_TENANT_ID: "lavacar" },
    () => {
      assert.equal(tokenDeTenant(piloto), "token-global-piloto");
      assert.equal(puedeEnviarWhatsapp(piloto), true);
    },
  );
});

test("tokenDeTenant: un tenant sin token propio NUNCA hereda el de otro (fail-closed)", () => {
  const otro = crearTenant({ id: "barberia", accessToken: undefined });
  // La env global existe, pero está nombrada para "lavacar", no para "barberia".
  conEnv(
    { WHATSAPP_ACCESS_TOKEN: "token-global-piloto", WHATSAPP_ACCESS_TOKEN_TENANT_ID: "lavacar" },
    () => {
      assert.throws(() => tokenDeTenant(otro), /Falta el access token de WhatsApp.*barberia/);
      assert.equal(puedeEnviarWhatsapp(otro), false);
    },
  );
});

test("tokenDeTenant: sin WHATSAPP_ACCESS_TOKEN_TENANT_ID la env no aplica a nadie", () => {
  const piloto = crearTenant({ id: "lavacar", accessToken: undefined });
  conEnv(
    { WHATSAPP_ACCESS_TOKEN: "token-global-piloto", WHATSAPP_ACCESS_TOKEN_TENANT_ID: undefined },
    () => {
      assert.throws(() => tokenDeTenant(piloto), /Falta el access token de WhatsApp/);
      assert.equal(puedeEnviarWhatsapp(piloto), false);
    },
  );
});

// `dependeDelTokenGlobal` responde una pregunta DISTINTA de `puedeEnviarWhatsapp`: el
// piloto cubierto por la env puede enviar (true) y a la vez NO tiene token propio
// (true acá). Mezclar ambas en un solo booleano haría que el panel informe "conectado
// con su token" cuando en realidad está colgado de una env compartida — el estado que
// ALTO-05 quería hacer visible, no esconder.
test("dependeDelTokenGlobal: distingue 'puede enviar' de 'tiene token propio'", () => {
  const piloto = crearTenant({ id: "lavacar", accessToken: undefined });
  const propio = crearTenant({ id: "barberia", accessToken: "token-barberia" });
  const huerfano = crearTenant({ id: "dental", accessToken: undefined });
  conEnv(
    { WHATSAPP_ACCESS_TOKEN: "token-global-piloto", WHATSAPP_ACCESS_TOKEN_TENANT_ID: "lavacar" },
    () => {
      // El piloto envía, pero colgado de la env: hay que poder verlo.
      assert.equal(puedeEnviarWhatsapp(piloto), true);
      assert.equal(dependeDelTokenGlobal(piloto), true);
      // Con token propio no depende de nada global.
      assert.equal(puedeEnviarWhatsapp(propio), true);
      assert.equal(dependeDelTokenGlobal(propio), false);
      // Sin token y sin ser el nombrado: no envía, y no "depende" de nada (no puede).
      assert.equal(puedeEnviarWhatsapp(huerfano), false);
      assert.equal(dependeDelTokenGlobal(huerfano), false);
    },
  );
});

test("tokenDeTenant: el token propio del tenant le gana a la env global", () => {
  const piloto = crearTenant({ id: "lavacar", accessToken: "token-nuevo-lavacar" });
  conEnv(
    { WHATSAPP_ACCESS_TOKEN: "token-viejo-global", WHATSAPP_ACCESS_TOKEN_TENANT_ID: "lavacar" },
    () => {
      assert.equal(tokenDeTenant(piloto), "token-nuevo-lavacar");
    },
  );
});

// ─── separarPayloadWebhook (revisión pre-venta 2026-10) ────────────────────
// Meta puede agrupar varios entry/changes/messages en UN POST; antes solo se leía
// el primero y el resto se perdía en silencio con un 200.

const msgTexto = (id: string, texto: string) => ({ from: "50688887777", id, type: "text", text: { body: texto } });

test("separarPayloadWebhook: varios messages en un change → un pedazo por mensaje, en orden", () => {
  const body = {
    object: "whatsapp_business_account",
    entry: [{ id: "waba1", changes: [{ field: "messages", value: { metadata: { phone_number_id: "P1" }, contacts: [{ wa_id: "50688887777" }], messages: [msgTexto("m1", "hola"), msgTexto("m2", "quiero cita")] } }] }],
  };
  const partes = separarPayloadWebhook(body);
  assert.equal(partes.length, 2);
  const c1 = clasificarEntrante(partes[0]);
  const c2 = clasificarEntrante(partes[1]);
  assert.ok(c1.tipo === "ok" && c2.tipo === "ok");
  assert.equal(c1.mensaje.messageId, "m1");
  assert.equal(c2.mensaje.messageId, "m2");
  assert.equal(c2.mensaje.texto, "quiero cita");
  assert.equal(c2.mensaje.phoneNumberId, "P1", "cada pedazo conserva su metadata");
});

test("separarPayloadWebhook: varios entry (dos WABA/tenants) → cada uno con su phone_number_id", () => {
  const body = {
    entry: [
      { changes: [{ value: { metadata: { phone_number_id: "P1" }, messages: [msgTexto("a", "x")] } }] },
      { changes: [{ value: { metadata: { phone_number_id: "P2" }, statuses: [{ id: "s" }] } }, { value: { metadata: { phone_number_id: "P2" }, messages: [msgTexto("b", "y")] } }] },
    ],
  };
  const partes = separarPayloadWebhook(body).map((p) => clasificarEntrante(p));
  assert.equal(partes.length, 3);
  assert.ok(partes[0].tipo === "ok" && partes[0].mensaje.phoneNumberId === "P1");
  assert.equal(partes[1].tipo, "ignorable", "el change de statuses sigue siendo ignorable");
  assert.ok(partes[2].tipo === "ok" && partes[2].mensaje.phoneNumberId === "P2" && partes[2].mensaje.messageId === "b");
});

test("separarPayloadWebhook: body sin entry[] se devuelve tal cual (camino no-parseable)", () => {
  const raro = { foo: 1 };
  assert.deepEqual(separarPayloadWebhook(raro), [raro]);
  assert.equal(clasificarEntrante(separarPayloadWebhook(raro)[0]).tipo, "no-parseable");
});
