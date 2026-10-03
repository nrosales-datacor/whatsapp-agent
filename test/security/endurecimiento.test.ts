import assert from "node:assert/strict";
import crypto from "node:crypto";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import { test, after } from "node:test";
import { and, eq, isNull } from "drizzle-orm";

// ─────────────────────────────────────────────────────────────────────────────
// Revisión de seguridad pre-venta 2026-10 — a nivel HTTP contra el router REAL y el
// tenantStore REAL sobre Postgres efímero (PGlite), igual que plataformaPanel.test.ts:
//   1. Push: endpoint fuera de la allowlist → 400 (SSRF); suscripción por usuario con
//      tope; logout, desactivación, cambio/reset de clave borran las suscripciones; las
//      viejas sin usuario o con el epoch vencido no reciben y se purgan.
//   2. Cabeceras de seguridad en /panel, /api/panel/me, / y /salud (server HTTP real).
//   3. Rate limit: un X-Forwarded-For falsificado no evade el límite por IP; el lockout
//      es por par (IP, usuario) y no deja afuera al dueño desde otra IP.
//   4. Superadmin: TOTP obligatorio si está configurado, anti-replay, sesión sin 2FA
//      inválida, auditoría de logins/reset/export, export sin password_hash, y el 409
//      al crear usuario no revela el usuario del superadmin.
//
// Las env se fijan ANTES de importar (auth.ts, rateLimitLogin.ts, push.ts las leen en
// el load). DATABASE_URL es de mentira: `obtenerDb()` devuelve la base inyectada.
// ─────────────────────────────────────────────────────────────────────────────

process.env.PANEL_SESSION_SECRET = "test-endurecimiento-session-secret-0123456789";
process.env.PANEL_SESSION_VERSION = "1";
process.env.DATABASE_URL = "postgres://pglite-inyectada/test";
process.env.TOKENS_ENCRYPTION_KEY = "cd".repeat(32);
process.env.TENANTS_REFRESH_MS = "0";
process.env.PANEL_SUPERADMIN_USUARIO = "superadmin-test";
process.env.PANEL_LOGIN_RATE_LIMIT_MAX_IP = "4";
process.env.PANEL_LOGIN_LOCKOUT_UMBRAL = "3";
process.env.PANEL_PUSH_MAX_POR_USUARIO = "3";
delete process.env.TRUST_PROXY;
delete process.env.SUPABASE_URL;
delete process.env.SEGURIDAD_HSTS;
delete process.env.PANEL_SUPERADMIN_TOTP_SECRET;
// Push "configurado" (llaves VAPID de prueba) para ejercer la purga de enviarPushATenant.
// Ningún test deja suscripciones VIGENTES en el negocio donde se envía: no sale nada a la red.
{
  const webpush = (await import("web-push")).default;
  const llaves = webpush.generateVAPIDKeys();
  process.env.VAPID_PUBLIC_KEY = llaves.publicKey;
  process.env.VAPID_PRIVATE_KEY = llaves.privateKey;
}

const { crearDbEfimera } = await import("../helpers/pgliteDb");
const { _inyectarDbParaTests } = await import("../../src/db/client");
const schema = await import("../../src/db/schema");
const { cifrar } = await import("../../src/config/secretos");
const { crearSesion, crearSesionAdmin, hashearPassword } = await import("../../src/panel/auth");
const tenantStore = await import("../../src/config/tenantStore");
const { manejarPanel } = await import("../../src/panel/router");
const { manejarLanding } = await import("../../src/landing/servirLanding");
const { conCabecerasSeguridad, hashesScriptsInline } = await import("../../src/red/cabeceras");
const { enviarPushATenant } = await import("../../src/panel/push");
const { RepositorioDrizzle } = await import("../../src/booking/drizzleRepository");
const rateLimit = await import("../../src/panel/rateLimitLogin");
const totpMod = await import("../../src/panel/totp");

const { waTenants, waUsuarios, waPushSubs, waAuditoria } = schema;

const { db, cerrar } = await crearDbEfimera();
_inyectarDbParaTests(db);
const repo = new RepositorioDrizzle(db);

const CLAVE = "clave-segura-123";
const CLAVE_ADMIN = "clave-del-superadmin-123";

async function sembrarTenant(id: string, pnid: string) {
  await db.insert(waTenants).values({
    id,
    nombre: `Negocio ${id}`,
    phoneNumberId: pnid,
    accessToken: cifrar("EAAtokenDePrueba0123456789"),
    timezone: "America/Costa_Rica",
    moneda: "₡",
    ubicacion: "San José",
    horario: {},
    servicios: [],
    kb: { faq: [], datos: [], politicas: [] },
    plan: "pro", // la gestión de usuarios (desactivar a un empleado) es Pro
  });
}
await sembrarTenant("negocio-a", "11111");
await sembrarTenant("negocio-b", "22222");
await sembrarTenant("negocio-c", "33333");
const hash = await hashearPassword(CLAVE);
process.env.PANEL_SUPERADMIN_HASH = await hashearPassword(CLAVE_ADMIN);
const insertarUsuario = async (usuario: string, tenantId: string, rol: "dueno" | "operador") =>
  (await db.insert(waUsuarios).values({ usuario, passwordHash: hash, tenantId, rol }).returning())[0];
const duenoA = await insertarUsuario("dueno-a", "negocio-a", "dueno");
const operA = await insertarUsuario("oper-a", "negocio-a", "operador");
const operA2 = await insertarUsuario("oper-a2", "negocio-a", "operador");
const duenoB = await insertarUsuario("dueno-b", "negocio-b", "dueno");
await insertarUsuario("dueno-c", "negocio-c", "dueno");

await tenantStore.cargarTenants();

// ── Servidor HTTP real con el wrapper de cabeceras (mismo orden de rutas que server.ts) ──
const servidor = http.createServer(
  conCabecerasSeguridad(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/salud") {
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      res.end("Agente de WhatsApp corriendo ✅");
      return;
    }
    if (manejarLanding(req, res, url.pathname)) return;
    if (await manejarPanel(req, res, repo, url.pathname)) return;
    res.writeHead(404);
    res.end("Not found");
  }),
);
await new Promise<void>((r) => servidor.listen(0, "127.0.0.1", () => r()));
const BASE = `http://127.0.0.1:${(servidor.address() as AddressInfo).port}`;

after(async () => {
  await new Promise<void>((r) => servidor.close(() => r()));
  await cerrar();
});

const cookieDe = (u: { id: string; tenantId: string; rol: string }, epoch = 0) =>
  `panel_sesion=${crearSesion(u.tenantId, u.id, u.rol as "dueno" | "operador", epoch)}`;
const epochDe = async (id: string) => (await db.select().from(waUsuarios).where(eq(waUsuarios.id, id)))[0].sessionEpoch;

/** Llama al router real con un request mínimo; permite fijar la IP del socket y headers extra. */
async function llamar(
  metodo: string,
  path: string,
  opts: { cookie?: string; body?: unknown; ip?: string; headers?: Record<string, string> } = {},
): Promise<{ status: number; json: Record<string, unknown>; headers: Record<string, string> }> {
  const req = Readable.from(opts.body === undefined ? [] : [Buffer.from(JSON.stringify(opts.body))]) as unknown as IncomingMessage & {
    method: string;
  };
  req.method = metodo;
  req.headers = {
    host: "panel.test",
    origin: "https://panel.test",
    ...(opts.cookie ? { cookie: opts.cookie } : {}),
    ...(opts.headers ?? {}),
  };
  Object.defineProperty(req, "socket", { value: { remoteAddress: opts.ip ?? "127.0.0.1" } });
  const salida = { status: 0, body: "", headers: {} as Record<string, string> };
  const res = {
    writeHead(s: number, h?: Record<string, string>) {
      salida.status = s;
      salida.headers = h ?? {};
      return res;
    },
    end(b?: string) {
      salida.body = b ? String(b) : "";
    },
  } as unknown as ServerResponse;
  await manejarPanel(req, res, repo, path);
  return { status: salida.status, json: salida.body ? JSON.parse(salida.body) : {}, headers: salida.headers };
}

/** Suscripción con la forma de `PushSubscription.toJSON()` (llaves con el largo real). */
function suscripcion(endpoint: string) {
  const ecdh = crypto.createECDH("prime256v1");
  ecdh.generateKeys();
  return { endpoint, keys: { p256dh: ecdh.getPublicKey().toString("base64url"), auth: crypto.randomBytes(16).toString("base64url") } };
}
const fcm = (id: string) => `https://fcm.googleapis.com/fcm/send/${id}`;
const subsDe = async (usuarioId: string) => db.select().from(waPushSubs).where(eq(waPushSubs.usuarioId, usuarioId));

// ── (1) Push ─────────────────────────────────────────────────────────────────

test("push/suscribir: endpoint fuera de la allowlist (o no https) → 400, no se guarda", async () => {
  const malos = [
    "http://169.254.169.254/latest/meta-data",
    "http://fcm.googleapis.com/fcm/send/x", // http
    "https://evil.example.com/push",
    "https://fcm.googleapis.com.evil.example.com/x", // sufijo engañoso
    "https://usuario:clave@fcm.googleapis.com/x",
    "https://fcm.googleapis.com:8443/x",
    "https://localhost/x",
    `https://fcm.googleapis.com/${"a".repeat(1100)}`,
  ];
  for (const endpoint of malos) {
    const r = await llamar("POST", "/api/panel/push/suscribir", { cookie: cookieDe(operA), body: suscripcion(endpoint) });
    assert.equal(r.status, 400, endpoint);
  }
  // Llaves con forma inválida también.
  const r = await llamar("POST", "/api/panel/push/suscribir", {
    cookie: cookieDe(operA),
    body: { endpoint: fcm("x"), keys: { p256dh: "corta", auth: "x" } },
  });
  assert.equal(r.status, 400);
  assert.equal((await db.select().from(waPushSubs)).length, 0);
});

test("push/suscribir: hosts reales de push aceptados; la fila queda a nombre del usuario con su epoch", async () => {
  for (const endpoint of [
    fcm("ok-1"),
    "https://web.push.apple.com/QGx1",
    "https://updates.push.services.mozilla.com/wpush/v2/abc",
  ]) {
    const r = await llamar("POST", "/api/panel/push/suscribir", { cookie: cookieDe(operA2), body: suscripcion(endpoint) });
    assert.equal(r.status, 200, endpoint);
  }
  const filas = await subsDe(operA2.id);
  assert.equal(filas.length, 3);
  assert.ok(filas.every((f) => f.tenantId === "negocio-a" && f.sessionEpoch === 0));
  await db.delete(waPushSubs);
});

test("push: tope de suscripciones por usuario (se quedan las más recientes)", async () => {
  for (let i = 1; i <= 5; i++) {
    const r = await llamar("POST", "/api/panel/push/suscribir", { cookie: cookieDe(operA2), body: suscripcion(fcm(`tope-${i}`)) });
    assert.equal(r.status, 200);
  }
  const endpoints = (await subsDe(operA2.id)).map((f) => f.endpoint).sort();
  assert.deepEqual(endpoints, [fcm("tope-3"), fcm("tope-4"), fcm("tope-5")]);
  await db.delete(waPushSubs);
});

test("logout: borra la suscripción de ESE dispositivo (y solo la de ese usuario)", async () => {
  await llamar("POST", "/api/panel/push/suscribir", { cookie: cookieDe(operA), body: suscripcion(fcm("tablet")) });
  await llamar("POST", "/api/panel/push/suscribir", { cookie: cookieDe(operA), body: suscripcion(fcm("celular")) });
  await llamar("POST", "/api/panel/push/suscribir", { cookie: cookieDe(duenoA), body: suscripcion(fcm("dueno")) });
  // Otro usuario no puede borrar la suscripción ajena mandando su endpoint en el logout.
  await llamar("POST", "/api/panel/logout", { cookie: cookieDe(duenoA), body: { endpoint: fcm("tablet") } });
  assert.equal((await subsDe(operA.id)).length, 2);
  const r = await llamar("POST", "/api/panel/logout", { cookie: cookieDe(operA), body: { endpoint: fcm("tablet") } });
  assert.equal(r.status, 200);
  assert.deepEqual((await subsDe(operA.id)).map((f) => f.endpoint), [fcm("celular")]);
  assert.equal((await subsDe(duenoA.id)).length, 1, "las del dueño no se tocan");
  await db.delete(waPushSubs);
});

test("desactivar a un usuario (o cambiarle el rol) borra todas sus suscripciones push", async () => {
  await llamar("POST", "/api/panel/push/suscribir", { cookie: cookieDe(operA), body: suscripcion(fcm("despedido-1")) });
  await llamar("POST", "/api/panel/push/suscribir", { cookie: cookieDe(operA), body: suscripcion(fcm("despedido-2")) });
  await llamar("POST", "/api/panel/push/suscribir", { cookie: cookieDe(operA2), body: suscripcion(fcm("companero")) });
  const r = await llamar("POST", `/api/panel/usuarios/${operA.id}`, { cookie: cookieDe(duenoA), body: { activo: false } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal((await subsDe(operA.id)).length, 0, "el empleado desactivado ya no recibe avisos");
  assert.equal((await subsDe(operA2.id)).length, 1, "el compañero sigue");
  // Reactivarlo no resucita nada; tiene que volver a activar las notificaciones.
  assert.equal((await llamar("POST", `/api/panel/usuarios/${operA.id}`, { cookie: cookieDe(duenoA), body: { activo: true } })).status, 200);
  assert.equal((await subsDe(operA.id)).length, 0);
  // Cambio de rol: mismo criterio.
  const epochA2 = await epochDe(operA2.id);
  assert.equal((await llamar("POST", `/api/panel/usuarios/${operA2.id}`, { cookie: cookieDe(duenoA), body: { rol: "dueno" } })).status, 200);
  assert.equal((await subsDe(operA2.id)).length, 0);
  assert.equal(await epochDe(operA2.id), epochA2 + 1);
  await llamar("POST", `/api/panel/usuarios/${operA2.id}`, { cookie: cookieDe({ ...duenoA }), body: { rol: "operador" } });
  await db.delete(waPushSubs);
});

test("reset de clave desde el admin y cambio de clave propio borran las suscripciones (y el reset queda auditado)", async () => {
  const epoch = await epochDe(operA.id);
  await llamar("POST", "/api/panel/push/suscribir", { cookie: cookieDe(operA, epoch), body: suscripcion(fcm("reset")) });
  assert.equal((await subsDe(operA.id)).length, 1);
  const r = await llamar("POST", `/api/panel/admin/usuarios/${operA.id}/reset-password`, { cookie: `panel_admin_sesion=${crearSesionAdmin()}` });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal((await subsDe(operA.id)).length, 0);
  const [aud] = await db
    .select()
    .from(waAuditoria)
    .where(and(eq(waAuditoria.tenantId, "negocio-a"), eq(waAuditoria.accion, "reset_clave")));
  assert.equal(aud.detalle.usuarioId, operA.id);
  assert.equal(aud.actor, "superadmin:superadmin-test");

  const epochB = await epochDe(duenoB.id);
  await llamar("POST", "/api/panel/push/suscribir", { cookie: cookieDe(duenoB, epochB), body: suscripcion(fcm("propia")) });
  const c = await llamar("POST", "/api/panel/cambiar-clave", {
    cookie: cookieDe(duenoB, epochB),
    body: { claveActual: CLAVE, claveNueva: "otra-clave-larga-456" },
  });
  assert.equal(c.status, 200, JSON.stringify(c.json));
  assert.equal((await subsDe(duenoB.id)).length, 0);
});

test("enviarPushATenant: suscripciones sin usuario (viejas) o con el epoch vencido no reciben y se purgan", async () => {
  const k = suscripcion(fcm("x")).keys;
  await db.insert(waPushSubs).values([
    { tenantId: "negocio-c", endpoint: fcm("legado"), p256dh: k.p256dh, auth: k.auth }, // sin usuario (pre-migración)
  ]);
  const [duenoC] = await db.select().from(waUsuarios).where(eq(waUsuarios.usuario, "dueno-c"));
  await db.insert(waPushSubs).values({
    tenantId: "negocio-c",
    usuarioId: duenoC.id,
    sessionEpoch: duenoC.sessionEpoch + 7, // epoch que ya no es el de la cuenta
    endpoint: fcm("revocada"),
    p256dh: k.p256dh,
    auth: k.auth,
  });
  const r = await enviarPushATenant(repo, "negocio-c", { title: "t", body: "b" });
  assert.deepEqual(r, { enviadas: 0, fallidas: 0 }, "no se le manda nada a nadie");
  assert.equal((await db.select().from(waPushSubs).where(eq(waPushSubs.tenantId, "negocio-c"))).length, 0, "purgadas");
  assert.equal((await db.select().from(waPushSubs).where(isNull(waPushSubs.usuarioId))).length, 0);
});

// ── (2) Cabeceras de seguridad ───────────────────────────────────────────────

async function cabeceras(path: string, headers: Record<string, string> = {}) {
  const r = await fetch(`${BASE}${path}`, { headers });
  await r.arrayBuffer();
  return { status: r.status, h: r.headers };
}

test("cabeceras: nosniff, Referrer-Policy, Permissions-Policy y frame-ancestors en /panel, /api/panel/me, / y /salud", async () => {
  for (const path of ["/panel", "/api/panel/me", "/", "/salud"]) {
    const { h } = await cabeceras(path);
    assert.equal(h.get("x-content-type-options"), "nosniff", path);
    assert.equal(h.get("referrer-policy"), "strict-origin-when-cross-origin", path);
    assert.match(h.get("permissions-policy") ?? "", /camera=\(\)/, path);
    assert.equal(h.get("x-frame-options"), "DENY", path);
    assert.match(h.get("content-security-policy") ?? "", /frame-ancestors 'none'/, path);
    assert.equal(h.get("strict-transport-security"), null, `${path}: sin https no hay HSTS`);
  }
});

test("cabeceras: CSP estricta en el panel (sin inline), relajada solo para el SDK de Meta en /panel/admin", async () => {
  const panel = (await cabeceras("/panel")).h.get("content-security-policy") ?? "";
  assert.match(panel, /default-src 'self'/);
  assert.match(panel, /script-src 'self';/);
  assert.match(panel, /style-src 'self';/);
  assert.match(panel, /connect-src 'self';/);
  assert.match(panel, /img-src 'self' data: blob: https:/);
  assert.doesNotMatch(panel, /unsafe-inline|unsafe-eval|facebook/);
  const admin = (await cabeceras("/panel/admin")).h.get("content-security-policy") ?? "";
  assert.match(admin, /script-src 'self' https:\/\/connect\.facebook\.net/);
  assert.doesNotMatch(admin, /script-src[^;]*unsafe-inline/);
  const api = (await cabeceras("/api/panel/me")).h.get("content-security-policy") ?? "";
  assert.match(api, /default-src 'none'/);
  assert.match((await cabeceras("/salud")).h.get("content-security-policy") ?? "", /default-src 'none'/);
});

test("cabeceras: la landing autoriza SOLO su script inline por hash (sin 'unsafe-inline')", async () => {
  const r = await fetch(`${BASE}/`);
  const html = await r.text();
  const csp = r.headers.get("content-security-policy") ?? "";
  const hashes = hashesScriptsInline(html);
  assert.ok(hashes.length >= 1, "index.html tiene un script inline");
  for (const h of hashes) assert.ok(csp.includes(h), `falta ${h} en la CSP`);
  assert.doesNotMatch(csp, /unsafe-inline/);
});

test("cabeceras: HSTS solo si la request vino por https (X-Forwarded-Proto del proxy) o forzado por env", async () => {
  assert.equal((await cabeceras("/", { "x-forwarded-proto": "https" })).h.get("strict-transport-security"), "max-age=31536000");
  assert.equal((await cabeceras("/salud", { "x-forwarded-proto": "http" })).h.get("strict-transport-security"), null);
  process.env.SEGURIDAD_HSTS = "1";
  assert.equal((await cabeceras("/salud")).h.get("strict-transport-security"), "max-age=31536000");
  process.env.SEGURIDAD_HSTS = "0";
  assert.equal((await cabeceras("/", { "x-forwarded-proto": "https" })).h.get("strict-transport-security"), null);
  delete process.env.SEGURIDAD_HSTS;
});

// ── (3) Rate limit de login ──────────────────────────────────────────────────

const loginMalo = (ip: string, xff: string, usuario = "nadie") =>
  llamar("POST", "/api/panel/login", { ip, headers: { "x-forwarded-for": xff }, body: { usuario, password: "incorrecta" } });

test("rate limit: rotar X-Forwarded-For NO evade el límite por IP (sin TRUST_PROXY se usa el socket)", async () => {
  rateLimit._resetParaTests();
  delete process.env.TRUST_PROXY;
  const estados: number[] = [];
  for (let i = 0; i < 6; i++) estados.push((await loginMalo("203.0.113.77", `10.9.8.${i}`, `u${i}`)).status);
  assert.deepEqual(estados, [401, 401, 401, 401, 429, 429]);
});

test("rate limit: detrás de un proxy de confianza (TRUST_PROXY=loopback) lo falsificado a la izquierda no cuenta", async () => {
  rateLimit._resetParaTests();
  process.env.TRUST_PROXY = "loopback";
  const estados: number[] = [];
  // El proxy local agrega la IP real (203.0.113.88) al final; el atacante rota lo de la izquierda.
  for (let i = 0; i < 6; i++) estados.push((await loginMalo("127.0.0.1", `1.1.1.${i}, 203.0.113.88`, `v${i}`)).status);
  assert.deepEqual(estados, [401, 401, 401, 401, 429, 429]);
  // Otro cliente real detrás del mismo proxy no está afectado.
  assert.equal((await loginMalo("127.0.0.1", "203.0.113.89", "w0")).status, 401);
  delete process.env.TRUST_PROXY;
});

test("lockout por par: 3 fallos de un atacante contra 'dueno-a' no dejan afuera al dueño desde su IP", async () => {
  rateLimit._resetParaTests();
  for (let i = 0; i < 3; i++) assert.equal((await loginMalo("198.51.100.66", "", "dueno-a")).status, 401);
  assert.equal((await loginMalo("198.51.100.66", "", "dueno-a")).status, 429, "el atacante queda frenado");
  const ok = await llamar("POST", "/api/panel/login", { ip: "192.0.2.10", body: { usuario: "dueno-a", password: CLAVE } });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
});

// ── (4) Superadmin: TOTP, sesión, auditoría, export ──────────────────────────

const SECRETO_TOTP = totpMod.codificarBase32(crypto.randomBytes(20));
const codigoAhora = (desfaseMs = 0) => totpMod.totp(totpMod.decodificarBase32(SECRETO_TOTP)!, Date.now() + desfaseMs);
const loginAdmin = (body: Record<string, unknown>, ip = "192.0.2.50") =>
  llamar("POST", "/api/panel/admin/login", { ip, body: { usuario: "superadmin-test", password: CLAVE_ADMIN, ...body } });

test("admin login con TOTP configurado: sin código o con código malo → 401; con código → 200 con sesión corta", async () => {
  rateLimit._resetParaTests();
  totpMod._resetParaTests();
  process.env.PANEL_SUPERADMIN_TOTP_SECRET = SECRETO_TOTP;
  try {
    assert.equal((await loginAdmin({})).status, 401, "sin código");
    assert.equal((await loginAdmin({ codigo: "000000" === codigoAhora() ? "111111" : "000000" })).status, 401, "código malo");
    const ok = await loginAdmin({ codigo: codigoAhora() });
    assert.equal(ok.status, 200, JSON.stringify(ok.json));
    const cookie = ok.headers["set-cookie"];
    const maxAge = Number(/Max-Age=(\d+)/.exec(cookie)?.[1]);
    assert.ok(maxAge > 0 && maxAge <= 12 * 3600, `sesión admin ≤ 12 h (Max-Age=${maxAge})`);
    assert.match(cookie, /HttpOnly; Secure; SameSite=Strict/);
    const sesion = cookie.split(";")[0];
    assert.equal((await llamar("GET", "/api/panel/admin/me", { cookie: sesion })).status, 200);
  } finally {
    delete process.env.PANEL_SUPERADMIN_TOTP_SECRET;
  }
});

test("admin login: anti-replay — el mismo código no sirve dos veces; el siguiente sí", async () => {
  rateLimit._resetParaTests();
  totpMod._resetParaTests();
  process.env.PANEL_SUPERADMIN_TOTP_SECRET = SECRETO_TOTP;
  try {
    const codigo = codigoAhora();
    assert.equal((await loginAdmin({ codigo })).status, 200);
    assert.equal((await loginAdmin({ codigo })).status, 401, "reusado");
    assert.equal((await loginAdmin({ codigo: codigoAhora(30_000) })).status, 200, "código del paso siguiente (ventana +1)");
  } finally {
    delete process.env.PANEL_SUPERADMIN_TOTP_SECRET;
  }
});

test("admin: con TOTP configurado, una sesión abierta SIN 2FA deja de valer; las versiones propias la revocan", async () => {
  const sin2fa = `panel_admin_sesion=${crearSesionAdmin(false)}`;
  const con2fa = `panel_admin_sesion=${crearSesionAdmin(true)}`;
  assert.equal((await llamar("GET", "/api/panel/admin/me", { cookie: sin2fa })).status, 200, "sin TOTP configurado vale");
  process.env.PANEL_SUPERADMIN_TOTP_SECRET = SECRETO_TOTP;
  try {
    assert.equal((await llamar("GET", "/api/panel/admin/me", { cookie: sin2fa })).status, 401);
    assert.equal((await llamar("GET", "/api/panel/admin/me", { cookie: con2fa })).status, 200);
    // Subir PANEL_ADMIN_SESSION_VERSION echa al superadmin sin tocar a los negocios.
    process.env.PANEL_ADMIN_SESSION_VERSION = "2";
    assert.equal((await llamar("GET", "/api/panel/admin/me", { cookie: con2fa })).status, 401);
    assert.equal((await llamar("GET", "/api/panel/me", { cookie: cookieDe(duenoA) })).status, 200);
  } finally {
    delete process.env.PANEL_SUPERADMIN_TOTP_SECRET;
    delete process.env.PANEL_ADMIN_SESSION_VERSION;
  }
});

test("admin: los logins (aceptados y con código rechazado) quedan en wa_auditoria, sin la IP en claro", async () => {
  const filas = await db.select().from(waAuditoria).where(eq(waAuditoria.tenantId, "_plataforma"));
  const acciones = filas.map((f) => f.accion);
  assert.ok(acciones.includes("login_admin"));
  assert.ok(acciones.includes("login_admin_rechazado"));
  const rechazos = filas.filter((f) => f.accion === "login_admin_rechazado").map((f) => f.detalle.motivo);
  assert.ok(rechazos.includes("codigo_reusado"));
  assert.ok(rechazos.includes("codigo_invalido"));
  for (const f of filas) {
    assert.doesNotMatch(JSON.stringify(f.detalle), /192\.0\.2\.50/, "la IP no se guarda en claro");
    assert.match(String(f.detalle.origen), /^[0-9a-f]{12}$/);
  }
});

test("admin: el export de la baja NO trae password_hash ni el token, y queda auditado", async () => {
  const r = await llamar("POST", "/api/panel/admin/tenants/negocio-c/baja", {
    cookie: `panel_admin_sesion=${crearSesionAdmin()}`,
    body: { confirmarNombre: "Negocio negocio-c" },
  });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const exp = r.json.export as Record<string, any>;
  assert.equal(exp.waUsuarios.length, 1);
  assert.equal("passwordHash" in exp.waUsuarios[0], false);
  assert.equal("accessToken" in exp.waTenants, false);
  assert.doesNotMatch(JSON.stringify(exp), /password_?hash|EAAtoken/i);
  const acciones = (await db.select().from(waAuditoria).where(eq(waAuditoria.tenantId, "negocio-c"))).map((f) => f.accion);
  assert.ok(acciones.includes("export_tenant"));
  assert.ok(acciones.includes("baja_tenant"));
});

test("crear usuario con el nombre del superadmin → el mismo 409 que uno existente (no revela que es el admin)", async () => {
  const admin = await llamar("POST", "/api/panel/usuarios", {
    cookie: cookieDe(duenoA),
    body: { usuario: "superadmin-test", password: "12345678", rol: "operador" },
  });
  const existente = await llamar("POST", "/api/panel/usuarios", {
    cookie: cookieDe(duenoA),
    body: { usuario: "dueno-b", password: "12345678", rol: "operador" },
  });
  assert.equal(admin.status, 409);
  assert.deepEqual(admin.json, existente.json);
});
