import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { publicBaseUrl, publicUrl } from "../../src/platform/http/publicUrl";

// ─────────────────────────────────────────────────────────────────────────────
// Base de los links de los correos (src/platform/http/publicUrl.ts): sale de
// PUBLIC_BASE_URL (nunca del Host del request); en desarrollo cae a localhost y en
// producción, sin la env, falla en vez de mandar un link roto.
// ─────────────────────────────────────────────────────────────────────────────

const saved = { PUBLIC_BASE_URL: process.env.PUBLIC_BASE_URL, NODE_ENV: process.env.NODE_ENV, PORT: process.env.PORT };

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

test("publicUrl: usa PUBLIC_BASE_URL sin barra final y arma la query escapada", () => {
  process.env.PUBLIC_BASE_URL = "https://app.example.test/";
  assert.equal(publicBaseUrl(), "https://app.example.test");
  assert.equal(publicUrl("/panel/reset-password", { token: "a+b/c" }), "https://app.example.test/panel/reset-password?token=a%2Bb%2Fc");
  process.env.PUBLIC_BASE_URL = "https://example.test/crm/";
  assert.equal(publicUrl("panel/x"), "https://example.test/crm/panel/x", "respeta un subdirectorio");
});

test("publicUrl: sin la env, en desarrollo, http://localhost:<PORT>", () => {
  delete process.env.PUBLIC_BASE_URL;
  delete process.env.NODE_ENV;
  process.env.PORT = "4321";
  assert.equal(publicBaseUrl(), "http://localhost:4321");
});

test("publicUrl: sin la env en producción, o con una URL inválida, lanza", () => {
  delete process.env.PUBLIC_BASE_URL;
  process.env.NODE_ENV = "production";
  assert.throws(() => publicBaseUrl(), /PUBLIC_BASE_URL/);
  process.env.PUBLIC_BASE_URL = "no es una url";
  assert.throws(() => publicBaseUrl(), /PUBLIC_BASE_URL/);
  process.env.PUBLIC_BASE_URL = "javascript:alert(1)";
  assert.throws(() => publicBaseUrl(), /http/);
});
