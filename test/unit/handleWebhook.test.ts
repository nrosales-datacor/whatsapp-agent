import "../helpers/setupEnv"; // PRIMERO: fija OPENAI_API_KEY antes de importar handleWebhook
import { test } from "node:test";
import assert from "node:assert/strict";
import { esConversacionIniciada } from "../../src/handleWebhook";
import type { MensajeConversacion } from "../../src/types";

// ─────────────────────────────────────────────────────────────────────────────
// "Conversación iniciada" (Carril D, 0.2): aproxima el modelo de cobro de Meta
// (una conversación = una ventana de 24 h) para los contadores de uso mensual.
// ─────────────────────────────────────────────────────────────────────────────

const msg = (haceMs: number): MensajeConversacion => ({
  rol: "user",
  contenido: "hola",
  creadoEn: new Date(Date.now() - haceMs).toISOString(),
});

test("sin mensajes previos (primer contacto de la conversación) → conversación iniciada", () => {
  assert.equal(esConversacionIniciada([]), true);
});

test("último mensaje hace menos de 24h → NO es una conversación nueva", () => {
  assert.equal(esConversacionIniciada([msg(60_000)]), false); // hace 1 min
  assert.equal(esConversacionIniciada([msg(23 * 60 * 60 * 1000)]), false); // hace 23h
});

test("último mensaje hace más de 24h → conversación iniciada de nuevo", () => {
  assert.equal(esConversacionIniciada([msg(25 * 60 * 60 * 1000)]), true); // hace 25h
});

test("mira solo el ÚLTIMO mensaje del historial, no el primero", () => {
  const historial = [msg(48 * 60 * 60 * 1000), msg(60_000)]; // viejo, luego reciente
  assert.equal(esConversacionIniciada(historial), false);
});
