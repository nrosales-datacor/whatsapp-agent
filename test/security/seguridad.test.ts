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

// ─── Sesión firmada del operador (cookie HMAC, stateless) ───────────────────

test("sesión operador: round-trip devuelve tenantId/usuarioId/rol/epoch", () => {
  const token = crearSesion("tenant-x", "usr-1", "dueno", 0);
  assert.deepEqual(verificarSesion(token), { tenantId: "tenant-x", usuarioId: "usr-1", rol: "dueno", epoch: 0 });
});

test("sesión operador: el epoch viaja tal cual (E13/ALTO-06) — no solo 0", () => {
  const token = crearSesion("tenant-x", "usr-1", "operador", 7);
  assert.deepEqual(verificarSesion(token), { tenantId: "tenant-x", usuarioId: "usr-1", rol: "operador", epoch: 7 });
});

test("sesión operador: token nulo/ausente/basura → null (no lanza)", () => {
  assert.equal(verificarSesion(undefined), null);
  assert.equal(verificarSesion(""), null);
  assert.equal(verificarSesion("no-es-base64url.@@@"), null);
  assert.equal(verificarSesion("aaaa"), null);
});

test("sesión operador: firma alterada → null (no se puede forjar)", () => {
  const token = crearSesion("tenant-x", "usr-1", "operador", 0);
  const crudo = Buffer.from(token, "base64url").toString();
  const partes = crudo.split(".");
  partes[partes.length - 1] = "0".repeat(64); // firma falsa del mismo largo
  const forjado = Buffer.from(partes.join(".")).toString("base64url");
  assert.equal(verificarSesion(forjado), null);
});

test("sesión operador: escalar rol operador→dueno sin re-firmar → null", () => {
  const token = crearSesion("tenant-x", "usr-1", "operador", 0);
  const [tenantId, usuarioId, , epoch, exp, ver, firma] = Buffer.from(token, "base64url").toString().split(".");
  // Cambiamos el rol pero conservamos la firma original (firmada sobre "operador").
  const manipulado = Buffer.from(`${tenantId}.${usuarioId}.dueno.${epoch}.${exp}.${ver}.${firma}`).toString("base64url");
  assert.equal(verificarSesion(manipulado), null);
});

test("sesión operador: cambiar tenantId sin re-firmar → null (no cruza tenants)", () => {
  const token = crearSesion("tenant-a", "usr-1", "dueno", 0);
  const [, usuarioId, rol, epoch, exp, ver, firma] = Buffer.from(token, "base64url").toString().split(".");
  const manipulado = Buffer.from(`tenant-b.${usuarioId}.${rol}.${epoch}.${exp}.${ver}.${firma}`).toString("base64url");
  assert.equal(verificarSesion(manipulado), null);
});

test("sesión operador: extender el vencimiento sin re-firmar → null", () => {
  const token = crearSesion("tenant-x", "usr-1", "dueno", 0);
  const [tenantId, usuarioId, rol, epoch, , ver, firma] = Buffer.from(token, "base64url").toString().split(".");
  const futuro = Date.now() + 999 * 24 * 60 * 60 * 1000;
  const manipulado = Buffer.from(`${tenantId}.${usuarioId}.${rol}.${epoch}.${futuro}.${ver}.${firma}`).toString("base64url");
  assert.equal(verificarSesion(manipulado), null);
});

test("sesión operador: token vencido → null (aunque la firma sea válida)", () => {
  // Firmamos un payload ya vencido con el MISMO secreto (firma legítima, exp en el pasado).
  const exp = Date.now() - 1000;
  const payload = `tenant-x.usr-1.dueno.0.${exp}.1`;
  const firma = crypto.createHmac("sha256", process.env.PANEL_SESSION_SECRET!).update(payload).digest("hex");
  const token = Buffer.from(`${payload}.${firma}`).toString("base64url");
  assert.equal(verificarSesion(token), null);
});

test("sesión operador: versión distinta invalida (re-login global) → null", () => {
  const token = crearSesion("tenant-x", "usr-1", "dueno", 0);
  const [tenantId, usuarioId, rol, epoch, exp, , firma] = Buffer.from(token, "base64url").toString().split(".");
  const otraVer = Buffer.from(`${tenantId}.${usuarioId}.${rol}.${epoch}.${exp}.99.${firma}`).toString("base64url");
  assert.equal(verificarSesion(otraVer), null);
});

// ─── Epoch de sesión (E13/ALTO-06) — revocación de sesiones puntuales ───────
// `verificarSesion` en sí NO conoce el epoch "vigente" de la cuenta (eso lo compara
// `sesionDeOperador`, ver test/security/sesionEpoch.test.ts) — lo que se prueba acá es
// que el epoch viaja protegido por la firma, igual que rol/tenantId/exp: no se puede
// "revivir" un token viejo subiéndole el epoch a mano sin re-firmar.

test("sesión operador: subir el epoch sin re-firmar → null (no se puede forjar la revocación)", () => {
  const token = crearSesion("tenant-x", "usr-1", "dueno", 0);
  const [tenantId, usuarioId, rol, , exp, ver, firma] = Buffer.from(token, "base64url").toString().split(".");
  // Alguien con el token viejo (epoch 0) intenta pasar por el epoch nuevo (1) sin la firma.
  const manipulado = Buffer.from(`${tenantId}.${usuarioId}.${rol}.1.${exp}.${ver}.${firma}`).toString("base64url");
  assert.equal(verificarSesion(manipulado), null);
});

test("sesión operador: epoch no numérico o negativo → null (corrupto, no lanza)", () => {
  const token = crearSesion("tenant-x", "usr-1", "dueno", 0);
  const [tenantId, usuarioId, rol, , exp, ver] = Buffer.from(token, "base64url").toString().split(".");
  for (const epochCorrupto of ["abc", "-1", "1.5", ""]) {
    const payload = `${tenantId}.${usuarioId}.${rol}.${epochCorrupto}.${exp}.${ver}`;
    const firma = crypto.createHmac("sha256", process.env.PANEL_SESSION_SECRET!).update(payload).digest("hex");
    const t = Buffer.from(`${payload}.${firma}`).toString("base64url");
    assert.equal(verificarSesion(t), null, `epoch "${epochCorrupto}" debería rechazarse`);
  }
});

// ─── Sesión del superadmin (onboarding) — cookie y marca aparte ─────────────

test("sesión admin: round-trip válido → true; token de operador NO cuela como admin", () => {
  assert.equal(verificarSesionAdmin(crearSesionAdmin()), true);
  // Una sesión de operador (aunque bien firmada) no debe pasar el guard de admin.
  assert.equal(verificarSesionAdmin(crearSesion("tenant-x", "usr-1", "dueno", 0)), false);
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

test("verificarPassword: acepta la correcta y rechaza la incorrecta", () => {
  const guardado = hashearPassword("un-secreto-largo");
  assert.equal(verificarPassword("un-secreto-largo", guardado), true);
  assert.equal(verificarPassword("otro", guardado), false);
});

test("verificarPassword: rechaza hash ausente o con formato inválido (sin lanzar)", () => {
  assert.equal(verificarPassword("x", undefined), false);
  assert.equal(verificarPassword("x", ""), false);
  assert.equal(verificarPassword("x", "sin-dos-puntos"), false);
});

test("hashearPassword: cada hash usa un salt distinto (no determinista)", () => {
  const a = hashearPassword("misma-clave");
  const b = hashearPassword("misma-clave");
  assert.notEqual(a, b); // distinto salt ⇒ distinto hash
  assert.equal(verificarPassword("misma-clave", a), true);
  assert.equal(verificarPassword("misma-clave", b), true);
});

test("anti-timing: HASH_DUMMY es un salt:hash válido → el login corre scrypt aunque el usuario no exista", () => {
  // El router usa HASH_DUMMY cuando el usuario NO existe, para gastar el mismo tiempo de
  // scrypt y no filtrar por timing qué usuarios son válidos. Verificamos que el dummy
  // tenga la forma esperada (salt hex de 16 bytes : hash hex de 64 bytes) y que
  // verificarPassword lo procese (corre scrypt) devolviendo false, no un cortocircuito.
  const [salt, hash] = HASH_DUMMY.split(":");
  assert.equal(salt.length, 32, "salt = 16 bytes en hex");
  assert.equal(hash.length, 128, "hash = 64 bytes en hex");
  assert.equal(verificarPassword("cualquier-cosa", HASH_DUMMY), false);
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
