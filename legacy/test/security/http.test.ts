import "../helpers/setupEnv";
import assert from "node:assert/strict";
import http, { type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";

// ─────────────────────────────────────────────────────────────────────────────
// Revisión pre-venta 2026-10 — robustez HTTP ante input hostil y SIN autenticar:
//   • Una cookie malformada (`%`) no lanza (antes: URIError → unhandledRejection →
//     sin Sentry, Node mataba el proceso de todos los tenants).
//   • El cuerpo del webhook tiene tope (antes: un POST enorme agotaba la memoria).
//   • Cualquier excepción del handler responde 500 en vez de colgar/tumbar el proceso.
// ─────────────────────────────────────────────────────────────────────────────

process.env.PANEL_SESSION_SECRET = "test-http-session-secret-0123456789";
delete process.env.DATABASE_URL;

const { leerCookies, sesionDeOperador } = await import("../../src/panel/router");
const { leerCuerpoConTope, conRedDeSeguridad } = await import("../../src/red/http");

const reqConCookie = (cookie: string) => ({ headers: { cookie } }) as unknown as IncomingMessage;

test("leerCookies: una cookie con escape inválido se ignora sin lanzar", () => {
  const c = leerCookies(reqConCookie("panel_sesion=%; otra=ok%20bien; rota=%zz"));
  assert.equal(c.panel_sesion, undefined);
  assert.equal(c.rota, undefined);
  assert.equal(c.otra, "ok bien");
});

test("sesionDeOperador: cookie malformada → null (no lanza)", () => {
  assert.equal(sesionDeOperador(reqConCookie("panel_sesion=%")), null);
});

/** Levanta un server efímero con el handler dado y devuelve su URL base. */
async function levantar(handler: http.RequestListener): Promise<{ url: string; cerrar: () => Promise<void> }> {
  const srv = http.createServer(handler);
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  const { port } = srv.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    cerrar: () => new Promise<void>((r) => srv.close(() => r())),
  };
}

test("leerCuerpoConTope: devuelve el cuerpo si cabe y null si se pasa del tope", async () => {
  const s = await levantar(async (req, res) => {
    const cuerpo = await leerCuerpoConTope(req, 100);
    res.writeHead(cuerpo === null ? 413 : 200);
    res.end(cuerpo === null ? "" : String(cuerpo.length));
  });
  try {
    const chico = await fetch(s.url, { method: "POST", body: "x".repeat(100) });
    assert.equal(chico.status, 200);
    assert.equal(await chico.text(), "100");
    const grande = await fetch(s.url, { method: "POST", body: "x".repeat(101) });
    assert.equal(grande.status, 413);
  } finally {
    await s.cerrar();
  }
});

test("conRedDeSeguridad: una excepción del handler responde 500 y se reporta", async () => {
  const reportados: unknown[] = [];
  const s = await levantar(
    conRedDeSeguridad(async () => {
      throw new URIError("URI malformed");
    }, (e) => reportados.push(e)),
  );
  try {
    const r = await fetch(s.url);
    assert.equal(r.status, 500);
    assert.equal(reportados.length, 1);
    assert.ok(reportados[0] instanceof URIError);
  } finally {
    await s.cerrar();
  }
});
