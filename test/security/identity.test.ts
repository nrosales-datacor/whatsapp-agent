import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { eq } from "drizzle-orm";

// ─────────────────────────────────────────────────────────────────────────────
// Identidad de punta a punta por HTTP (I0.6), con la app real (createAppHandler) sobre
// PGlite corriendo como el rol de la app (`app_runtime`, SIN BYPASSRLS): login, 2FA, rate
// limit, revocación por epoch, cambio de negocio, acceso por sucursal, gestión del equipo
// y aislamiento entre negocios.
//
// La env se fija ANTES de importar la app: el rate limit y el secreto de sesión se leen al
// cargar sus módulos. Cada `Browser` tiene su propia IP (X-Forwarded-For con
// TRUST_PROXY=loopback): el rate limit de un test no frena a otro.
// ─────────────────────────────────────────────────────────────────────────────

process.env.TRUST_PROXY = "loopback";
process.env.PANEL_SESSION_SECRET = "test-identity-session-secret-0123456789";
process.env.TOKENS_ENCRYPTION_KEY = "b".repeat(64);
process.env.PANEL_LOGIN_RATE_LIMIT_MAX_IP = "200";
process.env.PANEL_LOGIN_LOCKOUT_THRESHOLD = "5";

const { createAppHandler } = await import("../../src/app");
const { createSessionResolver } = await import("../../src/modules/team");
const { MODULES: ALL_MODULES } = await import("../../src/modules/billing");
const { createRouter, route } = await import("../../src/platform/http/router");
const { decodeBase32, totp, _resetForTests: resetTotpReplay } = await import("../../src/platform/auth/totp");
const { withTenant } = await import("../../src/platform/db/scope");
const { memberships, users } = await import("../../src/modules/team/schema");
const { createEphemeralDb } = await import("../helpers/pgliteDb");
const { Browser, startTestServer } = await import("../helpers/panelClient");
const { addTestMembership, createTestBusiness, createTestMember, createTestUser, uniqueEmail } = await import("../helpers/identityFixtures");

type TestServer = Awaited<ReturnType<typeof startTestServer>>;

const base = await createEphemeralDb();
const { db } = base;
let app: TestServer;
let probe: TestServer;

before(async () => {
  // Desde acá TODO (fixtures y requests) corre como el rol de la app.
  await base.client.exec("SET ROLE app_runtime");
  app = await startTestServer(createAppHandler({ db, role: "all" }));
  // Ruta de prueba con sucursal obligatoria, sobre el resolver de sesión REAL: así se prueba
  // que la sesión trae las sucursales de la membresía y que el router las hace cumplir.
  probe = await startTestServer(
    createRouter({
      routes: [route({ method: "GET", path: "/probe", auth: "user", location: "required" }, ({ locationId }) => ({ locationId }))],
      prefix: "",
      resolveSession: createSessionResolver(db),
    }),
  );
});

after(async () => {
  await probe?.close();
  await app?.close();
  await base.close();
});

const browser = () => new Browser(app.baseUrl);

async function loggedIn(email: string, password: string): Promise<InstanceType<typeof Browser>> {
  const b = browser();
  const res = await b.post("/api/panel/auth/login", { email, password });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.data.status, "ok");
  return b;
}

/** Copia de la cookie de sesión hacia el servidor de la ruta de prueba. */
async function probeAs(b: InstanceType<typeof Browser>, locationId: string) {
  const p = new Browser(probe.baseUrl, b.ip);
  for (const [k, v] of b.cookies) p.cookies.set(k, v);
  return p.get("/probe", { "x-location-id": locationId });
}

// ─── Login ──────────────────────────────────────────────────────────────────

test("login OK: cookie HttpOnly/SameSite=Lax de 7 días y `me` con la forma del contrato", async () => {
  const biz = await createTestBusiness(db, { name: "Clínica Uno" });
  const other = await createTestBusiness(db, { name: "Clínica Dos" });
  const owner = await createTestMember(db, { businessId: biz.businessId, role: "owner", name: "Ana Dueña" });
  await addTestMembership(db, { businessId: other.businessId, userId: owner.userId, role: "admin" });

  const b = browser();
  // Email con mayúsculas y espacios: se normaliza.
  const res = await b.post("/api/panel/auth/login", { email: `  ${owner.email.toUpperCase()} `, password: owner.password });
  assert.equal(res.status, 200);
  const cookie = res.setCookies.find((c) => c.startsWith("panel_session="));
  assert.ok(cookie, "fija panel_session");
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);
  assert.match(cookie, /Path=\//);
  assert.match(cookie, /Max-Age=604800/);
  assert.doesNotMatch(cookie, /Secure/, "fuera de producción, sin Secure (el panel corre por http://localhost)");

  const { status, me } = res.body.data;
  assert.equal(status, "ok");
  assert.deepEqual(me.user, { id: owner.userId, name: "Ana Dueña", email: owner.email, mustChangePassword: false, totpEnabled: false });
  assert.deepEqual(Object.keys(me.business).sort(), ["branding", "currency", "id", "industry", "name", "plan", "slug", "terminology", "timezone"]);
  assert.equal(me.business.id, biz.businessId, "entra al negocio en el que está hace más tiempo");
  assert.equal(me.business.name, "Clínica Uno");
  assert.equal(me.business.terminology.client, "cliente", "terminología completa (con defaults)");
  assert.deepEqual(me.business.branding, { accentColor: "#123456" });
  assert.equal(me.role, "owner");
  assert.equal(me.allLocations, true);
  assert.deepEqual(me.locations, [
    { id: biz.locationIds[0], name: "Central" },
    { id: biz.locationIds[1], name: "Norte" },
  ]);
  assert.deepEqual(
    me.memberships.map((m: { businessId: string; businessName: string; role: string }) => [m.businessId, m.businessName, m.role]),
    [
      [biz.businessId, "Clínica Uno", "owner"],
      [other.businessId, "Clínica Dos", "admin"],
    ],
  );
  assert.deepEqual(me.modules, [...ALL_MODULES]);

  const again = await b.get("/api/panel/auth/me");
  assert.equal(again.status, 200);
  assert.deepEqual(again.body, { ok: true, data: me });
});

test("login: clave mala, cuenta inexistente, inactiva o sin clave → el MISMO 401 genérico y sin cookie", async () => {
  const biz = await createTestBusiness(db);
  const owner = await createTestMember(db, { businessId: biz.businessId, role: "owner" });
  const inactive = await createTestUser(db, { active: false });
  await addTestMembership(db, { businessId: biz.businessId, userId: inactive.userId, role: "staff" });
  const invited = await createTestMember(db, { businessId: biz.businessId, role: "staff", password: null });

  const attempts = [
    { email: owner.email, password: "no-es-la-clave" },
    { email: uniqueEmail("nadie"), password: "lo-que-sea-123" },
    { email: inactive.email, password: inactive.password },
    { email: invited.email, password: "" + "cualquier-clave" },
  ];
  for (const attempt of attempts) {
    const res = await browser().post("/api/panel/auth/login", attempt);
    assert.equal(res.status, 401, attempt.email);
    assert.deepEqual(res.body, { ok: false, error: "Correo o clave incorrectos.", code: "invalid_credentials" });
    assert.equal(res.setCookies.length, 0);
  }

  const noPassword = await browser().post("/api/panel/auth/login", { email: owner.email });
  assert.equal(noPassword.status, 400);
  assert.equal(noPassword.body.code, "validation_error");

  const anonymous = await browser().get("/api/panel/auth/me");
  assert.equal(anonymous.status, 401);
  assert.equal(anonymous.body.code, "unauthorized");
});

test("login: con la clave correcta pero sin membresía activa en un negocio activo → 403 no_active_business", async () => {
  const biz = await createTestBusiness(db);
  const user = await createTestUser(db);
  await addTestMembership(db, { businessId: biz.businessId, userId: user.userId, role: "staff", active: false });

  const res = await browser().post("/api/panel/auth/login", { email: user.email, password: user.password });
  assert.equal(res.status, 403);
  assert.equal(res.body.code, "no_active_business");
  assert.equal(res.setCookies.length, 0);
});

test("login: si su único negocio está pausado → 403 business_paused (el panel muestra \"Cuenta pausada\")", async () => {
  const biz = await createTestBusiness(db);
  const paused = await createTestBusiness(db, { status: "paused" });
  const user = await createTestUser(db);
  await addTestMembership(db, { businessId: biz.businessId, userId: user.userId, role: "staff", active: false });
  await addTestMembership(db, { businessId: paused.businessId, userId: user.userId, role: "owner" });

  const res = await browser().post("/api/panel/auth/login", { email: user.email, password: user.password });
  assert.equal(res.status, 403);
  assert.equal(res.body.code, "business_paused");
  assert.equal(res.setCookies.length, 0);
});

test("logout: borra la cookie y la sesión deja de servir en ese navegador", async () => {
  const biz = await createTestBusiness(db);
  const owner = await createTestMember(db, { businessId: biz.businessId, role: "owner" });
  const b = await loggedIn(owner.email, owner.password!);
  const out = await b.post("/api/panel/auth/logout");
  assert.equal(out.status, 204);
  assert.match(out.setCookies[0], /^panel_session=;.*Max-Age=0/);
  assert.equal((await b.get("/api/panel/auth/me")).status, 401);
});

test("logout: revoca la sesión — una cookie copiada antes del logout (y la de otro dispositivo) responde 401 después", async () => {
  const biz = await createTestBusiness(db);
  const owner = await createTestMember(db, { businessId: biz.businessId, role: "owner" });
  const b = await loggedIn(owner.email, owner.password!);
  const copied = b.clone(); // la cookie robada (XSS, equipo compartido, extensión)
  const phone = await loggedIn(owner.email, owner.password!); // otro dispositivo
  assert.equal((await copied.get("/api/panel/auth/me")).status, 200);
  assert.equal((await b.post("/api/panel/auth/logout")).status, 204);
  assert.equal((await copied.get("/api/panel/auth/me")).status, 401, "la cookie copiada ya no sirve");
  assert.equal((await phone.get("/api/panel/auth/me")).status, 401, "cerrar sesión cierra TODAS las sesiones de la persona");

  // Una cookie ya revocada no vuelve a subir el epoch: no puede echar a la persona de su sesión nueva.
  const again = await loggedIn(owner.email, owner.password!);
  assert.equal((await copied.post("/api/panel/auth/logout")).status, 204);
  assert.equal((await again.get("/api/panel/auth/me")).status, 200);
});

test("logout: sin sesión (o con una cookie inválida) responde 204 y no revoca nada", async () => {
  const anonymous = browser();
  assert.equal((await anonymous.post("/api/panel/auth/logout")).status, 204);
  anonymous.cookies.set("panel_session", "basura");
  assert.equal((await anonymous.post("/api/panel/auth/logout")).status, 204);
});

test("rate limit: tras 5 fallos desde la misma IP contra el mismo email → 429 too_many_attempts (aun con la clave correcta); desde otra IP entra", async () => {
  const biz = await createTestBusiness(db);
  const owner = await createTestMember(db, { businessId: biz.businessId, role: "owner" });
  const attacker = browser();
  for (let i = 0; i < 5; i++) {
    const res = await attacker.post("/api/panel/auth/login", { email: owner.email, password: `mala-${i}-xxxx` });
    assert.equal(res.status, 401, `intento ${i + 1}`);
  }
  const blocked = await attacker.post("/api/panel/auth/login", { email: owner.email, password: owner.password });
  assert.equal(blocked.status, 429);
  assert.equal(blocked.body.code, "too_many_attempts");
  assert.ok(Number(blocked.headers.get("retry-after")) >= 1);

  // Un email inventado se bloquea igual (el 429 no revela qué cuentas existen).
  const ghost = uniqueEmail("fantasma");
  for (let i = 0; i < 5; i++) await attacker.post("/api/panel/auth/login", { email: ghost, password: `mala-${i}-xxxx` });
  assert.equal((await attacker.post("/api/panel/auth/login", { email: ghost, password: "otra-mas-1" })).status, 429);

  // La dueña, desde su propia IP, entra.
  await loggedIn(owner.email, owner.password!);
});

// ─── Segundo factor ─────────────────────────────────────────────────────────

test("2FA: setup → enable (cierra las otras sesiones) → login pide el código → disable con clave y código", async () => {
  const biz = await createTestBusiness(db);
  const owner = await createTestMember(db, { businessId: biz.businessId, role: "owner" });
  const b = await loggedIn(owner.email, owner.password!);
  const otherDevice = b.clone();

  const setup = await b.post("/api/panel/auth/totp/setup");
  assert.equal(setup.status, 200);
  const { secret, otpauthUrl } = setup.body.data;
  assert.match(secret, /^[A-Z2-7]{32}$/);
  assert.match(otpauthUrl, /^otpauth:\/\/totp\//);
  assert.ok(otpauthUrl.includes(`secret=${secret}`));
  const key = decodeBase32(secret)!;
  const code = (offsetSteps = 0) => totp(key, Date.now() + offsetSteps * 30_000);

  // El secreto no rige hasta confirmarlo: el login todavía no pide código.
  assert.equal((await b.get("/api/panel/auth/me")).body.data.user.totpEnabled, false);

  const wrong = await b.post("/api/panel/auth/totp/enable", { code: code() === "000000" ? "111111" : "000000" });
  assert.equal(wrong.status, 400);
  assert.equal(wrong.body.code, "invalid_code");

  resetTotpReplay();
  const enabled = await b.post("/api/panel/auth/totp/enable", { code: code() });
  assert.equal(enabled.status, 204);
  assert.ok(enabled.setCookies.some((c) => c.startsWith("panel_session=")), "re-emite la cookie de este dispositivo");
  assert.equal((await b.get("/api/panel/auth/me")).body.data.user.totpEnabled, true);
  assert.equal((await otherDevice.get("/api/panel/auth/me")).status, 401, "el otro dispositivo quedó afuera (epoch)");
  assert.equal((await b.post("/api/panel/auth/totp/setup")).body.code, "totp_already_enabled");

  // Login: con la clave correcta y sin código → totp_required, sin cookie.
  const step1 = await browser().post("/api/panel/auth/login", { email: owner.email, password: owner.password });
  assert.equal(step1.status, 200);
  assert.deepEqual(step1.body.data, { status: "totp_required" });
  assert.equal(step1.setCookies.length, 0);
  // Clave mala + código: 401 genérico (no se confirma nada).
  assert.equal((await browser().post("/api/panel/auth/login", { email: owner.email, password: "mala-mala", totpCode: code() })).status, 401);
  // Código malo: 401 genérico.
  const badCode = await browser().post("/api/panel/auth/login", { email: owner.email, password: owner.password, totpCode: "123456" === code() ? "654321" : "123456" });
  assert.equal(badCode.status, 401);
  assert.equal(badCode.body.code, "invalid_credentials");

  resetTotpReplay();
  const withCode = browser();
  const once = code();
  const good = await withCode.post("/api/panel/auth/login", { email: owner.email, password: owner.password, totpCode: once });
  assert.equal(good.status, 200);
  assert.equal(good.body.data.status, "ok");
  // El mismo código no sirve dos veces (anti-replay).
  assert.equal((await browser().post("/api/panel/auth/login", { email: owner.email, password: owner.password, totpCode: once })).status, 401);

  // Apagar: clave mala → 400 invalid_password; código bueno y clave buena → 204.
  resetTotpReplay();
  const badPassword = await withCode.post("/api/panel/auth/totp/disable", { password: "no-es", code: code() });
  assert.equal(badPassword.status, 400);
  assert.equal(badPassword.body.code, "invalid_password");
  resetTotpReplay();
  const disabled = await withCode.post("/api/panel/auth/totp/disable", { password: owner.password, code: code() });
  assert.equal(disabled.status, 204);
  assert.equal((await withCode.get("/api/panel/auth/me")).body.data.user.totpEnabled, false);
  await loggedIn(owner.email, owner.password!); // ya no pide código
});

test("2FA: el secreto queda cifrado en la base (nunca en claro)", async () => {
  const biz = await createTestBusiness(db);
  const owner = await createTestMember(db, { businessId: biz.businessId, role: "owner" });
  const b = await loggedIn(owner.email, owner.password!);
  const { secret } = (await b.post("/api/panel/auth/totp/setup")).body.data;
  const [row] = await withTenant(db, biz.businessId, (tx) => tx.select({ s: users.totpSecret }).from(users));
  assert.ok(row.s);
  assert.ok(row.s.startsWith("v1:"), "blob de src/platform/crypto/secrets.ts");
  assert.ok(!row.s.includes(secret));
});

// ─── Revocación por epoch ───────────────────────────────────────────────────

test("cambio de clave: cierra las otras sesiones, este dispositivo sigue adentro y la clave vieja deja de servir", async () => {
  const biz = await createTestBusiness(db);
  const owner = await createTestMember(db, { businessId: biz.businessId, role: "owner" });
  const laptop = await loggedIn(owner.email, owner.password!);
  const phone = await loggedIn(owner.email, owner.password!);

  const wrong = await laptop.post("/api/panel/auth/password/change", { currentPassword: "no-es", newPassword: "clave-nueva-123" });
  assert.equal(wrong.status, 400, "400 y no 401: la sesión sí es válida");
  assert.equal(wrong.body.code, "invalid_password");
  const same = await laptop.post("/api/panel/auth/password/change", { currentPassword: owner.password, newPassword: owner.password });
  assert.equal(same.status, 400);
  assert.equal(same.body.code, "validation_error");
  const short = await laptop.post("/api/panel/auth/password/change", { currentPassword: owner.password, newPassword: "corta" });
  assert.equal(short.status, 400);
  assert.ok(short.body.fields["body.newPassword"]);

  const changed = await laptop.post("/api/panel/auth/password/change", { currentPassword: owner.password, newPassword: "clave-nueva-123" });
  assert.equal(changed.status, 204);
  assert.ok(changed.setCookies.some((c) => c.startsWith("panel_session=")));
  assert.equal((await laptop.get("/api/panel/auth/me")).status, 200, "este dispositivo sigue adentro");
  assert.equal((await phone.get("/api/panel/auth/me")).status, 401, "el otro dispositivo queda afuera");

  assert.equal((await browser().post("/api/panel/auth/login", { email: owner.email, password: owner.password })).status, 401);
  await loggedIn(owner.email, "clave-nueva-123");
});

test("desactivar la membresía o cambiar el rol cierra las sesiones de esa persona en la request siguiente", async () => {
  const biz = await createTestBusiness(db);
  const owner = await createTestMember(db, { businessId: biz.businessId, role: "owner" });
  const desk = await createTestMember(db, { businessId: biz.businessId, role: "front_desk", locationIds: [biz.locationIds[0]] });
  const ownerB = await loggedIn(owner.email, owner.password!);

  const deskSession = await loggedIn(desk.email, desk.password!);
  const toStaff = await ownerB.patch(`/api/panel/team/members/${desk.membershipId}`, { role: "staff" });
  assert.equal(toStaff.status, 200);
  assert.equal(toStaff.body.data.role, "staff");
  assert.equal((await deskSession.get("/api/panel/auth/me")).status, 401, "cambio de rol → sesión vieja muerta");
  const relogged = await loggedIn(desk.email, desk.password!);
  assert.equal((await relogged.get("/api/panel/auth/me")).body.data.role, "staff", "el rol nuevo rige");

  const off = await ownerB.patch(`/api/panel/team/members/${desk.membershipId}`, { active: false });
  assert.equal(off.status, 200);
  assert.equal(off.body.data.status, "inactive");
  assert.equal((await relogged.get("/api/panel/auth/me")).status, 401, "desactivada → afuera");
  const denied = await browser().post("/api/panel/auth/login", { email: desk.email, password: desk.password });
  assert.equal(denied.status, 403);
  assert.equal(denied.body.code, "no_active_business");

  assert.equal((await ownerB.patch(`/api/panel/team/members/${desk.membershipId}`, { active: true })).status, 200);
  await loggedIn(desk.email, desk.password!);
});

// ─── Cambio de negocio ──────────────────────────────────────────────────────

test("switch-business: pasa a otro negocio donde es miembro (con su rol de ahí); a uno sin membresía → 403", async () => {
  const a = await createTestBusiness(db, { name: "Negocio A" });
  const b = await createTestBusiness(db, { name: "Negocio B" });
  const c = await createTestBusiness(db, { name: "Negocio C" });
  const person = await createTestMember(db, { businessId: a.businessId, role: "owner" });
  const inB = await addTestMembership(db, { businessId: b.businessId, userId: person.userId, role: "front_desk", locationIds: [b.locationIds[1]] });
  await createTestMember(db, { businessId: c.businessId, role: "owner" });

  const s = await loggedIn(person.email, person.password!);
  const switched = await s.post("/api/panel/auth/switch-business", { businessId: b.businessId });
  assert.equal(switched.status, 200);
  assert.equal(switched.body.data.business.id, b.businessId);
  assert.equal(switched.body.data.role, "front_desk");
  assert.deepEqual(switched.body.data.locations, [{ id: b.locationIds[1], name: "Norte" }]);
  assert.equal(switched.body.data.allLocations, false);
  assert.equal((await s.get("/api/panel/auth/me")).body.data.business.id, b.businessId, "la cookie nueva apunta a B");

  for (const target of [c.businessId, randomUUID()]) {
    const denied = await s.post("/api/panel/auth/switch-business", { businessId: target });
    assert.equal(denied.status, 403);
    assert.equal(denied.body.code, "business_forbidden");
  }
  assert.equal((await s.post("/api/panel/auth/switch-business", { businessId: "no-es-uuid" })).status, 400);

  // Con la membresía de B desactivada, ni volver a B ni seguir usando la sesión de B.
  await withTenant(db, b.businessId, (tx) => tx.update(memberships).set({ active: false }).where(eq(memberships.id, inB)));
  assert.equal((await s.get("/api/panel/auth/me")).status, 401);
  const fresh = await loggedIn(person.email, person.password!);
  assert.equal((await fresh.post("/api/panel/auth/switch-business", { businessId: b.businessId })).status, 403);
});

// ─── Sucursales ─────────────────────────────────────────────────────────────

test("sucursales: la sesión trae las de la membresía y el router las hace cumplir (en vivo, sin re-login)", async () => {
  const biz = await createTestBusiness(db);
  const [central, norte] = biz.locationIds;
  const owner = await createTestMember(db, { businessId: biz.businessId, role: "owner" });
  const desk = await createTestMember(db, { businessId: biz.businessId, role: "front_desk", locationIds: [central] });
  const admin = await createTestMember(db, { businessId: biz.businessId, role: "admin" }); // sin filas = todas

  const deskB = await loggedIn(desk.email, desk.password!);
  const me = (await deskB.get("/api/panel/auth/me")).body.data;
  assert.equal(me.allLocations, false);
  assert.deepEqual(me.locations, [{ id: central, name: "Central" }]);

  assert.equal((await probeAs(deskB, central)).status, 200);
  const forbidden = await probeAs(deskB, norte);
  assert.equal(forbidden.status, 403);
  assert.equal(forbidden.body.code, "location_forbidden");

  for (const who of [owner, admin]) {
    const s = await loggedIn(who.email, who.password!);
    assert.equal((await probeAs(s, norte)).status, 200, "dueño/admin sin filas: todas");
    assert.equal((await s.get("/api/panel/auth/me")).body.data.allLocations, true);
  }

  // El dueño le cambia la sucursal: pega en la request siguiente (la sesión lee la base).
  const ownerB = await loggedIn(owner.email, owner.password!);
  const moved = await ownerB.patch(`/api/panel/team/members/${desk.membershipId}`, { locationIds: [norte] });
  assert.equal(moved.status, 200);
  assert.deepEqual(moved.body.data.locationIds, [norte]);
  assert.equal((await probeAs(deskB, norte)).status, 200);
  assert.equal((await probeAs(deskB, central)).status, 403);

  // Sucursal de otro negocio: 400 al asignarla.
  const other = await createTestBusiness(db);
  const foreign = await ownerB.patch(`/api/panel/team/members/${desk.membershipId}`, { locationIds: [other.locationIds[0]] });
  assert.equal(foreign.status, 400);
  assert.ok(foreign.body.fields["body.locationIds"]);
});

// ─── Equipo ─────────────────────────────────────────────────────────────────

test("equipo: lista con estados; solo dueño y admin la ven; el admin no toca dueños", async () => {
  const biz = await createTestBusiness(db);
  const owner = await createTestMember(db, { businessId: biz.businessId, role: "owner", name: "Dueña" });
  const admin = await createTestMember(db, { businessId: biz.businessId, role: "admin", name: "Admin" });
  const invited = await createTestMember(db, { businessId: biz.businessId, role: "staff", password: null, name: "Invitada" });
  const desk = await createTestMember(db, { businessId: biz.businessId, role: "front_desk", locationIds: [biz.locationIds[0]], name: "Recepción" });

  const ownerB = await loggedIn(owner.email, owner.password!);
  const list = await ownerB.get("/api/panel/team/members");
  assert.equal(list.status, 200);
  const byName = Object.fromEntries(list.body.data.map((m: { name: string }) => [m.name, m]));
  assert.deepEqual(Object.keys(byName).sort(), ["Admin", "Dueña", "Invitada", "Recepción"]);
  assert.equal(byName["Invitada"].status, "invited");
  assert.equal(byName["Dueña"].status, "active");
  assert.deepEqual(
    { allLocations: byName["Recepción"].allLocations, locationIds: byName["Recepción"].locationIds },
    { allLocations: false, locationIds: [biz.locationIds[0]] },
  );
  assert.equal(byName["Invitada"].membershipId, invited.membershipId);

  const deskB = await loggedIn(desk.email, desk.password!);
  assert.equal((await deskB.get("/api/panel/team/members")).body.code, "forbidden_role");
  assert.equal((await deskB.patch(`/api/panel/team/members/${admin.membershipId}`, { active: false })).status, 403);

  const adminB = await loggedIn(admin.email, admin.password!);
  const touchOwner = await adminB.patch(`/api/panel/team/members/${owner.membershipId}`, { role: "staff" });
  assert.equal(touchOwner.status, 403);
  assert.equal(touchOwner.body.code, "forbidden_role");
  const promote = await adminB.patch(`/api/panel/team/members/${desk.membershipId}`, { role: "owner" });
  assert.equal(promote.status, 403, "el admin no nombra dueños");
  assert.equal((await adminB.patch(`/api/panel/team/members/${desk.membershipId}`, {})).status, 400, "patch vacío");
  assert.equal((await adminB.patch(`/api/panel/team/members/${randomUUID()}`, { active: false })).status, 404);
});

test("último dueño: no se puede bajar ni desactivar; con otro dueño sí (y si se baja a sí mismo, su cookie se re-emite)", async () => {
  const biz = await createTestBusiness(db);
  const owner = await createTestMember(db, { businessId: biz.businessId, role: "owner" });
  const desk = await createTestMember(db, { businessId: biz.businessId, role: "front_desk" });
  const s = await loggedIn(owner.email, owner.password!);

  for (const patch of [{ role: "admin" }, { active: false }]) {
    const res = await s.patch(`/api/panel/team/members/${owner.membershipId}`, patch);
    assert.equal(res.status, 409, JSON.stringify(patch));
    assert.equal(res.body.code, "last_owner");
  }

  assert.equal((await s.patch(`/api/panel/team/members/${desk.membershipId}`, { role: "owner" })).status, 200);
  const selfDemote = await s.patch(`/api/panel/team/members/${owner.membershipId}`, { role: "admin" });
  assert.equal(selfDemote.status, 200);
  assert.ok(selfDemote.setCookies.some((c) => c.startsWith("panel_session=")), "su propia sesión sigue (cookie con el epoch nuevo)");
  assert.equal((await s.get("/api/panel/auth/me")).body.data.role, "admin");

  // Ahora la única dueña es la otra: tampoco se la puede bajar (y el admin ni siquiera puede intentarlo).
  const deskOwner = await loggedIn(desk.email, desk.password!);
  assert.equal((await deskOwner.patch(`/api/panel/team/members/${desk.membershipId}`, { active: false })).body.code, "last_owner");
});

// ─── Aislamiento entre negocios ─────────────────────────────────────────────

test("RLS: con la sesión de un negocio no se lee ni se toca nada de otro", async () => {
  const a = await createTestBusiness(db);
  const b = await createTestBusiness(db);
  const ownerA = await createTestMember(db, { businessId: a.businessId, role: "owner", name: "Dueña A" });
  const staffA = await createTestMember(db, { businessId: a.businessId, role: "staff", name: "Staff A" });
  const ownerB = await createTestMember(db, { businessId: b.businessId, role: "owner", name: "Dueño B" });

  const sB = await loggedIn(ownerB.email, ownerB.password!);
  const members = (await sB.get("/api/panel/team/members")).body.data;
  assert.deepEqual(members.map((m: { name: string }) => m.name), ["Dueño B"], "solo su equipo");

  const patch = await sB.patch(`/api/panel/team/members/${staffA.membershipId}`, { active: false });
  assert.equal(patch.status, 404, "la membresía de otro negocio no existe para B");
  const invite = await sB.post("/api/panel/team/invitations", { email: uniqueEmail("x"), role: "staff", locationIds: [a.locationIds[0]] });
  assert.equal(invite.status, 400, "sucursal de otro negocio");
  assert.equal((await sB.post("/api/panel/auth/switch-business", { businessId: a.businessId })).status, 403);

  // Y en la base, con el contexto de B, A no existe.
  const seen = await withTenant(db, b.businessId, (tx) => tx.select({ id: users.id }).from(users));
  assert.deepEqual(seen.map((u) => u.id), [ownerB.userId]);
  const sA = await loggedIn(ownerA.email, ownerA.password!);
  const stillActive = (await sA.get("/api/panel/team/members")).body.data.find((m: { name: string }) => m.name === "Staff A");
  assert.equal(stillActive.active, true);
});
