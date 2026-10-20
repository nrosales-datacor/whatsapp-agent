import { test } from "node:test";
import assert from "node:assert/strict";
import { APIConnectionError, APIConnectionTimeoutError, APIError } from "openai";
import { isTransientError } from "../../src/platform/net/transient";

// Qué errores justifican que la cola reintente un job (vs. darlo por fallido ya).

const openAiError = (status: number, code?: string) =>
  APIError.generate(status, { error: { message: "x", code } }, "x", new Headers());

/** Error con la marca `transient`, como el de Graph del módulo WhatsApp. */
class MarkedError extends Error {
  constructor(
    message: string,
    readonly transient: boolean,
  ) {
    super(message);
  }
}

test("OpenAI: 408/409/429/5xx y caídas de conexión son transitorios", () => {
  for (const s of [408, 409, 429, 500, 502, 503]) assert.equal(isTransientError(openAiError(s)), true, `status ${s}`);
  assert.equal(isTransientError(new APIConnectionError({ message: "ECONNRESET" })), true);
  assert.equal(isTransientError(new APIConnectionTimeoutError()), true);
});

test("OpenAI: 400/401/404 y el 429 por cuota agotada NO son transitorios", () => {
  for (const s of [400, 401, 404]) assert.equal(isTransientError(openAiError(s)), false, `status ${s}`);
  assert.equal(isTransientError(openAiError(429, "insufficient_quota")), false);
});

test("se respeta la marca `transient` de cualquier error, también envuelto en otra capa", () => {
  assert.equal(isTransientError(new MarkedError("Error enviando WhatsApp (503): x", true)), true);
  assert.equal(isTransientError(new MarkedError("Error enviando WhatsApp (401): x", false)), false);
  const wrapped = new Error("capa de arriba", { cause: new MarkedError("red", true) });
  assert.equal(isTransientError(wrapped), true);
});

test("un error cualquiera (bug, base de datos) no se reintenta", () => {
  assert.equal(isTransientError(new Error("boom")), false);
  assert.equal(isTransientError(new TypeError("x is undefined")), false);
  assert.equal(isTransientError(undefined), false);
});
