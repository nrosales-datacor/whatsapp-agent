import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { createAppHandler } from "../../src/app";
import { createEphemeralDb, type EphemeralDb } from "../helpers/pgliteDb";

// ─────────────────────────────────────────────────────────────────────────────
// Integración: el handler real de la app (createAppHandler, con PGlite) monta el router
// en /api/panel/* — rutas de src/routes.ts, cabeceras de seguridad de la API y 404 en
// JSON para el resto de /api.
// ─────────────────────────────────────────────────────────────────────────────

let ephemeral: EphemeralDb;
let srv: http.Server;
let baseUrl: string;

before(async () => {
  ephemeral = await createEphemeralDb();
  const handler = createAppHandler({ db: ephemeral.db, role: "all" });
  srv = http.createServer((req, res) => void handler(req, res));
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  baseUrl = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
});

after(async () => {
  srv.closeAllConnections();
  await new Promise<void>((r) => srv.close(() => r()));
  await ephemeral.close();
});

test("GET /api/panel/ping → 200 { ok: true, data: { pong: true } } con las cabeceras de la API", async () => {
  const res = await fetch(`${baseUrl}/api/panel/ping`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, data: { pong: true } });
  assert.match(res.headers.get("content-security-policy") ?? "", /default-src 'none'/);
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.ok(res.headers.get("x-request-id"));
});

test("método equivocado sobre /api/panel/ping → 405 con Allow", async () => {
  const res = await fetch(`${baseUrl}/api/panel/ping`, { method: "POST", headers: { origin: baseUrl } });
  assert.equal(res.status, 405);
  assert.equal(res.headers.get("allow"), "GET");
});

test("rutas desconocidas de la API → 404 en JSON (dentro y fuera de /api/panel)", async () => {
  for (const path of ["/api/panel/no-existe", "/api/otra-cosa", "/api"]) {
    const res = await fetch(`${baseUrl}${path}`);
    assert.equal(res.status, 404, path);
    assert.deepEqual(await res.json(), { ok: false, error: "Recurso no encontrado.", code: "not_found" }, path);
  }
});
