import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { test, after } from "node:test";
import { and, eq } from "drizzle-orm";

// ─────────────────────────────────────────────────────────────────────────────
// Revisión pre-venta 2026-10 — operación manual de la plataforma, a nivel HTTP contra
// el router REAL y el tenantStore REAL sobre Postgres efímero (PGlite inyectado como
// pool vía `_inyectarDbParaTests`):
//   1. Pausar / reactivar un negocio: efecto en el panel (aviso "cuenta pausada"),
//      en el login y en el webhook (el mensaje se guarda pero no se encola).
//   2. Borrar un cliente final: solo el dueño, con confirmación, CSRF y aislado por
//      tenant (un dueño de A no puede borrar clientes de B).
//   3. Token de WhatsApp obligatorio en el alta + "Reconectar WhatsApp" + mensaje de prueba.
//
// Las env se fijan ANTES de importar (auth.ts, secretos.ts y tenantStore.ts las leen en
// el load). DATABASE_URL es un valor de mentira: nunca se abre una conexión real porque
// `obtenerDb()` devuelve la base inyectada.
// ─────────────────────────────────────────────────────────────────────────────

process.env.PANEL_SESSION_SECRET = "test-plataforma-session-secret-0123456789";
process.env.PANEL_SESSION_VERSION = "1";
process.env.DATABASE_URL = "postgres://pglite-inyectada/test";
process.env.TOKENS_ENCRYPTION_KEY = "ab".repeat(32);
process.env.TENANTS_REFRESH_MS = "0";
process.env.PANEL_SUPERADMIN_USUARIO = "superadmin-test";
delete process.env.SUPABASE_URL;
delete process.env.WHATSAPP_ACCESS_TOKEN;

const { crearDbEfimera } = await import("../helpers/pgliteDb");
const { _inyectarDbParaTests } = await import("../../src/db/client");
const schema = await import("../../src/db/schema");
const { cifrar, descifrar } = await import("../../src/config/secretos");
const { crearSesion, crearSesionAdmin, hashearPassword } = await import("../../src/panel/auth");
const tenantStore = await import("../../src/config/tenantStore");
const { manejarPanel } = await import("../../src/panel/router");
const { RepositorioDrizzle } = await import("../../src/booking/drizzleRepository");
const { ingerirEntrante } = await import("../../src/handleWebhook");
const { cuerpoTextoEntrante } = await import("../helpers/webhookMock");

const { waTenants, waUsuarios, waConversaciones, waMensajes, waJobs, waAuditoria } = schema;

const { db, cerrar } = await crearDbEfimera();
_inyectarDbParaTests(db);
after(() => cerrar());
const repo = new RepositorioDrizzle(db);

const TEL = "50688887777";
const CLAVE = "clave-segura-123";
const TOKEN_A = "EAAtokenDelNegocioA0123456789";

async function sembrarTenant(id: string, pnid: string, token: string) {
  await db.insert(waTenants).values({
    id,
    nombre: `Negocio ${id}`,
    phoneNumberId: pnid,
    accessToken: cifrar(token),
    timezone: "America/Costa_Rica",
    moneda: "₡",
    ubicacion: "San José",
    horario: {},
    servicios: [],
    kb: { faq: [], datos: [], politicas: [] },
  });
}
await sembrarTenant("negocio-a", "11111", TOKEN_A);
await sembrarTenant("negocio-b", "22222", "EAAtokenDelNegocioB0123456789");
const hash = await hashearPassword(CLAVE);
const [duenoA] = await db.insert(waUsuarios).values({ usuario: "dueno-a", passwordHash: hash, tenantId: "negocio-a", rol: "dueno" }).returning();
const [operA] = await db.insert(waUsuarios).values({ usuario: "oper-a", passwordHash: hash, tenantId: "negocio-a", rol: "operador" }).returning();
const [duenoB] = await db.insert(waUsuarios).values({ usuario: "dueno-b", passwordHash: hash, tenantId: "negocio-b", rol: "dueno" }).returning();

async function sembrarConversacion(tenantId: string, tel: string, texto: string) {
  const [conv] = await db.insert(waConversaciones).values({ tenantId, clienteWa: tel }).returning();
  await db.insert(waMensajes).values({ tenantId, conversacionId: conv.id, rol: "user", contenido: texto });
  return conv.id;
}
const convA = await sembrarConversacion("negocio-a", TEL, "hola desde A");
const convB = await sembrarConversacion("negocio-b", TEL, "hola desde B");

await tenantStore.cargarTenants();

const cookieDe = (u: { id: string; tenantId: string; rol: string }) =>
  `panel_sesion=${crearSesion(u.tenantId, u.id, u.rol as "dueno" | "operador", 0)}`;
const COOKIE_ADMIN = `panel_admin_sesion=${crearSesionAdmin()}`;

/** Llama al router real con un request mínimo (headers + cuerpo como stream). */
async function llamar(
  metodo: string,
  path: string,
  opts: { cookie?: string; body?: unknown; sinOrigen?: boolean } = {},
): Promise<{ status: number; json: Record<string, unknown> }> {
  const req = Readable.from(opts.body === undefined ? [] : [Buffer.from(JSON.stringify(opts.body))]) as unknown as IncomingMessage & {
    method: string;
  };
  req.method = metodo;
  req.headers = {
    host: "panel.test",
    ...(opts.sinOrigen ? {} : { origin: "https://panel.test" }),
    ...(opts.cookie ? { cookie: opts.cookie } : {}),
  };
  Object.defineProperty(req, "socket", { value: { remoteAddress: "127.0.0.1" } });
  const salida = { status: 0, body: "" };
  const res = {
    writeHead(s: number) {
      salida.status = s;
      return res;
    },
    end(b?: string) {
      salida.body = b ? String(b) : "";
    },
  } as unknown as ServerResponse;
  await manejarPanel(req, res, repo, path);
  return { status: salida.status, json: salida.body ? JSON.parse(salida.body) : {} };
}

const mensajesDe = async (convId: string) => (await db.select().from(waMensajes).where(eq(waMensajes.conversacionId, convId))).length;

// ── (2) Borrar cliente: guards y aislamiento ─────────────────────────────────

test("borrar-cliente: sin sesión → 401, sin Origin → 403 (CSRF), operador → 403", async () => {
  const ruta = `/api/panel/conversaciones/${convA}/borrar-cliente`;
  assert.equal((await llamar("POST", ruta, { body: { confirmar: TEL } })).status, 401);
  assert.equal((await llamar("POST", ruta, { cookie: cookieDe(duenoA), body: { confirmar: TEL }, sinOrigen: true })).status, 403);
  const r = await llamar("POST", ruta, { cookie: cookieDe(operA), body: { confirmar: TEL } });
  assert.equal(r.status, 403);
  assert.equal(await mensajesDe(convA), 1, "nada se borró");
});

test("borrar-cliente: un dueño de A NO puede borrar el cliente de B (404, B intacto)", async () => {
  const r = await llamar("POST", `/api/panel/conversaciones/${convB}/borrar-cliente`, {
    cookie: cookieDe(duenoA),
    body: { confirmar: TEL },
  });
  assert.equal(r.status, 404);
  assert.equal(await mensajesDe(convB), 1, "la conversación de B sigue intacta");
  assert.equal((await db.select().from(waConversaciones).where(eq(waConversaciones.id, convB))).length, 1);
});

test("borrar-cliente: con la confirmación equivocada no borra nada (400)", async () => {
  const r = await llamar("POST", `/api/panel/conversaciones/${convA}/borrar-cliente`, {
    cookie: cookieDe(duenoA),
    body: { confirmar: "50600000000" },
  });
  assert.equal(r.status, 400);
  assert.equal(await mensajesDe(convA), 1);
});

test("borrar-cliente: el dueño de A borra a su cliente; el mismo teléfono en B queda intacto", async () => {
  const r = await llamar("POST", `/api/panel/conversaciones/${convA}/borrar-cliente`, {
    cookie: cookieDe(duenoA),
    body: { confirmar: "+506 8888-7777" },
  });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal((r.json.conteos as Record<string, number>).mensajes, 1);
  assert.equal((await db.select().from(waConversaciones).where(eq(waConversaciones.id, convA))).length, 0);
  assert.equal(await mensajesDe(convB), 1, "B no se toca");
  const [aud] = await db.select().from(waAuditoria).where(and(eq(waAuditoria.tenantId, "negocio-a"), eq(waAuditoria.accion, "borrar_cliente")));
  assert.equal(aud.actor, `usuario:${duenoA.id}`);
  // Superadmin, por teléfono, contra el negocio B: también aislado (solo borra en B).
  const rb = await llamar("POST", "/api/panel/admin/tenants/negocio-b/clientes/borrar", {
    cookie: COOKIE_ADMIN,
    body: { clienteWa: TEL, confirmar: TEL },
  });
  assert.equal(rb.status, 200);
  assert.equal(await mensajesDe(convB), 0);
});

// ── (1) Pausar / reactivar ───────────────────────────────────────────────────

test("pausar/reactivar es solo del superadmin: la sesión de un dueño no alcanza (401)", async () => {
  const r = await llamar("POST", "/api/panel/admin/tenants/negocio-a/pausar", { cookie: cookieDe(duenoA), body: {} });
  assert.equal(r.status, 401);
  assert.ok(tenantStore.obtenerTenantPorId("negocio-a"), "sigue activo");
});

test("pausar: el bot deja de responder (mensaje guardado sin job), el panel dice 'cuenta pausada' y reactivar lo devuelve", async () => {
  const pausa = await llamar("POST", "/api/panel/admin/tenants/negocio-a/pausar", { cookie: COOKIE_ADMIN, body: { motivo: "Falta de pago" } });
  assert.equal(pausa.status, 200, JSON.stringify(pausa.json));
  assert.equal(tenantStore.obtenerTenantPorId("negocio-a"), undefined, "fuera del caché de activos");
  assert.ok(tenantStore.obtenerTenantPausadoPorId("negocio-a"));
  assert.equal((await llamar("POST", "/api/panel/admin/tenants/negocio-a/pausar", { cookie: COOKIE_ADMIN, body: {} })).status, 409);

  // Panel: sesión válida de un negocio pausado → 403 con código, no un 401 genérico.
  const me = await llamar("GET", "/api/panel/me", { cookie: cookieDe(duenoA) });
  assert.equal(me.status, 403);
  assert.equal(me.json.codigo, "cuenta_pausada");
  // Login: con la clave correcta se explica; con la incorrecta, el 401 de siempre (sin oráculo).
  const login = await llamar("POST", "/api/panel/login", { body: { usuario: "dueno-a", password: CLAVE } });
  assert.equal(login.status, 403);
  assert.equal(login.json.codigo, "cuenta_pausada");
  assert.equal((await llamar("POST", "/api/panel/login", { body: { usuario: "dueno-a", password: "otra-clave-xx" } })).status, 401);
  // Otro negocio no se entera.
  assert.equal((await llamar("GET", "/api/panel/me", { cookie: cookieDe(duenoB) })).status, 200);

  // Webhook: el mensaje se guarda en la conversación pero NO se encola respuesta.
  const p1 = await ingerirEntrante(
    cuerpoTextoEntrante({ phoneNumberId: "11111", clienteWa: "50611112222", texto: "¿abren hoy?", messageId: "wamid.pausa.1" }),
    repo,
    db,
  );
  assert.equal(p1, null, "nadie responde mientras está pausado");
  const [conv] = await db
    .select()
    .from(waConversaciones)
    .where(and(eq(waConversaciones.tenantId, "negocio-a"), eq(waConversaciones.clienteWa, "50611112222")));
  assert.ok(conv, "la conversación se creó");
  const msgs = await db.select().from(waMensajes).where(eq(waMensajes.conversacionId, conv.id));
  assert.deepEqual(msgs.map((m) => m.contenido), ["¿abren hoy?"]);
  assert.equal((await db.select().from(waJobs).where(eq(waJobs.tenantId, "negocio-a"))).length, 0, "sin job: el bot no responde");

  // Admin: el pausado sigue en la lista, marcado, con el motivo.
  const lista = await llamar("GET", "/api/panel/admin/tenants", { cookie: COOKIE_ADMIN });
  const filaA = (lista.json.tenants as { id: string; activo: boolean; motivoPausa: string | null }[]).find((t) => t.id === "negocio-a");
  assert.equal(filaA?.activo, false);
  assert.equal(filaA?.motivoPausa, "Falta de pago");

  // Reactivar: todo vuelve, y el próximo mensaje sí se encola.
  assert.equal((await llamar("POST", "/api/panel/admin/tenants/negocio-a/reactivar", { cookie: COOKIE_ADMIN, body: {} })).status, 200);
  assert.ok(tenantStore.obtenerTenantPorId("negocio-a"));
  assert.equal((await llamar("GET", "/api/panel/me", { cookie: cookieDe(duenoA) })).status, 200);
  const p2 = await ingerirEntrante(
    cuerpoTextoEntrante({ phoneNumberId: "11111", clienteWa: "50611112222", texto: "hola de nuevo", messageId: "wamid.pausa.2" }),
    repo,
    db,
  );
  assert.ok(p2, "reactivado, hay respuesta pendiente");
  assert.equal((await db.select().from(waJobs).where(eq(waJobs.tenantId, "negocio-a"))).length, 1);

  const auditoria = await llamar("GET", "/api/panel/admin/tenants/negocio-a/auditoria", { cookie: COOKIE_ADMIN });
  const acciones = (auditoria.json.auditoria as { accion: string }[]).map((e) => e.accion);
  assert.ok(acciones.includes("pausar") && acciones.includes("reactivar"));
});

// ── (3) Token obligatorio, reconexión y mensaje de prueba ────────────────────

function altaBase(extra: Record<string, unknown> = {}) {
  return {
    tenant: {
      id: "negocio-nuevo",
      nombre: "Negocio nuevo",
      phoneNumberId: "33333",
      ubicacion: "Cartago",
      horario: { 1: { abre: "08:00", cierra: "17:00" } },
      servicios: [],
      kb: { faq: [], datos: [], politicas: [], secciones: [] },
      ...extra,
    },
    usuario: "dueno-nuevo",
    password: CLAVE,
  };
}

test("alta: sin token de WhatsApp se rechaza (400); con token se crea y el token queda cifrado", async () => {
  const sin = await llamar("POST", "/api/panel/admin/tenants", { cookie: COOKIE_ADMIN, body: altaBase() });
  assert.equal(sin.status, 400);
  assert.match(String(sin.json.error), /token/i);
  assert.equal((await db.select().from(waTenants).where(eq(waTenants.id, "negocio-nuevo"))).length, 0);

  const con = await llamar("POST", "/api/panel/admin/tenants", {
    cookie: COOKIE_ADMIN,
    body: altaBase({ accessToken: "EAAtokenDelNegocioNuevo0123456789" }),
  });
  assert.equal(con.status, 201, JSON.stringify(con.json));
  const [fila] = await db.select().from(waTenants).where(eq(waTenants.id, "negocio-nuevo"));
  assert.ok(fila.accessToken?.startsWith("v1:"), "cifrado en reposo");
});

test("reconectar WhatsApp: valida, rechaza un número de otro negocio (409) y rota el token cifrado", async () => {
  const ruta = "/api/panel/admin/tenants/negocio-a/whatsapp";
  assert.equal((await llamar("POST", ruta, { cookie: cookieDe(duenoA), body: {} })).status, 401, "solo superadmin");
  assert.equal((await llamar("POST", ruta, { cookie: COOKIE_ADMIN, body: { phoneNumberId: "11111", accessToken: "corto" } })).status, 400);
  assert.equal(
    (await llamar("POST", ruta, { cookie: COOKIE_ADMIN, body: { phoneNumberId: "22222", accessToken: "EAAtokenNuevoDeA0123456789" } })).status,
    409,
  );

  const ok = await llamar("POST", ruta, { cookie: COOKIE_ADMIN, body: { phoneNumberId: "44444", accessToken: "EAAtokenNuevoDeA0123456789" } });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  const [fila] = await db.select().from(waTenants).where(eq(waTenants.id, "negocio-a"));
  assert.ok(fila.accessToken?.startsWith("v1:"));
  assert.equal(descifrar(fila.accessToken!), "EAAtokenNuevoDeA0123456789");
  assert.equal(tenantStore.obtenerTenantPorId("negocio-a")?.accessToken, "EAAtokenNuevoDeA0123456789", "el caché ya usa el token nuevo");
  assert.equal(tenantStore.obtenerTenantPorPhoneNumberId("44444")?.id, "negocio-a");

  const [aud] = await db
    .select()
    .from(waAuditoria)
    .where(and(eq(waAuditoria.tenantId, "negocio-a"), eq(waAuditoria.accion, "reconectar_whatsapp")));
  assert.ok(!JSON.stringify(aud.detalle).includes("EAA"), "el registro nunca guarda el token");
});

test("mensaje de prueba: muestra el error de Graph si falla y responde 200 si sale", async () => {
  const fetchOriginal = globalThis.fetch;
  const ruta = "/api/panel/admin/tenants/negocio-a/whatsapp/probar";
  try {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: { message: "Invalid OAuth access token.", code: 190 } }), { status: 401 })) as unknown as typeof fetch;
    const mal = await llamar("POST", ruta, { cookie: COOKIE_ADMIN, body: { para: "50688887777" } });
    assert.equal(mal.status, 502);
    assert.equal(mal.json.error, "Invalid OAuth access token. (código 190)");

    let destino = "";
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      destino = String(url);
      assert.match(String(init?.headers && (init.headers as Record<string, string>).Authorization), /EAAtokenNuevoDeA/);
      return new Response(JSON.stringify({ messages: [{ id: "wamid.ok" }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const bien = await llamar("POST", ruta, { cookie: COOKIE_ADMIN, body: { para: "50688887777" } });
    assert.equal(bien.status, 200, JSON.stringify(bien.json));
    assert.match(destino, /\/44444\/messages$/);

    assert.equal((await llamar("POST", ruta, { cookie: COOKIE_ADMIN, body: { para: "12" } })).status, 400);
  } finally {
    globalThis.fetch = fetchOriginal;
  }
});
