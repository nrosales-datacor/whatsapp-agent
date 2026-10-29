import { after, test } from "node:test";
import assert from "node:assert/strict";
import type { ServerResponse } from "node:http";
import { createEphemeralDb } from "../helpers/pgliteDb";
import { checkHealth, healthStatusCode, isHealthDetailTokenValid, serveHealth } from "../../src/platform/http/health";

// ─────────────────────────────────────────────────────────────────────────────
// El health check verifica algo real (ping a la base con timeout), no solo que Node está
// vivo. Se prueba `checkHealth`/`serveHealth` DIRECTO (sin levantar server.ts, que tiene
// efectos de lado top-level) contra Postgres efímero (PGlite).
// ─────────────────────────────────────────────────────────────────────────────

const previousToken = process.env.HEALTH_DETAIL_TOKEN;
after(() => {
  if (previousToken === undefined) delete process.env.HEALTH_DETAIL_TOKEN;
  else process.env.HEALTH_DETAIL_TOKEN = previousToken;
});

/** Respuesta mínima que captura status, headers y cuerpo. */
function fakeResponse() {
  const out = { status: 0, headers: {} as Record<string, string>, body: "" };
  const res = {
    writeHead(status: number, headers?: Record<string, string>) {
      out.status = status;
      out.headers = headers ?? {};
      return res;
    },
    end(body?: string) {
      out.body = body ? String(body) : "";
    },
  } as unknown as ServerResponse;
  return { res, out };
}

test("base alcanzable: 200, reporta latencia y el tipo de base", async () => {
  const { db, close } = await createEphemeralDb();
  try {
    const report = await checkHealth(db, { role: "all" });
    assert.equal(report.ok, true);
    assert.equal(report.db.ok, true);
    assert.equal(report.db.kind, process.env.DATABASE_URL ? "postgres" : "pglite");
    assert.ok((report.db.latencyMs ?? -1) >= 0);
    assert.equal(report.role, "all");
    assert.equal(healthStatusCode(report), 200);
    // Contrato de forma: lo que se manda tal cual con `?detail=1`.
    assert.deepEqual(Object.keys(JSON.parse(JSON.stringify(report))).sort(), ["db", "ok", "role", "uptimeSec"]);
  } finally {
    await close();
  }
});

test("base inalcanzable → 503 con el motivo en el detalle", async () => {
  const { db, close } = await createEphemeralDb();
  await close(); // simula la base caída: cualquier query sobre `db` falla desde ahora
  const report = await checkHealth(db);
  assert.equal(report.db.ok, false);
  assert.ok(report.db.error, "debe explicar por qué falló, para el modo detalle");
  assert.equal(report.ok, false);
  assert.equal(healthStatusCode(report), 503);
});

test("serveHealth: texto plano por defecto; JSON solo con ?detail=1 y el token correcto", async () => {
  const { db, close } = await createEphemeralDb();
  try {
    process.env.HEALTH_DETAIL_TOKEN = "token-de-prueba-123";

    const plain = fakeResponse();
    await serveHealth(plain.res, new URL("http://x/health"), db);
    assert.equal(plain.out.status, 200);
    assert.match(plain.out.headers["content-type"], /text\/plain/);
    assert.match(plain.out.body, /: ok$/);

    const badToken = fakeResponse();
    await serveHealth(badToken.res, new URL("http://x/health?detail=1&token=otro"), db);
    assert.match(badToken.out.headers["content-type"], /text\/plain/, "token equivocado: mismo texto plano");

    const detail = fakeResponse();
    await serveHealth(detail.res, new URL("http://x/health?detail=1&token=token-de-prueba-123"), db, { role: "web" });
    assert.match(detail.out.headers["content-type"], /application\/json/);
    const json = JSON.parse(detail.out.body);
    assert.equal(json.ok, true);
    assert.equal(json.role, "web");
    assert.equal(json.db.ok, true);
  } finally {
    await close();
  }
});

test("isHealthDetailTokenValid: sin la env nunca vale; con la env, solo el valor exacto", () => {
  delete process.env.HEALTH_DETAIL_TOKEN;
  assert.equal(isHealthDetailTokenValid("cualquiera"), false);
  process.env.HEALTH_DETAIL_TOKEN = "abc";
  assert.equal(isHealthDetailTokenValid(null), false);
  assert.equal(isHealthDetailTokenValid("abcd"), false);
  assert.equal(isHealthDetailTokenValid("abc"), true);
});
