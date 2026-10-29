import assert from "node:assert/strict";
import crypto from "node:crypto";
import { test } from "node:test";

// ─────────────────────────────────────────────────────────────────────────────
// Invariantes de auth (src/platform/auth): sesión firmada, contraseñas scrypt con
// anti-timing y rate limit de login.
//   • Sesión firmada (HMAC): un token no se puede forjar ni manipular (negocio/usuario/exp/epoch).
//   • Login anti-timing: el camino de "usuario inexistente" gasta el mismo scrypt.
//   • Rate limit: por IP, por par (IP, usuario) y global por usuario, sin ser oráculo.
//
// PANEL_SESSION_SECRET se fija ANTES de importar sessionToken.ts (que lo lee en el load):
// así el secreto es estable y determinista, no el aleatorio-por-arranque del modo dev.
// ─────────────────────────────────────────────────────────────────────────────

process.env.PANEL_SESSION_SECRET = "test-security-session-secret-0123456789";
process.env.PANEL_SESSION_VERSION = "1";

// Parámetros del rate limit chicos y deterministas: se fijan ANTES de importar
// loginRateLimit.ts porque los lee una sola vez, en el load del módulo. `node --test`
// corre cada archivo en un proceso aparte, así que esto no afecta a otros tests.
process.env.PANEL_LOGIN_RATE_LIMIT_MAX_IP = "3";
process.env.PANEL_LOGIN_RATE_LIMIT_WINDOW_MS = "200";
process.env.PANEL_LOGIN_LOCKOUT_THRESHOLD = "3";
process.env.PANEL_LOGIN_LOCKOUT_BASE_MS = "80";
process.env.PANEL_LOGIN_LOCKOUT_MAX_MS = "500";
// Freno global por usuario (fuerza bruta distribuida): umbral más alto que el del par.
process.env.PANEL_LOGIN_LOCKOUT_GLOBAL_THRESHOLD = "6";
process.env.PANEL_LOGIN_LOCKOUT_GLOBAL_BASE_MS = "80";

const { createSessionToken, verifySessionToken, createAdminSession, verifyAdminSession } = await import(
  "../../src/platform/auth/sessionToken"
);
const { hashPassword, verifyPassword, DUMMY_HASH, generateTemporaryPassword } = await import("../../src/platform/auth/password");
const { checkLoginLimit, recordLoginAttempt, recordLoginFailure, recordLoginSuccess, _resetForTests } = await import(
  "../../src/platform/auth/loginRateLimit"
);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const decode = (token: string) => Buffer.from(token, "base64url").toString().split(".");
const encode = (parts: string[]) => Buffer.from(parts.join(".")).toString("base64url");
const signWithTestSecret = (payload: string) =>
  crypto.createHmac("sha256", process.env.PANEL_SESSION_SECRET!).update(payload).digest("hex");

const BUSINESS_A = "0b8f8a8e-1f3c-4e0e-9f61-6c4c7d0c0a01";
const BUSINESS_B = "5d2e7c1a-9b3f-4a7d-8e21-1a2b3c4d5e6f";
const USER_1 = "9c1d2e3f-4a5b-4c6d-8e7f-001122334455";
const USER_2 = "1f2e3d4c-5b6a-4987-8a6b-554433221100";

const token = (sessionEpoch = 0, businessId = BUSINESS_A, userId = USER_1) =>
  createSessionToken({ businessId, userId, sessionEpoch });

// ─── Sesión firmada (cookie HMAC, stateless) ────────────────────────────────
// Formato: "u1.<negocio>.<usuario>.<epoch>.<vence>.<versión>.<firma>". El rol NO viaja:
// lo lee de la membresía viva quien valida la sesión contra la base.

test("sesión: round-trip devuelve negocio, usuario y epoch", () => {
  assert.deepEqual(verifySessionToken(token(0)), { businessId: BUSINESS_A, userId: USER_1, sessionEpoch: 0 });
});

test("sesión: el epoch viaja tal cual — no solo 0", () => {
  assert.deepEqual(verifySessionToken(token(7)), { businessId: BUSINESS_A, userId: USER_1, sessionEpoch: 7 });
});

test("sesión: crear un token con ids que no son uuid o epoch negativo → lanza (no firma basura)", () => {
  assert.throws(() => createSessionToken({ businessId: "negocio-a", userId: USER_1, sessionEpoch: 0 }));
  assert.throws(() => createSessionToken({ businessId: BUSINESS_A, userId: "usr-1", sessionEpoch: 0 }));
  assert.throws(() => createSessionToken({ businessId: BUSINESS_A, userId: USER_1, sessionEpoch: -1 }));
});

test("sesión: token nulo/ausente/basura → null (no lanza)", () => {
  assert.equal(verifySessionToken(undefined), null);
  assert.equal(verifySessionToken(""), null);
  assert.equal(verifySessionToken("no-es-base64url.@@@"), null);
  assert.equal(verifySessionToken("aaaa"), null);
});

test("sesión: firma alterada → null (no se puede forjar)", () => {
  const parts = decode(token());
  parts[parts.length - 1] = "0".repeat(64); // firma falsa del mismo largo
  assert.equal(verifySessionToken(encode(parts)), null);
});

test("sesión: cambiar el negocio sin re-firmar → null (no cruza negocios)", () => {
  const [marker, , userId, epoch, exp, ver, sig] = decode(token());
  assert.equal(verifySessionToken(encode([marker, BUSINESS_B, userId, epoch, exp, ver, sig])), null);
});

test("sesión: cambiar el usuario sin re-firmar → null (no se suplanta a otro)", () => {
  const [marker, businessId, , epoch, exp, ver, sig] = decode(token());
  assert.equal(verifySessionToken(encode([marker, businessId, USER_2, epoch, exp, ver, sig])), null);
});

test("sesión: extender el vencimiento sin re-firmar → null", () => {
  const [marker, businessId, userId, epoch, , ver, sig] = decode(token());
  const future = String(Date.now() + 999 * 24 * 60 * 60 * 1000);
  assert.equal(verifySessionToken(encode([marker, businessId, userId, epoch, future, ver, sig])), null);
});

test("sesión: token vencido → null (aunque la firma sea válida)", () => {
  const payload = `u1.${BUSINESS_A}.${USER_1}.0.${Date.now() - 1000}.1`;
  assert.equal(verifySessionToken(encode([payload, signWithTestSecret(payload)])), null);
});

test("sesión: versión distinta invalida (re-login global) → null", () => {
  const [marker, businessId, userId, epoch, exp, , sig] = decode(token());
  assert.equal(verifySessionToken(encode([marker, businessId, userId, epoch, exp, "99", sig])), null);
});

test("sesión: el formato viejo (con el rol adentro), aun bien firmado, → null", () => {
  const payload = `${BUSINESS_A}.${USER_1}.owner.0.${Date.now() + 60_000}.1`;
  assert.equal(verifySessionToken(encode([payload, signWithTestSecret(payload)])), null);
});

test("sesión: ids que no son uuid, aun bien firmados, → null", () => {
  const payload = `u1.negocio-a.${USER_1}.0.${Date.now() + 60_000}.1`;
  assert.equal(verifySessionToken(encode([payload, signWithTestSecret(payload)])), null);
});

// Revocación: verifySessionToken NO conoce el epoch "vigente" de la cuenta (eso lo compara
// quien valida la sesión contra la base); lo que se prueba acá es que el epoch viaja
// protegido por la firma: no se puede "revivir" un token viejo subiéndole el epoch a mano.
test("sesión: subir el epoch sin re-firmar → null (no se puede forjar la revocación)", () => {
  const [marker, businessId, userId, , exp, ver, sig] = decode(token(0));
  assert.equal(verifySessionToken(encode([marker, businessId, userId, "1", exp, ver, sig])), null);
});

test("sesión: epoch no numérico o negativo → null (corrupto, no lanza)", () => {
  const [marker, businessId, userId, , exp, ver] = decode(token());
  for (const badEpoch of ["abc", "-1", "1.5", ""]) {
    const payload = `${marker}.${businessId}.${userId}.${badEpoch}.${exp}.${ver}`;
    assert.equal(verifySessionToken(encode([payload, signWithTestSecret(payload)])), null, `epoch "${badEpoch}" debería rechazarse`);
  }
});

// ─── Sesión del superadmin — cookie y marca aparte ──────────────────────────

test("sesión admin: round-trip válido → true; una sesión del equipo NO cuela como admin (ni al revés)", () => {
  assert.equal(verifyAdminSession(createAdminSession()), true);
  assert.equal(verifyAdminSession(token()), false);
  assert.equal(verifySessionToken(createAdminSession()), null);
  assert.equal(verifyAdminSession(undefined), false);
});

test("sesión admin: firma alterada → false", () => {
  const parts = decode(createAdminSession());
  parts[parts.length - 1] = "0".repeat(64);
  assert.equal(verifyAdminSession(encode(parts)), false);
});

test("sesión admin: token vencido → false", () => {
  const payload = `__superadmin__.${Date.now() - 1000}.1.1.0`;
  assert.equal(verifyAdminSession(encode([payload, signWithTestSecret(payload)])), false);
});

test("sesión admin: con TOTP configurado, una sesión abierta SIN 2FA deja de valer", () => {
  const withoutMfa = createAdminSession(false);
  const withMfa = createAdminSession(true);
  process.env.PANEL_SUPERADMIN_TOTP_SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
  try {
    assert.equal(verifyAdminSession(withoutMfa), false);
    assert.equal(verifyAdminSession(withMfa), true);
  } finally {
    delete process.env.PANEL_SUPERADMIN_TOTP_SECRET;
  }
});

// ─── Contraseñas y anti-timing ──────────────────────────────────────────────

test("verifyPassword: acepta la correcta y rechaza la incorrecta", async () => {
  const stored = await hashPassword("un-secreto-largo");
  assert.equal(await verifyPassword("un-secreto-largo", stored), true);
  assert.equal(await verifyPassword("otro", stored), false);
});

test("verifyPassword: rechaza hash ausente o con formato inválido (sin lanzar)", async () => {
  assert.equal(await verifyPassword("x", undefined), false);
  assert.equal(await verifyPassword("x", ""), false);
  assert.equal(await verifyPassword("x", "sin-dos-puntos"), false);
});

test("hashPassword: cada hash usa un salt distinto (no determinista)", async () => {
  const a = await hashPassword("misma-clave");
  const b = await hashPassword("misma-clave");
  assert.notEqual(a, b); // distinto salt ⇒ distinto hash
  assert.equal(await verifyPassword("misma-clave", a), true);
  assert.equal(await verifyPassword("misma-clave", b), true);
});

test("generateTemporaryPassword: 12 caracteres sin ambiguos (0/O, 1/l/I)", () => {
  for (let i = 0; i < 20; i++) {
    const p = generateTemporaryPassword();
    assert.equal(p.length, 12);
    assert.doesNotMatch(p, /[0O1lI]/);
  }
});

test("anti-timing: DUMMY_HASH es un salt:hash válido → el login corre scrypt aunque el usuario no exista", async () => {
  // Quien valida el login usa DUMMY_HASH cuando el usuario NO existe, para gastar el mismo
  // tiempo de scrypt y no filtrar por timing qué usuarios son válidos.
  const [salt, hash] = DUMMY_HASH.split(":");
  assert.equal(salt.length, 32, "salt = 16 bytes en hex");
  assert.equal(hash.length, 128, "hash = 64 bytes en hex");
  assert.equal(await verifyPassword("cualquier-cosa", DUMMY_HASH), false);
});

test("anti-timing: verifyPassword tarda aproximadamente lo mismo con un hash real que con DUMMY_HASH", async () => {
  // No es un benchmark de precisión (CI es ruidoso): la asimetría que importa detectar es
  // GROSERA (un cortocircuito tardaría ~0 ms contra ~50-150 ms). Se promedian varias
  // corridas y se toleran hasta 4x de diferencia en cualquier dirección.
  const stored = await hashPassword("un-secreto-largo");
  const REPETITIONS = 5;

  async function averageNs(hash: string): Promise<number> {
    const start = process.hrtime.bigint();
    for (let i = 0; i < REPETITIONS; i++) await verifyPassword("cualquier-cosa", hash);
    return Number(process.hrtime.bigint() - start) / REPETITIONS;
  }

  const tReal = await averageNs(stored);
  const tDummy = await averageNs(DUMMY_HASH);
  const ratio = Math.max(tReal, tDummy) / Math.max(1, Math.min(tReal, tDummy));
  assert.ok(ratio < 4, `tiempos muy distintos (real=${tReal}ns, dummy=${tDummy}ns, razón=${ratio}) — ¿se saltó scrypt?`);
});

// ─── Rate limit de login ────────────────────────────────────────────────────

test("rate limit por IP: corta tras el tope de intentos y libera pasada la ventana", async () => {
  _resetForTests();
  const ip = "203.0.113.10";
  for (let i = 0; i < 3; i++) {
    assert.equal(checkLoginLimit(ip, "login", "cualquiera").allowed, true, `intento ${i + 1} debería pasar`);
    recordLoginAttempt(ip);
  }
  // El siguiente, dentro de la misma ventana, se corta ANTES de tocar scrypt.
  const blocked = checkLoginLimit(ip, "login", "cualquiera");
  assert.equal(blocked.allowed, false);
  if (!blocked.allowed) assert.ok(blocked.retryAfterSec >= 1);
  // Pasada la ventana (200 ms), la misma IP vuelve a poder intentar.
  await sleep(250);
  assert.equal(checkLoginLimit(ip, "login", "cualquiera").allowed, true);
});

test("lockout por par (IP, usuario): bloquea a quien falla, no a otros usuarios ni al mismo usuario desde otra IP", () => {
  _resetForTests();
  const ip = "203.0.113.20";
  for (let i = 0; i < 3; i++) recordLoginFailure(ip, "login", "usuario-atacado");

  const blocked = checkLoginLimit(ip, "login", "usuario-atacado");
  assert.equal(blocked.allowed, false);
  if (!blocked.allowed) assert.ok(blocked.retryAfterSec >= 1);
  // Un usuario DISTINTO, misma IP, no hereda el lockout.
  assert.equal(checkLoginLimit(ip, "login", "otro-usuario").allowed, true);
  // El MISMO usuario desde otra IP (el dueño real) tampoco.
  assert.equal(checkLoginLimit("198.51.100.7", "login", "usuario-atacado").allowed, true);
});

test("lockout por par: no es un baneo permanente — se libera pasado el backoff", async () => {
  _resetForTests();
  const ip = "203.0.113.30";
  for (let i = 0; i < 3; i++) recordLoginFailure(ip, "login", "dueno-con-typo");
  assert.equal(checkLoginLimit(ip, "login", "dueno-con-typo").allowed, false);
  await sleep(120); // BASE_MS = 80 fijado arriba
  assert.equal(checkLoginLimit(ip, "login", "dueno-con-typo").allowed, true);
});

test("login correcto perdona los fallos previos de ese par", () => {
  _resetForTests();
  const ip = "203.0.113.40";
  recordLoginFailure(ip, "login", "usuario-normal");
  recordLoginFailure(ip, "login", "usuario-normal");
  recordLoginSuccess(ip, "login", "usuario-normal");
  // Sin el reset, UN fallo más alcanzaría el umbral (3) y bloquearía.
  recordLoginFailure(ip, "login", "usuario-normal");
  assert.equal(checkLoginLimit(ip, "login", "usuario-normal").allowed, true, "1 fallo tras el reset no debería bloquear");
});

test("lockout: el 429 no distingue cuenta real de inventada (no es oráculo de existencia)", () => {
  _resetForTests();
  const ip = "203.0.113.50";
  for (let i = 0; i < 3; i++) recordLoginFailure(ip, "login", "cuenta-real-que-existe");
  for (let i = 0; i < 3; i++) recordLoginFailure(ip, "login", "cuenta-que-nunca-existio");
  assert.equal(checkLoginLimit(ip, "login", "cuenta-real-que-existe").allowed, false);
  assert.equal(checkLoginLimit(ip, "login", "cuenta-que-nunca-existio").allowed, false);
});

test("rate limit: los ámbitos 'login' y 'admin' no comparten lockout de usuario", () => {
  _resetForTests();
  const ip = "203.0.113.60";
  for (let i = 0; i < 3; i++) recordLoginFailure(ip, "login", "mismo-nombre");
  assert.equal(checkLoginLimit(ip, "login", "mismo-nombre").allowed, false);
  assert.equal(checkLoginLimit(ip, "admin", "mismo-nombre").allowed, true);
});

test("freno global por usuario: fuerza bruta DISTRIBUIDA (muchas IPs) se corta, pero no a una IP conocida del dueño", async () => {
  _resetForTests();
  // El dueño ya entró bien desde su IP de siempre.
  recordLoginSuccess("192.0.2.1", "login", "cuenta-codiciada");
  // Un atacante reparte 6 fallos (umbral global) entre 6 IPs, 1 por IP: ninguna llega al
  // umbral por par (3), pero el total sí dispara el freno global.
  for (let i = 0; i < 6; i++) recordLoginFailure(`198.51.100.${10 + i}`, "login", "cuenta-codiciada");
  assert.equal(checkLoginLimit("198.51.100.99", "login", "cuenta-codiciada").allowed, false, "IP nueva: frenada");
  assert.equal(checkLoginLimit("192.0.2.1", "login", "cuenta-codiciada").allowed, true, "IP conocida del dueño: pasa");
  await sleep(120);
  assert.equal(checkLoginLimit("198.51.100.99", "login", "cuenta-codiciada").allowed, true);
});
