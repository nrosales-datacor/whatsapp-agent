import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import {
  ApiError,
  apiDownload,
  apiRequest,
  errorMessage,
  filenameFromDisposition,
  isApiError,
  messageForCode,
  onBusinessPaused,
  onUnauthorized,
  setActiveLocationId,
  setTransport,
} from "../../web/src/lib/api";

// ─────────────────────────────────────────────────────────────────────────────
// Cliente de la API del panel (web/src/lib/api.ts) con `fetch` simulado: el sobre
// `{ ok, data | error, code, fields }`, los códigos de respaldo cuando la respuesta no es
// del backend (502 de un proxy con HTML, red caída) y los avisos de sesión vencida y de
// negocio pausado. Sin DOM ni red. Del lado del server, ver panelApi.test.ts.
// ─────────────────────────────────────────────────────────────────────────────

interface FetchCall {
  url: string;
  init: RequestInit;
}

const realFetch = globalThis.fetch;
let cleanups: (() => void)[] = [];

/** Reemplaza `fetch` por uno que responde `respond()` y anota cada llamada. */
function mockFetch(respond: (call: FetchCall) => Response | Promise<Response>): FetchCall[] {
  const calls: FetchCall[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(input), init: init ?? {} };
    calls.push(call);
    return respond(call);
  }) as typeof fetch;
  return calls;
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** Lo que lanza `promise` (falla si no lanza o si no es un ApiError). */
async function rejection(promise: Promise<unknown>): Promise<ApiError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof ApiError, `se esperaba ApiError, llegó ${String(error)}`);
    return error;
  }
  assert.fail("se esperaba un error");
}

afterEach(() => {
  globalThis.fetch = realFetch;
  setActiveLocationId(null);
  setTransport(null);
  for (const cleanup of cleanups) cleanup();
  cleanups = [];
});

test("api cliente: 200 { ok: true } devuelve `data` y arma bien la petición", async () => {
  const calls = mockFetch(() => json(200, { ok: true, data: { id: "c1" } }));
  assert.deepEqual(await apiRequest("GET", "/clients/c1"), { id: "c1" });
  assert.equal(calls[0].url, "/api/panel/clients/c1");
  assert.equal(calls[0].init.method, "GET");
  assert.equal(calls[0].init.credentials, "same-origin");
  assert.equal(calls[0].init.body, undefined);
  assert.deepEqual(calls[0].init.headers, { Accept: "application/json" });

  // Con cuerpo y sucursal activa: JSON + Content-Type + X-Location-Id.
  setActiveLocationId("loc-9");
  await apiRequest("POST", "/clients", { name: "Ana" });
  assert.equal(calls[1].init.body, JSON.stringify({ name: "Ana" }));
  assert.deepEqual(calls[1].init.headers, { Accept: "application/json", "Content-Type": "application/json", "X-Location-Id": "loc-9" });
});

test("api cliente: 204 devuelve undefined", async () => {
  mockFetch(() => new Response(null, { status: 204 }));
  assert.equal(await apiRequest("DELETE", "/clients/c1"), undefined);
});

test("api cliente: 4xx con sobre → ApiError con el mensaje, el código y los errores por campo del backend", async () => {
  mockFetch(() =>
    json(400, { ok: false, error: "El correo no es válido.", code: "validation_error", fields: { "body.email": "Correo inválido" } }),
  );
  const error = await rejection(apiRequest("POST", "/auth/login", { email: "x" }));
  assert.equal(error.status, 400);
  assert.equal(error.code, "validation_error");
  assert.equal(error.message, "El correo no es válido.");
  assert.equal(error.path, "/auth/login");
  assert.equal(error.fieldError("email"), "Correo inválido");
  assert.equal(error.fieldError("name"), undefined);
  assert.ok(isApiError(error, "validation_error"));
  assert.ok(!isApiError(error, "not_found"));
  assert.equal(errorMessage(error), "El correo no es válido.");
});

test("api cliente: sobre sin mensaje usa el del código; sin código, el de respaldo por status", async () => {
  mockFetch(() => json(422, { ok: false, code: "plan_limit_reached" }));
  let error = await rejection(apiRequest("POST", "/team/staff", {}));
  assert.equal(error.code, "plan_limit_reached");
  assert.equal(error.message, messageForCode("plan_limit_reached"));

  mockFetch(() => json(404, { ok: false, fields: "no es un objeto" }));
  error = await rejection(apiRequest("GET", "/clients/x"));
  assert.equal(error.code, "not_found");
  assert.deepEqual(error.fields, {}, "fields que no es objeto se descarta");

  // Un 200 con ok:false sigue siendo un error.
  mockFetch(() => json(200, { ok: false, error: "No.", code: "forbidden" }));
  error = await rejection(apiRequest("GET", "/x"));
  assert.equal(error.status, 200);
  assert.equal(error.code, "forbidden");
});

test("api cliente: 502 con HTML de un proxy → server_error con el mensaje genérico", async () => {
  mockFetch(() => new Response("<html><body>502 Bad Gateway</body></html>", { status: 502, headers: { "content-type": "text/html" } }));
  const error = await rejection(apiRequest("GET", "/agenda"));
  assert.equal(error.status, 502);
  assert.equal(error.code, "server_error");
  assert.equal(error.message, messageForCode("server_error"));
});

test("api cliente: sin sobre, el código sale del status (fallbackCode)", async () => {
  const cases: [number, string][] = [
    [401, "unauthorized"],
    [403, "forbidden"],
    [404, "not_found"],
    [429, "too_many_attempts"],
    [500, "server_error"],
    [503, "server_error"],
    [418, "http_error"],
  ];
  for (const [status, code] of cases) {
    mockFetch(() => new Response("texto plano", { status }));
    const error = await rejection(apiRequest("GET", "/x"));
    assert.equal(error.code, code, String(status));
    assert.equal(error.status, status);
  }
  // 200 que no es el sobre (p. ej. el index.html del panel por una ruta mal armada).
  mockFetch(() => new Response("<!doctype html>", { status: 200, headers: { "content-type": "text/html" } }));
  assert.equal((await rejection(apiRequest("GET", "/x"))).code, "invalid_response");
  mockFetch(() => json(200, { data: 1 }));
  assert.equal((await rejection(apiRequest("GET", "/x"))).code, "invalid_response");
});

test("api cliente: red caída (fetch lanza TypeError) → network_error con status 0", async () => {
  mockFetch(() => {
    throw new TypeError("Failed to fetch");
  });
  const error = await rejection(apiRequest("GET", "/agenda"));
  assert.equal(error.status, 0);
  assert.equal(error.code, "network_error");
  assert.equal(error.message, messageForCode("network_error"));
});

test("api cliente: 401 unauthorized avisa a onUnauthorized con la ruta; otro 401 (login) no", async () => {
  const seen: string[] = [];
  cleanups.push(onUnauthorized((path) => seen.push(path)));

  mockFetch(() => json(401, { ok: false, error: "Sesión vencida.", code: "unauthorized" }));
  await rejection(apiRequest("GET", "/agenda"));
  assert.deepEqual(seen, ["/agenda"]);

  // Sin sobre (proxy): el respaldo de 401 es `unauthorized` → también avisa.
  mockFetch(() => new Response("", { status: 401 }));
  await rejection(apiRequest("GET", "/clients"));
  assert.deepEqual(seen, ["/agenda", "/clients"]);

  mockFetch(() => json(401, { ok: false, error: "Correo o clave incorrectos.", code: "invalid_credentials" }));
  const error = await rejection(apiRequest("POST", "/auth/login", {}));
  assert.equal(error.code, "invalid_credentials");
  assert.deepEqual(seen, ["/agenda", "/clients"], "un error del formulario no cierra la sesión");
});

test("api cliente: desregistrar el manejador lo apaga (y no pisa a uno nuevo)", async () => {
  const first: string[] = [];
  const second: string[] = [];
  const offFirst = onUnauthorized((path) => first.push(path));
  const offSecond = onUnauthorized((path) => second.push(path));
  cleanups.push(offSecond);
  offFirst(); // ya no es el registrado: no debe sacar al segundo
  mockFetch(() => json(401, { ok: false, code: "unauthorized" }));
  await rejection(apiRequest("GET", "/x"));
  assert.deepEqual(first, []);
  assert.deepEqual(second, ["/x"]);
  offSecond();
  await rejection(apiRequest("GET", "/y"));
  assert.deepEqual(second, ["/x"]);
});

test("api cliente: business_paused avisa desde cualquier ruta menos /auth/me y /billing/*", async () => {
  let paused = 0;
  cleanups.push(onBusinessPaused(() => paused++));
  mockFetch(() => json(403, { ok: false, error: "Cuenta pausada.", code: "business_paused" }));

  const onMe = await rejection(apiRequest("GET", "/auth/me"));
  assert.equal(onMe.code, "business_paused");
  assert.equal(paused, 0, "/auth/me es quien muestra la pantalla: avisar ahí sería un bucle");

  await rejection(apiRequest("POST", "/billing/checkout", {}));
  assert.equal(paused, 0, "la pantalla de cuenta pausada usa /billing/* para pagar");

  await rejection(apiRequest("GET", "/agenda"));
  assert.equal(paused, 1);
  await rejection(apiRequest("GET", "/auth/me/extra"));
  assert.equal(paused, 2, "solo /auth/me exacto queda afuera");
});

test("api cliente: setTransport cambia el transporte (el mock) y null vuelve a fetch", async () => {
  const calls = mockFetch(() => json(200, { ok: true, data: "red" }));
  setTransport(async (req) => ({ status: 200, payload: { ok: true, data: `mock ${req.method} ${req.path}` } }));
  assert.equal(await apiRequest("GET", "/x"), "mock GET /x");
  assert.equal(calls.length, 0);
  setTransport(async () => {
    throw new Error("se cayó el mock");
  });
  assert.equal((await rejection(apiRequest("GET", "/x"))).code, "network_error");
  setTransport(null);
  assert.equal(await apiRequest("GET", "/x"), "red");
  assert.equal(calls.length, 1);
});

test("api cliente: apiDownload con error devuelve el mismo ApiError y avisa igual que apiRequest", async () => {
  const seen: string[] = [];
  let paused = 0;
  cleanups.push(onUnauthorized((path) => seen.push(path)));
  cleanups.push(onBusinessPaused(() => paused++));

  const calls = mockFetch(() => json(401, { ok: false, code: "unauthorized" }));
  setActiveLocationId("loc-1");
  const error = await rejection(apiDownload("/reports/sales.csv", "ventas.csv"));
  assert.equal(error.code, "unauthorized");
  assert.deepEqual(seen, ["/reports/sales.csv"]);
  assert.equal((calls[0].init.headers as Record<string, string>)["X-Location-Id"], "loc-1");

  mockFetch(() => json(403, { ok: false, code: "business_paused" }));
  await rejection(apiDownload("/reports/sales.csv", "ventas.csv"));
  assert.equal(paused, 1);

  mockFetch(() => new Response("<html>", { status: 502 }));
  assert.equal((await rejection(apiDownload("/reports/sales.csv", "ventas.csv"))).code, "server_error");

  mockFetch(() => {
    throw new TypeError("offline");
  });
  assert.equal((await rejection(apiDownload("/reports/sales.csv", "ventas.csv"))).code, "network_error");
});

test("api cliente: filenameFromDisposition lee el nombre o cae al de respaldo", () => {
  assert.equal(filenameFromDisposition('attachment; filename="ventas-2026-10.csv"', "x.csv"), "ventas-2026-10.csv");
  assert.equal(filenameFromDisposition("attachment; filename=clientes.csv", "x.csv"), "clientes.csv");
  assert.equal(filenameFromDisposition('ATTACHMENT; FILENAME="Reporte.csv"', "x.csv"), "Reporte.csv");
  assert.equal(filenameFromDisposition('attachment; filename="  a.csv  "', "x.csv"), "a.csv");
  assert.equal(filenameFromDisposition("attachment", "x.csv"), "x.csv");
  assert.equal(filenameFromDisposition('attachment; filename=""', "x.csv"), "x.csv");
  assert.equal(filenameFromDisposition(null, "x.csv"), "x.csv");
});

test("api cliente: messageForCode y errorMessage tienen respaldo para lo desconocido", () => {
  assert.equal(messageForCode("codigo_que_no_existe"), messageForCode("server_error"));
  assert.equal(errorMessage(new Error("interno: stack trace")), messageForCode("server_error"), "un Error cualquiera no se muestra tal cual");
  assert.equal(errorMessage("x", "Respaldo."), "Respaldo.");
  assert.equal(errorMessage(new ApiError(400, "", "validation_error", {}, "/x"), "Respaldo."), "Respaldo.");
  assert.ok(!isApiError(new Error("x")));
});
