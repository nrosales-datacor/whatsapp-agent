import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, test } from "node:test";
import { z } from "zod";
import { HttpError } from "../../src/platform/http/errors";
import { created, createRouter, noContent, reply, route, type RouterOptions } from "../../src/platform/http/router";
import type { Route, Session } from "../../src/platform/http/routeTypes";

// ─────────────────────────────────────────────────────────────────────────────
// Router declarativo de la API del panel: matching, orden de los chequeos (CSRF, tope,
// sesión, rol, módulo, sucursal, validación), forma de las respuestas y errores. Todo
// por HTTP real contra un server efímero, para ver status y cabeceras tal como salen.
// ─────────────────────────────────────────────────────────────────────────────

const BUSINESS = "11111111-1111-4111-8111-111111111111";
const LOC_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const LOC_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function session(overrides: Partial<Session> = {}): Session {
  return {
    userId: "22222222-2222-4222-8222-222222222222",
    businessId: BUSINESS,
    role: "owner",
    locationIds: "all",
    sessionEpoch: 1,
    ...overrides,
  };
}

interface TestServer {
  url: string;
  close: () => Promise<void>;
}

async function startRouter(options: RouterOptions): Promise<TestServer> {
  const handler = createRouter(options);
  const srv = http.createServer((req, res) => void handler(req, res));
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  const { port } = srv.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((r) => {
        srv.closeAllConnections();
        srv.close(() => r());
      }),
  };
}

interface CallOptions {
  method?: string;
  body?: unknown;
  rawBody?: string;
  headers?: Record<string, string>;
  /** false = sin Origin (simula un POST cross-site / sin cabecera). */
  sameOrigin?: boolean;
  /** Identidad que el resolver de prueba va a devolver (por cabecera `x-test-session`). */
  as?: Session | null;
  location?: string;
}

interface CallResult {
  status: number;
  headers: Headers;
  json: Record<string, unknown> | null;
}

async function call(s: TestServer, path: string, opts: CallOptions = {}): Promise<CallResult> {
  const method = opts.method ?? "GET";
  const headers: Record<string, string> = { ...opts.headers };
  if (opts.sameOrigin !== false && method !== "GET") headers.origin = s.url;
  if (opts.as) headers["x-test-session"] = JSON.stringify(opts.as);
  if (opts.location !== undefined) headers["x-location-id"] = opts.location;
  let body: string | undefined = opts.rawBody;
  if (opts.body !== undefined) {
    body = JSON.stringify(opts.body);
    headers["content-type"] = "application/json";
  }
  const res = await fetch(`${s.url}${path}`, { method, headers, body });
  const text = await res.text();
  return { status: res.status, headers: res.headers, json: text ? JSON.parse(text) : null };
}

/** Resolver de prueba: la sesión viaja serializada en una cabecera. */
const resolveSession: RouterOptions["resolveSession"] = async (req) => {
  const raw = req.headers["x-test-session"];
  return typeof raw === "string" ? (JSON.parse(raw) as Session) : null;
};

describe("router: rutas, permisos y respuestas", () => {
  const reported: { error: unknown; context: Record<string, unknown> }[] = [];
  const gateCalls: [string, string][] = [];
  let s: TestServer;

  const routes: Route[] = [
    route({ method: "GET", path: "/ping", auth: "public" }, () => ({ pong: true })),
    route({ method: "GET", path: "/items/:id/notes/:noteId", auth: "public" }, ({ params }) => ({
      id: params.id,
      noteId: params.noteId,
    })),
    route({ method: "GET", path: "/items/today", auth: "public" }, () => "literal"),
    route({ method: "GET", path: "/items/:id", auth: "public" }, ({ params }) => `param:${params.id}`),
    route({ method: "DELETE", path: "/items/:id", auth: "public" }, () => noContent()),
    route({ method: "POST", path: "/items", auth: "public", body: z.object({ name: z.string().min(1) }) }, ({ body }) =>
      created({ name: body.name }),
    ),
    route({ method: "GET", path: "/me", auth: "user" }, ({ session: me }) => ({ userId: me.userId, role: me.role })),
    route({ method: "GET", path: "/admin/stats", auth: "superadmin" }, ({ session: admin }) => ({ admin: admin.adminId })),
    route({ method: "GET", path: "/owners-only", auth: "user", roles: ["owner", "admin"] }, () => "ok"),
    route({ method: "GET", path: "/sales/summary", auth: "user", module: "sales" }, () => "sales"),
    route(
      { method: "GET", path: "/role-and-module", auth: "user", roles: ["owner"], module: "commissions" },
      () => "ok",
    ),
    route({ method: "GET", path: "/branch", auth: "user", location: "required" }, ({ locationId }) => ({ locationId })),
    route({ method: "GET", path: "/branch-optional", auth: "user", location: "optional" }, ({ locationId }) => ({
      locationId,
    })),
    route(
      {
        method: "POST",
        path: "/clients/:id/visits",
        auth: "user",
        params: z.object({ id: z.uuid() }),
        query: z.object({ notify: z.enum(["yes", "no"]).optional(), page: z.coerce.number().int().min(1).default(1) }),
        body: z.object({ date: z.iso.date(), amount: z.number().positive(), note: z.string().max(5).optional() }),
      },
      ({ params, query, body }) => ({ id: params.id, page: query.page, notify: query.notify ?? null, ...body }),
    ),
    route({ method: "GET", path: "/raw-query", auth: "public" }, ({ query }) => query),
    route({ method: "POST", path: "/small", auth: "public", maxBodyBytes: 100 }, () => "ok"),
    route({ method: "POST", path: "/default-limit", auth: "public", body: z.looseObject({}) }, () => "ok"),
    route({ method: "GET", path: "/boom", auth: "public" }, () => {
      throw new Error("detalle interno secreto: password=hunter2");
    }),
    route({ method: "GET", path: "/teapot", auth: "public" }, () => {
      throw new HttpError(409, "La cita ya está cobrada.", "already_paid");
    }),
    route({ method: "GET", path: "/accepted", auth: "public" }, () => reply(202, { queued: true }, { "x-extra": "1" })),
    route({ method: "GET", path: "/nothing", auth: "public" }, () => undefined),
    route({ method: "GET", path: "/manual", auth: "public" }, ({ res }) => {
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      res.end("hecho a mano");
    }),
  ];

  before(async () => {
    s = await startRouter({
      routes,
      resolveSession,
      resolveSuperadmin: async (req) => (req.headers["x-test-admin"] === "1" ? { adminId: "root" } : null),
      moduleGate: (businessId, module) => {
        gateCalls.push([businessId, module]);
        return module === "sales";
      },
      reportError: (error, context) => reported.push({ error, context }),
    });
  });
  after(() => s.close());

  test("respuesta OK: 200 { ok: true, data } con no-store y x-request-id", async () => {
    const r = await call(s, "/api/panel/ping");
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { ok: true, data: { pong: true } });
    assert.equal(r.headers.get("cache-control"), "no-store");
    assert.match(r.headers.get("x-request-id") ?? "", /^[0-9a-f-]{36}$/);
    assert.match(r.headers.get("content-type") ?? "", /application\/json/);
  });

  test("params: se extraen y se decodifican", async () => {
    const r = await call(s, "/api/panel/items/a%20b/notes/n-1");
    assert.equal(r.status, 200);
    assert.deepEqual(r.json?.data, { id: "a b", noteId: "n-1" });
  });

  test("un segmento literal gana a un parámetro; barra final opcional", async () => {
    assert.equal((await call(s, "/api/panel/items/today")).json?.data, "literal");
    assert.equal((await call(s, "/api/panel/items/x9")).json?.data, "param:x9");
    assert.equal((await call(s, "/api/panel/ping/")).status, 200);
  });

  test("404 en JSON para rutas desconocidas, fuera del prefijo o con escapes inválidos", async () => {
    for (const path of ["/api/panel/nope", "/api/panel", "/api/otra/ping", "/api/panel/items/%zz"]) {
      const r = await call(s, path);
      assert.equal(r.status, 404, path);
      assert.deepEqual(r.json, { ok: false, error: "Recurso no encontrado.", code: "not_found" }, path);
    }
  });

  test("405 con Allow cuando la ruta existe con otro método", async () => {
    const r = await call(s, "/api/panel/items/x9", { method: "PATCH" });
    assert.equal(r.status, 405);
    assert.equal(r.headers.get("allow"), "GET, DELETE");
    assert.equal(r.json?.code, "method_not_allowed");
  });

  test("401: ruta de usuario sin sesión; superadmin sin sesión de superadmin", async () => {
    const r = await call(s, "/api/panel/me");
    assert.equal(r.status, 401);
    assert.equal(r.json?.code, "unauthorized");
    assert.equal(typeof r.json?.error, "string");

    assert.equal((await call(s, "/api/panel/admin/stats", { as: session() })).status, 401, "una sesión de equipo no es superadmin");
    const admin = await call(s, "/api/panel/admin/stats", { headers: { "x-test-admin": "1" } });
    assert.equal(admin.status, 200);
    assert.deepEqual(admin.json?.data, { admin: "root" });
  });

  test("con sesión: el handler recibe la sesión tipada", async () => {
    const r = await call(s, "/api/panel/me", { as: session({ role: "staff" }) });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json?.data, { userId: session().userId, role: "staff" });
  });

  test("403 por rol", async () => {
    const denied = await call(s, "/api/panel/owners-only", { as: session({ role: "front_desk" }) });
    assert.equal(denied.status, 403);
    assert.equal(denied.json?.code, "forbidden_role");
    assert.equal((await call(s, "/api/panel/owners-only", { as: session({ role: "admin" }) })).status, 200);
  });

  test("403 module_not_in_plan si el plan no incluye el módulo; el gate recibe negocio y módulo", async () => {
    gateCalls.length = 0;
    assert.equal((await call(s, "/api/panel/sales/summary", { as: session() })).status, 200);
    assert.deepEqual(gateCalls, [[BUSINESS, "sales"]]);
    const r = await call(s, "/api/panel/role-and-module", { as: session() });
    assert.equal(r.status, 403);
    assert.equal(r.json?.code, "module_not_in_plan");
  });

  test("el rol se chequea antes que el módulo", async () => {
    const r = await call(s, "/api/panel/role-and-module", { as: session({ role: "staff" }) });
    assert.equal(r.status, 403);
    assert.equal(r.json?.code, "forbidden_role");
  });

  test("sucursal requerida: falta → 400, inválida → 400, sin acceso → 403", async () => {
    const limited = session({ role: "staff", locationIds: [LOC_A] });
    const missing = await call(s, "/api/panel/branch", { as: limited });
    assert.equal(missing.status, 400);
    assert.equal(missing.json?.code, "location_required");

    const invalid = await call(s, "/api/panel/branch", { as: limited, location: "sucursal-1" });
    assert.equal(invalid.status, 400);
    assert.equal(invalid.json?.code, "location_invalid");

    const forbidden = await call(s, "/api/panel/branch", { as: limited, location: LOC_B });
    assert.equal(forbidden.status, 403);
    assert.equal(forbidden.json?.code, "location_forbidden");

    const ok = await call(s, "/api/panel/branch", { as: limited, location: LOC_A.toUpperCase() });
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.json?.data, { locationId: LOC_A }, "se normaliza a minúsculas");
  });

  test('sucursal con acceso "all": cualquier sucursal (uuid) pasa', async () => {
    const r = await call(s, "/api/panel/branch", { as: session({ locationIds: "all" }), location: LOC_B });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json?.data, { locationId: LOC_B });
  });

  test("sucursal opcional: sin header → null; con header se valida igual", async () => {
    const limited = session({ locationIds: [LOC_A] });
    assert.deepEqual((await call(s, "/api/panel/branch-optional", { as: limited })).json?.data, { locationId: null });
    assert.equal((await call(s, "/api/panel/branch-optional", { as: limited, location: LOC_B })).status, 403);
  });

  test("400 con fields en español: params, query y cuerpo en una sola respuesta", async () => {
    const r = await call(s, "/api/panel/clients/no-uuid/visits?notify=talvez&page=0", {
      method: "POST",
      as: session(),
      body: { date: "19/10/2026", note: "demasiado largo" },
    });
    assert.equal(r.status, 400);
    assert.equal(r.json?.ok, false);
    assert.equal(r.json?.code, "validation_error");
    assert.equal(typeof r.json?.error, "string");
    assert.deepEqual(r.json?.fields, {
      "params.id": "Identificador inválido.",
      "query.notify": 'Debe ser uno de: "yes", "no".',
      "query.page": "Debe ser mayor o igual a 1.",
      "body.date": "Fecha inválida (formato AAAA-MM-DD).",
      "body.amount": "Campo obligatorio.",
      "body.note": "Debe tener como máximo 5 caracteres.",
    });
  });

  test("validación OK: el handler recibe los datos ya transformados (coerce, default)", async () => {
    const id = "33333333-3333-4333-8333-333333333333";
    const r = await call(s, `/api/panel/clients/${id}/visits?notify=yes`, {
      method: "POST",
      as: session(),
      body: { date: "2026-10-19", amount: 1500 },
    });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json?.data, { id, page: 1, notify: "yes", date: "2026-10-19", amount: 1500 });
  });

  test("cuerpo que no es JSON → 400 invalid_json; vacío cuenta como {}", async () => {
    const bad = await call(s, "/api/panel/items", { method: "POST", rawBody: "{no es json" });
    assert.equal(bad.status, 400);
    assert.equal(bad.json?.code, "invalid_json");
    const empty = await call(s, "/api/panel/items", { method: "POST" });
    assert.equal(empty.status, 400);
    assert.deepEqual(empty.json?.fields, { "body.name": "Campo obligatorio." });
  });

  test("query sin esquema: valores sueltos o lista si se repite; __proto__ no contamina", async () => {
    const r = await call(s, "/api/panel/raw-query?a=1&b=2&b=3&__proto__=x");
    assert.equal(r.status, 200);
    // JSON.parse crea `__proto__` como propiedad propia (un literal `{ __proto__: … }` no).
    assert.deepEqual(r.json?.data, JSON.parse('{"a":"1","b":["2","3"],"__proto__":"x"}'));
  });

  test("CSRF: un método que cambia estado sin Origin, o con Origin ajeno, da 403", async () => {
    const noOrigin = await call(s, "/api/panel/items", { method: "POST", body: { name: "x" }, sameOrigin: false });
    assert.equal(noOrigin.status, 403);
    assert.equal(noOrigin.json?.code, "forbidden_origin");

    const foreign = await call(s, "/api/panel/items", {
      method: "POST",
      body: { name: "x" },
      sameOrigin: false,
      headers: { origin: "https://evil.test" },
    });
    assert.equal(foreign.status, 403);

    const del = await call(s, "/api/panel/items/x9", { method: "DELETE", sameOrigin: false });
    assert.equal(del.status, 403, "también DELETE");
  });

  test("CSRF va antes que la sesión: sin Origin y sin sesión → 403, no 401", async () => {
    const r = await call(s, "/api/panel/clients/x/visits", { method: "POST", body: {}, sameOrigin: false });
    assert.equal(r.status, 403);
    assert.equal(r.json?.code, "forbidden_origin");
  });

  test("413 si el cuerpo pasa el tope de la ruta o el default (64 KB)", async () => {
    const r = await call(s, "/api/panel/small", { method: "POST", rawBody: "x".repeat(101) });
    assert.equal(r.status, 413);
    assert.equal(r.json?.code, "payload_too_large");
    assert.equal((await call(s, "/api/panel/small", { method: "POST", rawBody: "x".repeat(100) })).status, 200);

    const big = await call(s, "/api/panel/default-limit", { method: "POST", body: { x: "y".repeat(64 * 1024) } });
    assert.equal(big.status, 413);
  });

  test("sesión antes que validación: sin sesión y cuerpo inválido → 401", async () => {
    const r = await call(s, "/api/panel/clients/x/visits", { method: "POST", body: { nada: true } });
    assert.equal(r.status, 401);
  });

  test("500 genérico: no filtra el mensaje interno, se reporta con contexto", async () => {
    reported.length = 0;
    const r = await call(s, "/api/panel/boom");
    assert.equal(r.status, 500);
    assert.equal(r.json?.ok, false);
    assert.equal(r.json?.code, "internal_error");
    const raw = JSON.stringify(r.json);
    assert.doesNotMatch(raw, /secreto|hunter2|password/);
    assert.equal(reported.length, 1);
    assert.match(String((reported[0].error as Error).message), /detalle interno secreto/);
    assert.equal(reported[0].context.route, "GET /boom");
    assert.equal(reported[0].context.requestId, r.headers.get("x-request-id"));
  });

  test("HttpError del handler: su status, mensaje y código (sin reporte por ser 4xx)", async () => {
    reported.length = 0;
    const r = await call(s, "/api/panel/teapot");
    assert.equal(r.status, 409);
    assert.deepEqual(r.json, { ok: false, error: "La cita ya está cobrada.", code: "already_paid" });
    assert.equal(reported.length, 0);
  });

  test("created() → 201, reply() → status y cabeceras propias, noContent() → 204 sin cuerpo", async () => {
    const c = await call(s, "/api/panel/items", { method: "POST", body: { name: "Corte" } });
    assert.equal(c.status, 201);
    assert.deepEqual(c.json, { ok: true, data: { name: "Corte" } });

    const a = await call(s, "/api/panel/accepted");
    assert.equal(a.status, 202);
    assert.equal(a.headers.get("x-extra"), "1");
    assert.deepEqual(a.json, { ok: true, data: { queued: true } });

    const d = await call(s, "/api/panel/items/x9", { method: "DELETE" });
    assert.equal(d.status, 204);
    assert.equal(d.json, null);
  });

  test("handler sin valor → data: null; handler que responde a mano se respeta", async () => {
    assert.deepEqual((await call(s, "/api/panel/nothing")).json, { ok: true, data: null });
    const res = await fetch(`${s.url}/api/panel/manual`);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "hecho a mano");
  });
});

describe("router: defaults seguros", () => {
  test("sin resolvers ni gate: user y superadmin → 401; ruta con módulo nunca pasa", async () => {
    const reported: unknown[] = [];
    const s = await startRouter({
      routes: [
        route({ method: "GET", path: "/me", auth: "user" }, () => "no"),
        route({ method: "GET", path: "/admin", auth: "superadmin" }, () => "no"),
        route({ method: "GET", path: "/ping", auth: "public" }, () => "pong"),
      ],
      reportError: (e) => reported.push(e),
    });
    try {
      assert.equal((await call(s, "/api/panel/me", { as: session() })).status, 401);
      assert.equal((await call(s, "/api/panel/admin")).status, 401);
      assert.equal((await call(s, "/api/panel/ping")).status, 200);
    } finally {
      await s.close();
    }

    const gated = await startRouter({
      routes: [route({ method: "GET", path: "/sales", auth: "user", module: "sales" }, () => "no")],
      resolveSession,
    });
    try {
      const r = await call(gated, "/api/panel/sales", { as: session() });
      assert.equal(r.status, 403);
      assert.equal(r.json?.code, "module_not_in_plan");
    } finally {
      await gated.close();
    }
  });

  test("si el resolver de sesión lanza → 500 genérico (no 200 ni 401)", async () => {
    const reported: unknown[] = [];
    const s = await startRouter({
      routes: [route({ method: "GET", path: "/me", auth: "user" }, () => "no")],
      resolveSession: async () => {
        throw new Error("base caída: connection refused 10.0.0.5");
      },
      reportError: (e) => reported.push(e),
    });
    try {
      const r = await call(s, "/api/panel/me");
      assert.equal(r.status, 500);
      assert.doesNotMatch(JSON.stringify(r.json), /10\.0\.0\.5|refused/);
      assert.equal(reported.length, 1);
    } finally {
      await s.close();
    }
  });
});

describe("router: declaración de rutas", () => {
  const noop = () => null;

  test("route() rechaza rutas mal formadas", () => {
    assert.throws(() => route({ method: "GET", path: "sin-barra", auth: "public" }, noop), /ruta inválida/);
    assert.throws(() => route({ method: "GET", path: "/barra-final/", auth: "public" }, noop), /ruta inválida/);
    assert.throws(() => route({ method: "GET", path: "/a b", auth: "public" }, noop), /segmento inválido/);
    assert.throws(() => route({ method: "GET", path: "/a/:id/b/:id", auth: "public" }, noop), /repetido/);
  });

  test("route() rechaza declaraciones incoherentes (también si se saltan los tipos)", () => {
    const loose = route as unknown as (spec: Record<string, unknown>, h: () => unknown) => Route;
    assert.throws(() => loose({ method: "GET", path: "/x", auth: "public", roles: ["owner"] }, noop), /solo aplican/);
    assert.throws(() => loose({ method: "GET", path: "/x", auth: "superadmin", module: "sales" }, noop), /solo aplican/);
    assert.throws(() => loose({ method: "GET", path: "/x", auth: "public", location: "required" }, noop), /solo aplican/);
    assert.throws(() => loose({ method: "GET", path: "/x", auth: "user", roles: [] }, noop), /roles vacío/);
    assert.throws(() => loose({ method: "GET", path: "/x", auth: "public", body: z.object({}) }, noop), /no lleva cuerpo/);
    assert.throws(() => loose({ method: "HEAD", path: "/x", auth: "public" }, noop), /método no soportado/);
    assert.throws(() => loose({ method: "GET", path: "/x", auth: "anon" }, noop), /auth inválido/);
    assert.throws(() => loose({ method: "POST", path: "/x", auth: "public", maxBodyBytes: 0 }, noop), /maxBodyBytes/);
  });

  test("createRouter() rechaza dos rutas con el mismo método y forma", () => {
    assert.throws(
      () =>
        createRouter({
          routes: [
            route({ method: "GET", path: "/items/:id", auth: "public" }, noop),
            route({ method: "GET", path: "/items/:slug", auth: "public" }, noop),
          ],
        }),
      /ruta duplicada/,
    );
    // Mismo path con otro método, o literal vs parámetro: válido.
    createRouter({
      routes: [
        route({ method: "GET", path: "/items/:id", auth: "public" }, noop),
        route({ method: "DELETE", path: "/items/:id", auth: "public" }, noop),
        route({ method: "GET", path: "/items/today", auth: "public" }, noop),
      ],
    });
  });

  test("tipos: roles/module/location solo con auth user; un GET no lleva cuerpo", () => {
    // Estos chequeos son de compilación (`npx tsc --noEmit`); en runtime lanzan igual.
    assert.throws(() =>
      // @ts-expect-error roles no aplica a una ruta pública
      route({ method: "GET", path: "/x", auth: "public", roles: ["owner"] }, noop),
    );
    assert.throws(() =>
      // @ts-expect-error location no aplica al superadmin
      route({ method: "GET", path: "/x", auth: "superadmin", location: "required" }, noop),
    );
    assert.throws(() =>
      // @ts-expect-error un GET no declara cuerpo
      route({ method: "GET", path: "/x", auth: "public", body: z.object({}) }, noop),
    );
    // Y el contexto sale tipado: params de la ruta, sesión según auth, sucursal según location.
    route({ method: "GET", path: "/a/:id/b/:other", auth: "user", location: "required" }, (ctx) => {
      const id: string = ctx.params.id;
      const other: string = ctx.params.other;
      const business: string = ctx.session.businessId;
      const location: string = ctx.locationId;
      // @ts-expect-error la ruta no tiene :missing
      void ctx.params.missing;
      return [id, other, business, location];
    });
    route({ method: "GET", path: "/p", auth: "public" }, (ctx) => {
      const nothing: null = ctx.session;
      const noLocation: null = ctx.locationId;
      return [nothing, noLocation];
    });
  });
});
