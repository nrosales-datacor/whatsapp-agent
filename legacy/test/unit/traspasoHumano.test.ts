import assert from "node:assert/strict";
import { test } from "node:test";
import { pideHumano, modoHumanoVencido } from "../../src/whatsapp/traspasoHumano";
import type { MensajeConversacion } from "../../src/types";

// Revisión pre-venta 2026-10: la palabra suelta "persona" ya no calla al bot, y el
// modo humano vence si el equipo no actúa en N horas.

test("pideHumano: dispara con pedidos explícitos", () => {
  for (const t of [
    "agente",
    "Agente!",
    "humano por favor",
    "hola, una persona",
    "quiero hablar con un agente por favor",
    "Quiero hablar con una persona",
    "¿me pasás con un asesor?",
    "pásame con alguien",
    "que me atienda una persona",
    "necesito un humano",
    "quiero comunicarme con el encargado",
    "can I talk to a human?",
  ]) {
    assert.equal(pideHumano(t), true, t);
  }
});

test("pideHumano: NO dispara con la palabra suelta en otro contexto", () => {
  for (const t of [
    "¿cuánto cuesta por persona?",
    "es para otra persona",
    "pasame el precio por persona",
    "somos 3 personas",
    "el agente de seguros me recomendó",
    "¿puede atender a otra persona después de mí?",
    "hola, quiero una cita",
    "",
  ]) {
    assert.equal(pideHumano(t), false, t);
  }
});

const H = 3_600_000;
const ahora = new Date("2026-10-01T20:00:00Z");
const hace = (horas: number) => new Date(ahora.getTime() - horas * H).toISOString();
const msg = (horas: number, porHumano: boolean, rol: "user" | "assistant" = "assistant"): MensajeConversacion => ({
  rol,
  contenido: "x",
  creadoEn: hace(horas),
  porHumano,
});

test("modoHumanoVencido: vence si el traspaso fue hace más de N horas y nadie del equipo escribió", () => {
  assert.equal(modoHumanoVencido({ modo: "humano", humanoDesde: hace(13) }, [], ahora, 12), true);
});

test("modoHumanoVencido: un mensaje del operador reinicia el reloj", () => {
  assert.equal(modoHumanoVencido({ modo: "humano", humanoDesde: hace(30) }, [msg(2, true)], ahora, 12), false);
});

test("modoHumanoVencido: los mensajes del cliente NO reinician el reloj", () => {
  const historial = [msg(1, false, "user"), msg(5, false, "user")];
  assert.equal(modoHumanoVencido({ modo: "humano", humanoDesde: hace(13) }, historial, ahora, 12), true);
});

test("modoHumanoVencido: recién traspasado, en bot, sin referencias o con 0 horas → no vence", () => {
  assert.equal(modoHumanoVencido({ modo: "humano", humanoDesde: hace(1) }, [], ahora, 12), false);
  assert.equal(modoHumanoVencido({ modo: "bot", humanoDesde: null }, [], ahora, 12), false);
  assert.equal(modoHumanoVencido({ modo: "humano" }, [], ahora, 12), false);
  assert.equal(modoHumanoVencido({ modo: "humano", humanoDesde: hace(100) }, [], ahora, 0), false);
});
