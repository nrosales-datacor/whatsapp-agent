import { test } from "node:test";
import assert from "node:assert/strict";
import { APIConnectionError, APIConnectionTimeoutError, APIError } from "openai";
import { esErrorTransitorio } from "../../src/red/transitorio";
import { ErrorGraph } from "../../src/whatsapp/client";

// E7: qué errores justifican que la cola reintente el turno (vs. disculparse ya).

const errorOpenAI = (status: number, code?: string) =>
  APIError.generate(status, { error: { message: "x", code } }, "x", new Headers());

test("OpenAI: 408/409/429/5xx y caídas de conexión son transitorios", () => {
  for (const s of [408, 409, 429, 500, 502, 503]) assert.equal(esErrorTransitorio(errorOpenAI(s)), true, `status ${s}`);
  assert.equal(esErrorTransitorio(new APIConnectionError({ message: "ECONNRESET" })), true);
  assert.equal(esErrorTransitorio(new APIConnectionTimeoutError()), true);
});

test("OpenAI: 400/401/404 y el 429 por cuota agotada NO son transitorios", () => {
  for (const s of [400, 401, 404]) assert.equal(esErrorTransitorio(errorOpenAI(s)), false, `status ${s}`);
  assert.equal(esErrorTransitorio(errorOpenAI(429, "insufficient_quota")), false);
});

test("Graph: se respeta la marca `transitorio` de ErrorGraph, también envuelto en otra capa", () => {
  assert.equal(esErrorTransitorio(new ErrorGraph("Error enviando WhatsApp (503): x", 503, true)), true);
  assert.equal(esErrorTransitorio(new ErrorGraph("Error enviando WhatsApp (401): x", 401, false)), false);
  const envuelto = new Error("capa de arriba", { cause: new ErrorGraph("red", undefined, true) });
  assert.equal(esErrorTransitorio(envuelto), true);
});

test("un error cualquiera (bug, base de datos) no se reintenta", () => {
  assert.equal(esErrorTransitorio(new Error("boom")), false);
  assert.equal(esErrorTransitorio(new TypeError("x is undefined")), false);
  assert.equal(esErrorTransitorio(undefined), false);
});
