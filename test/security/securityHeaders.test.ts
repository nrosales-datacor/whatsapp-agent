import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { after, test } from "node:test";
import { createAppHandler, createWorkerHandler } from "../../src/app";
import { inlineScriptHashes } from "../../src/platform/net/securityHeaders";
import { createEphemeralDb } from "../helpers/pgliteDb";

// ─────────────────────────────────────────────────────────────────────────────
// Cabeceras de seguridad y rutas del servidor real (src/app.ts, el mismo handler que
// arranca src/server.ts) sobre un Postgres efímero: nosniff, frame-ancestors, CSP por
// ruta (panel estricto, admin con el SDK de Meta, API y /health sin documento, landing con
// el hash de su script inline), HSTS solo por https, y la API respondiendo 404 JSON hasta
// que exista el router (I0.4).
// ─────────────────────────────────────────────────────────────────────────────

const { db, close } = await createEphemeralDb();

async function startServer(handler: http.RequestListener): Promise<{ url: string; stop: () => Promise<void> }> {
  const srv = http.createServer(handler);
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  return {
    url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`,
    stop: () => new Promise<void>((r) => srv.close(() => r())),
  };
}

const web = await startServer(createAppHandler({ db, role: "all" }));
const worker = await startServer(createWorkerHandler({ db, role: "worker" }));

after(async () => {
  await web.stop();
  await worker.stop();
  await close();
});

async function get(path: string, headers: Record<string, string> = {}, base = web.url) {
  const r = await fetch(`${base}${path}`, { headers });
  const body = await r.text();
  return { status: r.status, h: r.headers, body };
}

test("cabeceras: nosniff, Referrer-Policy, Permissions-Policy y frame-ancestors en /panel, /api/panel/me, / y /health", async () => {
  for (const path of ["/panel", "/api/panel/me", "/", "/health"]) {
    const { h } = await get(path);
    assert.equal(h.get("x-content-type-options"), "nosniff", path);
    assert.equal(h.get("referrer-policy"), "strict-origin-when-cross-origin", path);
    assert.match(h.get("permissions-policy") ?? "", /camera=\(\)/, path);
    assert.equal(h.get("x-frame-options"), "DENY", path);
    assert.match(h.get("content-security-policy") ?? "", /frame-ancestors 'none'/, path);
    assert.equal(h.get("strict-transport-security"), null, `${path}: sin https no hay HSTS`);
  }
});

test("cabeceras: CSP estricta en el panel (sin inline), relajada solo para el SDK de Meta en /panel/admin", async () => {
  const panel = (await get("/panel")).h.get("content-security-policy") ?? "";
  assert.match(panel, /default-src 'self'/);
  assert.match(panel, /script-src 'self';/);
  assert.match(panel, /style-src 'self';/);
  assert.match(panel, /connect-src 'self';/);
  assert.match(panel, /img-src 'self' data: blob: https:/);
  assert.doesNotMatch(panel, /unsafe-inline|unsafe-eval|facebook/);
  const admin = (await get("/panel/admin")).h.get("content-security-policy") ?? "";
  assert.match(admin, /script-src 'self' https:\/\/connect\.facebook\.net/);
  assert.doesNotMatch(admin, /script-src[^;]*unsafe-inline/);
  assert.match((await get("/api/panel/me")).h.get("content-security-policy") ?? "", /default-src 'none'/);
  assert.match((await get("/health")).h.get("content-security-policy") ?? "", /default-src 'none'/);
});

test("cabeceras: la landing autoriza SOLO su script inline por hash (sin 'unsafe-inline')", async () => {
  const { status, h, body } = await get("/");
  assert.equal(status, 200);
  const csp = h.get("content-security-policy") ?? "";
  const hashes = inlineScriptHashes(body);
  assert.ok(hashes.length >= 1, "index.html tiene un script inline");
  for (const hash of hashes) assert.ok(csp.includes(hash), `falta ${hash} en la CSP`);
  assert.doesNotMatch(csp, /unsafe-inline/);
});

test("cabeceras: el hash del script inline es el del navegador aunque el HTML tenga fin de línea CRLF", () => {
  // El parser HTML normaliza CRLF/CR → LF antes de hashear: un checkout en Windows
  // (core.autocrlf) no puede dejar el script de la landing bloqueado por la CSP.
  const lf = inlineScriptHashes("<script>\nvar a = 1;\nvar b = 2;\n</script>");
  assert.deepEqual(inlineScriptHashes("<script>\r\nvar a = 1;\r\nvar b = 2;\r\n</script>"), lf);
  assert.deepEqual(inlineScriptHashes("<script>\rvar a = 1;\rvar b = 2;\r</script>"), lf);
});

test("cabeceras: HSTS solo si la request vino por https (X-Forwarded-Proto del proxy) o forzado por env", async () => {
  assert.equal((await get("/", { "x-forwarded-proto": "https" })).h.get("strict-transport-security"), "max-age=31536000");
  assert.equal((await get("/health", { "x-forwarded-proto": "http" })).h.get("strict-transport-security"), null);
  process.env.SECURITY_HSTS = "1";
  assert.equal((await get("/health")).h.get("strict-transport-security"), "max-age=31536000");
  process.env.SECURITY_HSTS = "0";
  assert.equal((await get("/", { "x-forwarded-proto": "https" })).h.get("strict-transport-security"), null);
  delete process.env.SECURITY_HSTS;
});

test("rutas: /health 200 en texto plano; /api/* responde 404 en JSON { ok: false, error }", async () => {
  const health = await get("/health");
  assert.equal(health.status, 200);
  assert.match(health.body, /: ok$/);

  for (const path of ["/api/panel/me", "/api/panel/login", "/api/otra-cosa"]) {
    const r = await get(path);
    assert.equal(r.status, 404, path);
    assert.match(r.h.get("content-type") ?? "", /application\/json/, path);
    const json = JSON.parse(r.body);
    assert.equal(json.ok, false);
    assert.equal(typeof json.error, "string");
  }
  assert.equal((await get("/no-existe")).status, 404);
});

test("rutas: el proceso worker solo sirve /health", async () => {
  assert.equal((await get("/health", {}, worker.url)).status, 200);
  assert.equal((await get("/", {}, worker.url)).status, 404);
  assert.equal((await get("/panel", {}, worker.url)).status, 404);
  assert.equal((await get("/api/panel/me", {}, worker.url)).status, 404);
});
