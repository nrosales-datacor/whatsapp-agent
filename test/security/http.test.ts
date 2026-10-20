import assert from "node:assert/strict";
import http, { type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { isSameOrigin, parseCookies, readJsonBody } from "../../src/platform/http/http";
import { readBodyWithLimit, withSafetyNet } from "../../src/platform/net/http";

// ─────────────────────────────────────────────────────────────────────────────
// Robustez HTTP ante input hostil y SIN autenticar:
//   • Una cookie malformada (`%`) no lanza (sin esto: URIError → unhandledRejection → sin
//     Sentry, Node mata el proceso de todos los negocios).
//   • El cuerpo tiene tope (sin esto, un POST enorme agota la memoria).
//   • Cualquier excepción del handler responde 500 en vez de colgar/tumbar el proceso.
//   • El guard CSRF exige Origin/Referer del mismo host.
// ─────────────────────────────────────────────────────────────────────────────

const reqWithHeaders = (headers: Record<string, string>) => ({ headers }) as unknown as IncomingMessage;

test("parseCookies: una cookie con escape inválido se ignora sin lanzar", () => {
  const c = parseCookies(reqWithHeaders({ cookie: "panel_session=%; otra=ok%20bien; rota=%zz" }));
  assert.equal(c.panel_session, undefined);
  assert.equal(c.rota, undefined);
  assert.equal(c.otra, "ok bien");
});

test("isSameOrigin: exige Origin (o Referer) del mismo host; sin ninguno, rechaza", () => {
  assert.equal(isSameOrigin(reqWithHeaders({ host: "panel.test", origin: "https://panel.test" })), true);
  assert.equal(isSameOrigin(reqWithHeaders({ host: "panel.test", referer: "https://panel.test/panel/x" })), true);
  assert.equal(isSameOrigin(reqWithHeaders({ host: "panel.test", origin: "https://evil.test" })), false);
  assert.equal(isSameOrigin(reqWithHeaders({ host: "panel.test" })), false, "un POST sin Origin/Referer no pasa");
  assert.equal(isSameOrigin(reqWithHeaders({ host: "panel.test", origin: "no es una url" })), false);
});

/** Levanta un server efímero con el handler dado y devuelve su URL base. */
async function startServer(handler: http.RequestListener): Promise<{ url: string; close: () => Promise<void> }> {
  const srv = http.createServer(handler);
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  const { port } = srv.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((r) => srv.close(() => r())),
  };
}

test("readBodyWithLimit: devuelve el cuerpo si cabe y null si se pasa del tope", async () => {
  const s = await startServer(async (req, res) => {
    const body = await readBodyWithLimit(req, 100);
    res.writeHead(body === null ? 413 : 200);
    res.end(body === null ? "" : String(body.length));
  });
  try {
    const small = await fetch(s.url, { method: "POST", body: "x".repeat(100) });
    assert.equal(small.status, 200);
    assert.equal(await small.text(), "100");
    const big = await fetch(s.url, { method: "POST", body: "x".repeat(101) });
    assert.equal(big.status, 413);
  } finally {
    await s.close();
  }
});

test("readJsonBody: JSON válido, vacío → {}, inválido → {}, demasiado grande → null", async () => {
  const s = await startServer(async (req, res) => {
    const body = await readJsonBody(req, 64);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ body }));
  });
  try {
    const parse = async (body?: string) => (await (await fetch(s.url, { method: "POST", body })).json()).body;
    assert.deepEqual(await parse('{"a":1}'), { a: 1 });
    assert.deepEqual(await parse(""), {});
    assert.deepEqual(await parse("{no es json"), {});
    assert.equal(await parse(JSON.stringify({ x: "y".repeat(100) })), null);
  } finally {
    await s.close();
  }
});

test("withSafetyNet: una excepción del handler responde 500 y se reporta", async () => {
  const reported: unknown[] = [];
  const s = await startServer(
    withSafetyNet(async () => {
      throw new URIError("URI malformed");
    }, (e) => reported.push(e)),
  );
  try {
    const r = await fetch(s.url);
    assert.equal(r.status, 500);
    assert.equal(reported.length, 1);
    assert.ok(reported[0] instanceof URIError);
  } finally {
    await s.close();
  }
});
