import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import type { AgentHistoryMessage } from "../../src/modules/whatsapp/agentContract";
import { computeCostMicros, MODEL_PRICING, pricingFor } from "../../src/modules/whatsapp/agent/cost";
import { historyToMessages, MAX_HISTORY_MESSAGE_CHARS, trimHistory } from "../../src/modules/whatsapp/agent/history";

// ─────────────────────────────────────────────────────────────────────────────
// Historial acotado (cantidad y antigüedad, con fechas) y costo en micro-dólares.
// ─────────────────────────────────────────────────────────────────────────────

const TZ = "America/Costa_Rica";
const NOW = new Date("2026-10-21T18:00:00Z"); // miércoles 12:00 en Costa Rica
const at = (iso: string) => new Date(iso);

function msg(role: "user" | "assistant", text: string, iso: string, byHuman = false): AgentHistoryMessage {
  return { role, text, at: at(iso), ...(byHuman ? { byHuman } : {}) };
}

test("trimHistory: deja los últimos N mensajes y conserva siempre los nuevos del cliente", () => {
  const history = Array.from({ length: 30 }, (_, i) => msg(i % 2 ? "assistant" : "user", `m${i}`, "2026-10-21T17:00:00Z"));
  history.push(msg("user", "nuevo 1", "2026-10-21T17:59:00Z"), msg("user", "nuevo 2", "2026-10-21T17:59:30Z"));
  const trimmed = trimHistory(history, { maxMessages: 6, maxDays: 30, now: NOW });
  assert.deepEqual(
    trimmed.map((m) => m.text),
    ["m26", "m27", "m28", "m29", "nuevo 1", "nuevo 2"],
  );
});

test("trimHistory: la ventana de días saca lo viejo (0 = sin ventana), pero no el mensaje nuevo", () => {
  const history = [
    msg("user", "hace 2 meses", "2026-08-20T15:00:00Z"),
    msg("assistant", "respuesta vieja", "2026-08-20T15:01:00Z"),
    msg("user", "la semana pasada", "2026-10-14T15:00:00Z"),
    msg("assistant", "ok", "2026-10-14T15:01:00Z"),
    msg("user", "hoy", "2026-10-21T17:00:00Z"),
  ];
  assert.deepEqual(
    trimHistory(history, { maxMessages: 20, maxDays: 30, now: NOW }).map((m) => m.text),
    ["la semana pasada", "ok", "hoy"],
  );
  assert.equal(trimHistory(history, { maxMessages: 20, maxDays: 0, now: NOW }).length, 5);
  const onlyOld = [msg("user", "vuelvo tras meses", "2026-01-01T15:00:00Z")];
  assert.equal(trimHistory(onlyOld, { maxMessages: 20, maxDays: 30, now: NOW }).length, 1, "lo que hay que contestar no se pierde");
});

test("historyToMessages: todo de hoy → sin separadores", () => {
  const out = historyToMessages([msg("user", "hola", "2026-10-21T16:00:00Z"), msg("assistant", "¡Hola!", "2026-10-21T16:00:05Z")], TZ, NOW);
  assert.deepEqual(
    out.map((m) => [m.role, m.content]),
    [
      ["user", "hola"],
      ["assistant", "¡Hola!"],
    ],
  );
});

test("historyToMessages: días anteriores con separador de fecha relativa, vuelta a hoy y nota de mensaje humano", () => {
  const out = historyToMessages(
    [
      msg("user", "quiero cita mañana", "2026-10-14T16:00:00Z"),
      msg("assistant", "Te escribe Laura del equipo", "2026-10-20T16:00:00Z", true),
      msg("user", "hola de nuevo", "2026-10-21T16:00:00Z"),
    ],
    TZ,
    NOW,
  );
  const contents = out.map((m) => String(m.content));
  assert.match(contents[0], /Mensajes del miércoles 14 de octubre \(hace 7 días\)/);
  assert.match(contents[0], /"mañana".*ESA fecha/);
  assert.match(contents[2], /\(ayer\)/);
  assert.match(contents[3], /persona del equipo/);
  assert.equal(contents[4], "Te escribe Laura del equipo");
  assert.equal(contents[5], "[Mensajes de hoy]");
  assert.equal(contents[6], "hola de nuevo");
});

test("historyToMessages: el día se calcula en la zona del negocio y los mensajes largos se cortan", () => {
  // 05:30 UTC del 21 = 23:30 del 20 en Costa Rica → es "ayer".
  const out = historyToMessages([msg("user", "x".repeat(MAX_HISTORY_MESSAGE_CHARS + 50), "2026-10-21T05:30:00Z")], TZ, NOW);
  assert.match(String(out[0].content), /\(ayer\)/);
  assert.equal(Array.from(String(out[1].content)).length, MAX_HISTORY_MESSAGE_CHARS + 1);
});

const ENV_KEYS = ["OPENAI_MODEL", "OPENAI_PRICE_INPUT_USD_PER_1M", "OPENAI_PRICE_CACHED_INPUT_USD_PER_1M", "OPENAI_PRICE_OUTPUT_USD_PER_1M"];
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

test("computeCostMicros: entrada, entrada cacheada y salida con la tarifa del modelo, redondeo único", () => {
  delete process.env.OPENAI_MODEL;
  // gpt-4o-mini: 0,15 / 0,075 / 0,60 USD por 1M → 1M de entrada = 150 000 micro-dólares.
  assert.equal(computeCostMicros("gpt-4o-mini", { inputTokens: 1_000_000, cachedInputTokens: 0, outputTokens: 0 }), 150_000);
  assert.equal(computeCostMicros("gpt-4o-mini", { inputTokens: 1_000_000, cachedInputTokens: 1_000_000, outputTokens: 0 }), 75_000);
  assert.equal(computeCostMicros("gpt-4o-mini", { inputTokens: 2000, cachedInputTokens: 1000, outputTokens: 500 }), 525);
  assert.equal(computeCostMicros("gpt-4o-mini", { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 }), 0);
  assert.equal(computeCostMicros("gpt-4o-mini", { inputTokens: 10, cachedInputTokens: 999, outputTokens: 0 }), Math.round(10 * 0.075), "los cacheados no superan la entrada");
  assert.equal(computeCostMicros("gpt-4.1", { inputTokens: 1_000_000, cachedInputTokens: 0, outputTokens: 1_000_000 }), 10_000_000);
});

test("pricingFor: id con fecha usa su modelo base; desconocido cae a gpt-4o-mini; env pisa al modelo configurado", () => {
  delete process.env.OPENAI_MODEL;
  assert.deepEqual(pricingFor("gpt-4o-2024-08-06"), MODEL_PRICING["gpt-4o"]);
  assert.deepEqual(pricingFor("modelo-inventado"), MODEL_PRICING["gpt-4o-mini"]);
  process.env.OPENAI_MODEL = "gpt-4.1-mini";
  process.env.OPENAI_PRICE_INPUT_USD_PER_1M = "1";
  process.env.OPENAI_PRICE_OUTPUT_USD_PER_1M = "no-numero";
  const rates = pricingFor("gpt-4.1-mini");
  assert.equal(rates.inputPer1M, 1_000_000);
  assert.equal(rates.outputPer1M, MODEL_PRICING["gpt-4.1-mini"].outputPer1M, "un precio inválido no pisa la tabla");
  assert.deepEqual(pricingFor("gpt-4o"), MODEL_PRICING["gpt-4o"], "el override es solo del modelo configurado");
});
