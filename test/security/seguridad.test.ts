import assert from "node:assert/strict";
import crypto from "node:crypto";
import { test } from "node:test";

// ─────────────────────────────────────────────────────────────────────────────
// Ángulo 8 de TESTING.md — Seguridad (invariantes puros de auth/sesión/firma).
//
// Corre en `npm test` (node:test, sin dependencias). Se enfoca en los invariantes
// de crypto que NINGÚN otro ángulo prueba de forma dedicada:
//   • Sesión firmada (HMAC): un token no se puede forjar ni manipular (rol/tenant/exp).
//   • Login anti-timing: el path de "usuario inexistente" gasta el mismo scrypt.
//   • Firma del webhook de Meta: comparación en tiempo constante, rechaza el impostor.
//
// El aislamiento del token de WhatsApp (que NUNCA vuelve al navegador), el guard CSRF
// y los guards de rol se prueban a nivel HTTP en el E2E del panel (ángulo 6), que ejerce
// el router real. Acá cubrimos la base criptográfica sobre la que se apoyan.
//
// PANEL_SESSION_SECRET se fija ANTES de importar auth.ts (que lo lee en el load): así
// el secreto es estable y determinista, no el aleatorio-por-arranque del modo dev.
// ─────────────────────────────────────────────────────────────────────────────

process.env.PANEL_SESSION_SECRET = "test-security-session-secret-0123456789";
process.env.PANEL_SESSION_VERSION = "1";

// Parámetros del rate limit chicos y deterministas (E6/BLOQUEANTE-10): se fijan ANTES
// de importar rateLimitLogin.ts porque los lee una sola vez, en el load del módulo
// (mismo patrón que PANEL_SESSION_SECRET arriba). `node --test` corre cada archivo de
// test en un proceso aparte, así que esto no afecta a otros tests del repo.
process.env.PANEL_LOGIN_RATE_LIMIT_MAX_IP = "3";
process.env.PANEL_LOGIN_RATE_LIMIT_VENTANA_MS = "200";
process.env.PANEL_LOGIN_LOCKOUT_UMBRAL = "3";
process.env.PANEL_LOGIN_LOCKOUT_BASE_MS = "80";
process.env.PANEL_LOGIN_LOCKOUT_TOPE_MS = "500";

const {
  crearSesion,
  verificarSesion,
  crearSesionAdmin,
  verificarSesionAdmin,
  hashearPassword,
  verificarPassword,
  HASH_DUMMY,
} = await import("../../src/panel/auth");
const { firmaValida } = await import("../../src/whatsapp/client");
const { chequearLimiteLogin, registrarIntentoLogin, registrarFalloLogin, registrarExitoLogin, _resetParaTests } =
  await import("../../src/panel/rateLimitLogin");

const esperar = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ─── Sesión firmada del operador (cookie HMAC, stateless) ───────────────────

test("sesión operador: round-trip devuelve tenantId/usuarioId/rol", () => {
  const token = crearSesion("tenant-x", "usr-1", "dueno");
  assert.deepEqual(verificarSesion(token), { tenantId: "tenant-x", usuarioId: "usr-1", rol: "dueno" });
});

test("sesión operador: token nulo/ausente/basura → null (no lanza)", () => {
  assert.equal(verificarSesion(undefined), null);
  assert.equal(verificarSesion(""), null);
  assert.equal(verificarSesion("no-es-base64url.@@@"), null);
  assert.equal(verificarSesion("aaaa"), null);
});

test("sesión operador: firma alterada → null (no se puede forjar)", () => {
  const token = crearSesion("tenant-x", "usr-1", "operador");
  const crudo = Buffer.from(token, "base64url").toString();
  const partes = crudo.split(".");
  partes[partes.length - 1] = "0".repeat(64); // firma falsa del mismo largo
  const forjado = Buffer.from(partes.join(".")).toString("base64url");
  assert.equal(verificarSesion(forjado), null);
});

test("sesión operador: escalar rol operador→dueno sin re-firmar → null", () => {
  const token = crearSesion("tenant-x", "usr-1", "operador");
  const [tenantId, usuarioId, , exp, ver, firma] = Buffer.from(token, "base64url").toString().split(".");
  // Cambiamos el rol pero conservamos la firma original (firmada sobre "operador").
  const manipulado = Buffer.from(`${tenantId}.${usuarioId}.dueno.${exp}.${ver}.${firma}`).toString("base64url");
  assert.equal(verificarSesion(manipulado), null);
});

test("sesión operador: cambiar tenantId sin re-firmar → null (no cruza tenants)", () => {
  const token = crearSesion("tenant-a", "usr-1", "dueno");
  const [, usuarioId, rol, exp, ver, firma] = Buffer.from(token, "base64url").toString().split(".");
  const manipulado = Buffer.from(`tenant-b.${usuarioId}.${rol}.${exp}.${ver}.${firma}`).toString("base64url");
  assert.equal(verificarSesion(manipulado), null);
});

test("sesión operador: extender el vencimiento sin re-firmar → null", () => {
  const token = crearSesion("tenant-x", "usr-1", "dueno");
  const [tenantId, usuarioId, rol, , ver, firma] = Buffer.from(token, "base64url").toString().split(".");
  const futuro = Date.now() + 999 * 24 * 60 * 60 * 1000;
  const manipulado = Buffer.from(`${tenantId}.${usuarioId}.${rol}.${futuro}.${ver}.${firma}`).toString("base64url");
  assert.equal(verificarSesion(manipulado), null);
});

test("sesión operador: token vencido → null (aunque la firma sea válida)", () => {
  // Firmamos un payload ya vencido con el MISMO secreto (firma legítima, exp en el pasado).
  const exp = Date.now() - 1000;
  const payload = `tenant-x.usr-1.dueno.${exp}.1`;
  const firma = crypto.createHmac("sha256", process.env.PANEL_SESSION_SECRET!).update(payload).digest("hex");
  const token = Buffer.from(`${payload}.${firma}`).toString("base64url");
  assert.equal(verificarSesion(token), null);
});

test("sesión operador: versión distinta invalida (re-login global) → null", () => {
  const token = crearSesion("tenant-x", "usr-1", "dueno");
  const [tenantId, usuarioId, rol, exp, , firma] = Buffer.from(token, "base64url").toString().split(".");
  const otraVer = Buffer.from(`${tenantId}.${usuarioId}.${rol}.${exp}.99.${firma}`).toString("base64url");
  assert.equal(verificarSesion(otraVer), null);
});

// ─── Sesión del superadmin (onboarding) — cookie y marca aparte ─────────────

test("sesión admin: round-trip válido → true; token de operador NO cuela como admin", () => {
  assert.equal(verificarSesionAdmin(crearSesionAdmin()), true);
  // Una sesión de operador (aunque bien firmada) no debe pasar el guard de admin.
  assert.equal(verificarSesionAdmin(crearSesion("tenant-x", "usr-1", "dueno")), false);
  assert.equal(verificarSesionAdmin(undefined), false);
});

test("sesión admin: firma alterada → false", () => {
  const token = crearSesionAdmin();
  const partes = Buffer.from(token, "base64url").toString().split(".");
  partes[partes.length - 1] = "0".repeat(64);
  assert.equal(verificarSesionAdmin(Buffer.from(partes.join(".")).toString("base64url")), false);
});

test("sesión admin: token vencido → false", () => {
  const exp = Date.now() - 1000;
  const payload = `__superadmin__.${exp}.1`;
  const firma = crypto.createHmac("sha256", process.env.PANEL_SESSION_SECRET!).update(payload).digest("hex");
  assert.equal(verificarSesionAdmin(Buffer.from(`${payload}.${firma}`).toString("base64url")), false);
});

// ─── Login: contraseñas y anti-timing ───────────────────────────────────────

test("verificarPassword: acepta la correcta y rechaza la incorrecta", async () => {
  const guardado = await hashearPassword("un-secreto-largo");
  assert.equal(await verificarPassword("un-secreto-largo", guardado), true);
  assert.equal(await verificarPassword("otro", guardado), false);
});

test("verificarPassword: rechaza hash ausente o con formato inválido (sin lanzar)", async () => {
  assert.equal(await verificarPassword("x", undefined), false);
  assert.equal(await verificarPassword("x", ""), false);
  assert.equal(await verificarPassword("x", "sin-dos-puntos"), false);
});

test("hashearPassword: cada hash usa un salt distinto (no determinista)", async () => {
  const a = await hashearPassword("misma-clave");
  const b = await hashearPassword("misma-clave");
  assert.notEqual(a, b); // distinto salt ⇒ distinto hash
  assert.equal(await verificarPassword("misma-clave", a), true);
  assert.equal(await verificarPassword("misma-clave", b), true);
});

test("anti-timing: HASH_DUMMY es un salt:hash válido → el login corre scrypt aunque el usuario no exista", async () => {
  // El router usa HASH_DUMMY cuando el usuario NO existe, para gastar el mismo tiempo de
  // scrypt y no filtrar por timing qué usuarios son válidos. Verificamos que el dummy
  // tenga la forma esperada (salt hex de 16 bytes : hash hex de 64 bytes) y que
  // verificarPassword lo procese (corre scrypt) devolviendo false, no un cortocircuito.
  const [salt, hash] = HASH_DUMMY.split(":");
  assert.equal(salt.length, 32, "salt = 16 bytes en hex");
  assert.equal(hash.length, 128, "hash = 64 bytes en hex");
  assert.equal(await verificarPassword("cualquier-cosa", HASH_DUMMY), false);
});

test("anti-timing: verificarPassword tarda aproximadamente lo mismo con un hash real que con HASH_DUMMY", async () => {
  // No es un benchmark de precisión (CI es ruidoso) — la asimetría que nos importa
  // detectar es GROSERA: si alguien "optimizara" el camino del usuario inexistente para
  // saltarse scrypt (cortocircuito), el dummy tardaría ~0ms contra los ~50-150ms del
  // camino real, una diferencia de órdenes de magnitud. Promediamos varias corridas y
  // toleramos hasta 4x de diferencia en cualquier dirección antes de fallar.
  const guardado = await hashearPassword("un-secreto-largo");
  const REPETICIONES = 5;

  async function tiempoPromedio(hash: string): Promise<number> {
    const inicio = process.hrtime.bigint();
    for (let i = 0; i < REPETICIONES; i++) await verificarPassword("cualquier-cosa", hash);
    return Number(process.hrtime.bigint() - inicio) / REPETICIONES;
  }

  const tReal = await tiempoPromedio(guardado);
  const tDummy = await tiempoPromedio(HASH_DUMMY);
  const razon = Math.max(tReal, tDummy) / Math.max(1, Math.min(tReal, tDummy));
  assert.ok(razon < 4, `tiempos muy distintos (real=${tReal}ns, dummy=${tDummy}ns, razón=${razon}) — ¿se saltó scrypt?`);
});

// ─── Rate limit de login (E6 / BLOQUEANTE-10) ───────────────────────────────

test("rate limit por IP: corta tras el tope de intentos y libera pasada la ventana", async () => {
  _resetParaTests();
  const ip = "203.0.113.10";

  // Los primeros MAX_IP (3, fijado arriba) intentos pasan el chequeo.
  for (let i = 0; i < 3; i++) {
    const r = chequearLimiteLogin(ip, "login", "cualquiera");
    assert.equal(r.permitido, true, `intento ${i + 1} debería pasar`);
    registrarIntentoLogin(ip);
  }

  // El siguiente, dentro de la misma ventana, se corta ANTES de tocar scrypt.
  const bloqueado = chequearLimiteLogin(ip, "login", "cualquiera");
  assert.equal(bloqueado.permitido, false);
  if (!bloqueado.permitido) assert.ok(bloqueado.retryAfterSeg >= 1);

  // Pasada la ventana (200ms), el mismo IP vuelve a poder intentar.
  await esperar(250);
  assert.equal(chequearLimiteLogin(ip, "login", "cualquiera").permitido, true);
});

test("lockout por usuario: fallos consecutivos bloquean SOLO a ese usuario, no a otros", async () => {
  _resetParaTests();
  const ip = "203.0.113.20"; // distinta del test de arriba: no queremos que el límite de IP interfiera acá

  for (let i = 0; i < 3; i++) registrarFalloLogin("login", "usuario-atacado");

  const bloqueado = chequearLimiteLogin(ip, "login", "usuario-atacado");
  assert.equal(bloqueado.permitido, false);
  if (!bloqueado.permitido) assert.ok(bloqueado.retryAfterSeg >= 1);

  // Un usuario DISTINTO, mismo IP, no hereda el lockout (aislamiento por cuenta).
  assert.equal(chequearLimiteLogin(ip, "login", "otro-usuario").permitido, true);
});

test("lockout por usuario: no es un baneo permanente — se libera pasado el backoff", async () => {
  _resetParaTests();
  const ip = "203.0.113.30";
  for (let i = 0; i < 3; i++) registrarFalloLogin("login", "dueno-con-typo");
  assert.equal(chequearLimiteLogin(ip, "login", "dueno-con-typo").permitido, false);

  // BASE_MS=80 fijado arriba: pasado ese tiempo, el dueño que se equivocó de clave
  // puede volver a intentar solo (no necesita que un admin lo desbloquee a mano).
  await esperar(120);
  assert.equal(chequearLimiteLogin(ip, "login", "dueno-con-typo").permitido, true);
});

test("login correcto perdona los fallos previos de ese usuario", async () => {
  _resetParaTests();
  const ip = "203.0.113.40";
  // Dos fallos (por debajo del umbral de 3) y un login correcto en el medio.
  registrarFalloLogin("login", "usuario-normal");
  registrarFalloLogin("login", "usuario-normal");
  registrarExitoLogin("login", "usuario-normal");

  // Si el éxito no hubiera reseteado el contador, UN fallo más alcanzaría el umbral (3)
  // y bloquearía. Como sí resetea, hace falta volver a acumular 3 fallos desde cero.
  registrarFalloLogin("login", "usuario-normal");
  assert.equal(chequearLimiteLogin(ip, "login", "usuario-normal").permitido, true, "1 fallo tras el reset no debería bloquear");
});

test("lockout por usuario: el 429 no distingue cuenta real de inventada (no es oráculo de existencia)", async () => {
  // Punto central de E6: si esta capa SOLO trackeara usuarios que existen de verdad,
  // el propio 429 filtraría qué usuarios son válidos (justo lo que HASH_DUMMY existe
  // para evitar en el chequeo de contraseña). La clave del mapa es el string crudo,
  // sin consultar el tenantStore, así que "existe" e "inventado" se comportan IGUAL.
  _resetParaTests();
  const ip = "203.0.113.50";
  for (let i = 0; i < 3; i++) registrarFalloLogin("login", "cuenta-real-que-existe");
  for (let i = 0; i < 3; i++) registrarFalloLogin("login", "cuenta-que-nunca-existio");

  const real = chequearLimiteLogin(ip, "login", "cuenta-real-que-existe");
  const inventada = chequearLimiteLogin(ip, "login", "cuenta-que-nunca-existio");
  assert.equal(real.permitido, false);
  assert.equal(inventada.permitido, false);
});

test("rate limit: los ámbitos 'login' y 'admin' no comparten lockout de usuario", async () => {
  _resetParaTests();
  const ip = "203.0.113.60";
  for (let i = 0; i < 3; i++) registrarFalloLogin("login", "mismo-nombre");
  assert.equal(chequearLimiteLogin(ip, "login", "mismo-nombre").permitido, false);
  // El superadmin usa el ámbito "admin": aunque coincida el string, es un namespace distinto.
  assert.equal(chequearLimiteLogin(ip, "admin", "mismo-nombre").permitido, true);
});

// ─── Firma del webhook de Meta (HMAC-SHA256, tiempo constante) ──────────────

test("firmaValida: acepta la firma legítima y rechaza la del impostor", () => {
  process.env.WHATSAPP_APP_SECRET = "secreto-de-la-app";
  const body = '{"evento":"mensaje"}';
  const firma = "sha256=" + crypto.createHmac("sha256", "secreto-de-la-app").update(body).digest("hex");
  assert.equal(firmaValida(body, firma), true);

  // Firmado con OTRO secreto (atacante que no conoce WHATSAPP_APP_SECRET) → rechazado.
  const impostor = "sha256=" + crypto.createHmac("sha256", "secreto-equivocado").update(body).digest("hex");
  assert.equal(firmaValida(body, impostor), false);
});

test("firmaValida: rechaza firma ausente, vacía o mal formada", () => {
  process.env.WHATSAPP_APP_SECRET = "secreto-de-la-app";
  assert.equal(firmaValida("{}", null), false);
  assert.equal(firmaValida("{}", undefined as unknown as null), false);
  assert.equal(firmaValida("{}", ""), false);
  assert.equal(firmaValida("{}", "sha256=deadbeef"), false); // largo distinto
  assert.equal(firmaValida("{}", "md5=loquesea"), false); // prefijo inesperado
});
