import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { and, eq } from "drizzle-orm";

// ─────────────────────────────────────────────────────────────────────────────
// Recuperación de clave e invitaciones de PUNTA A PUNTA (I0.6): la request encola el
// correo (outbox, en la misma transacción que el token), el worker real de la cola lo
// manda con el proveedor `log` y el test lee el link del outbox de pruebas — el mismo
// camino que en producción, salvo el proveedor. La base corre como `app_runtime`.
//
// PUBLIC_BASE_URL fija la base de los links: se verifica que el link sale de ahí y no del
// header Host del request.
// ─────────────────────────────────────────────────────────────────────────────

process.env.TRUST_PROXY = "loopback";
process.env.PANEL_SESSION_SECRET = "test-identity-email-session-secret-0123";
process.env.TOKENS_ENCRYPTION_KEY = "c".repeat(64);
process.env.PANEL_LOGIN_RATE_LIMIT_MAX_IP = "200";
process.env.PUBLIC_BASE_URL = "https://app.example.test";

const { createAppHandler } = await import("../../src/app");
const { registerJobHandlers } = await import("../../src/jobs");
const { authTokens, legalAcceptances, users } = await import("../../src/modules/team/schema");
const { LEGAL_VERSION } = await import("../../src/platform/legal");
const { withSystem } = await import("../../src/platform/db/scope");
const { clearTestOutbox, getTestOutbox } = await import("../../src/platform/email/email");
const { _resetJobHandlersForTests } = await import("../../src/platform/queue/handlers");
const { startQueueWorker } = await import("../../src/platform/queue/worker");
const { _resetShutdownForTests } = await import("../../src/platform/net/shutdown");
const { createEphemeralDb } = await import("../helpers/pgliteDb");
const { Browser, startTestServer } = await import("../helpers/panelClient");
const { silenceConsole, sleep, waitFor } = await import("../helpers/queue");
const { createTestBusiness, createTestMember, createTestUser, uniqueEmail } = await import("../helpers/identityFixtures");

type TestServer = Awaited<ReturnType<typeof startTestServer>>;
type Worker = ReturnType<typeof startQueueWorker>;

const base = await createEphemeralDb();
const { db } = base;
let app: TestServer;
let worker: Worker;
let restoreConsole: () => void;

before(async () => {
  await base.client.exec("SET ROLE app_runtime");
  restoreConsole = silenceConsole();
  _resetJobHandlersForTests();
  _resetShutdownForTests();
  registerJobHandlers();
  worker = startQueueWorker({ db, concurrency: 1, pollMs: 10, retentionDays: 0 });
  app = await startTestServer(createAppHandler({ db, role: "all" }));
});

after(async () => {
  await worker?.stop();
  await app?.close();
  restoreConsole();
  await base.close();
});

beforeEach(() => clearTestOutbox());

const browser = () => new Browser(app.baseUrl);

async function loggedIn(email: string, password: string) {
  const b = browser();
  const res = await b.post("/api/panel/auth/login", { email, password });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return b;
}

/** Espera el correo para `to` y devuelve el token del link (`path?token=…`). */
async function tokenFromEmail(to: string, path: string): Promise<{ token: string; subject: string; text: string }> {
  await waitFor(() => getTestOutbox().some((m) => m.to === to), `correo a ${to}`);
  const mail = getTestOutbox().filter((m) => m.to === to).at(-1)!;
  const re = new RegExp(`https://app\\.example\\.test${path.replace(/\//g, "\\/")}\\?token=([A-Za-z0-9_-]{43})`);
  const match = re.exec(mail.text);
  assert.ok(match, `el correo trae el link ${path} con la base de PUBLIC_BASE_URL:\n${mail.text}`);
  assert.ok(mail.html.includes(match[0]), "el mismo link en el HTML");
  return { token: match[1], subject: mail.subject, text: mail.text };
}

// ─── Recuperación de clave ──────────────────────────────────────────────────

test("recuperación: forgot → correo con link de 1 h → reset → sesiones viejas cerradas y la clave nueva entra", async () => {
  const biz = await createTestBusiness(db);
  const owner = await createTestMember(db, { businessId: biz.businessId, role: "owner", name: "Ana" });
  const oldSession = await loggedIn(owner.email, owner.password!);

  // Host falso en el request: el link igual sale de PUBLIC_BASE_URL.
  const forgot = await browser().post("/api/panel/auth/password/forgot", { email: owner.email.toUpperCase() }, { "x-forwarded-host": "evil.example" });
  assert.equal(forgot.status, 204);
  const { token, subject, text } = await tokenFromEmail(owner.email, "/panel/reset-password");
  assert.match(subject, /Restablecé tu clave/);
  assert.match(text, /vence en 1 hora/);

  // En la base, solo el hash del token.
  const rows = await withSystem(db, (tx) => tx.select().from(authTokens).where(eq(authTokens.userId, owner.userId)));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, "password_reset");
  assert.notEqual(rows[0].tokenHash, token);
  assert.equal(rows[0].tokenHash.length, 64);
  const ttl = rows[0].expiresAt.getTime() - rows[0].createdAt.getTime();
  assert.ok(Math.abs(ttl - 60 * 60 * 1000) < 5_000, `vence en 1 h (${ttl} ms)`);

  const short = await browser().post("/api/panel/auth/password/reset", { token, password: "corta" });
  assert.equal(short.status, 400);
  assert.equal(short.body.code, "validation_error");

  const reset = await browser().post("/api/panel/auth/password/reset", { token, password: "clave-recuperada-1" });
  assert.equal(reset.status, 204);
  assert.equal((await oldSession.get("/api/panel/auth/me")).status, 401, "la sesión con la clave vieja se cierra");
  assert.equal((await browser().post("/api/panel/auth/login", { email: owner.email, password: owner.password })).status, 401);
  await loggedIn(owner.email, "clave-recuperada-1");

  // Un solo uso.
  const again = await browser().post("/api/panel/auth/password/reset", { token, password: "otra-clave-123" });
  assert.equal(again.status, 400);
  assert.equal(again.body.code, "invalid_token");
});

test("recuperación: un email que no existe (o una cuenta inactiva) responde igual 204 y no manda nada", async () => {
  const inactive = await createTestUser(db, { active: false });
  for (const email of [uniqueEmail("nadie"), inactive.email]) {
    const res = await browser().post("/api/panel/auth/password/forgot", { email });
    assert.equal(res.status, 204);
  }
  await sleep(300); // margen para que el worker hubiera mandado algo
  assert.equal(getTestOutbox().length, 0);
});

test("recuperación: link vencido, inventado o reemplazado por uno más nuevo → 400 invalid_token", async () => {
  const biz = await createTestBusiness(db);
  const owner = await createTestMember(db, { businessId: biz.businessId, role: "owner" });

  await browser().post("/api/panel/auth/password/forgot", { email: owner.email });
  const first = (await tokenFromEmail(owner.email, "/panel/reset-password")).token;
  clearTestOutbox();
  await browser().post("/api/panel/auth/password/forgot", { email: owner.email });
  const second = (await tokenFromEmail(owner.email, "/panel/reset-password")).token;
  assert.notEqual(first, second);

  const replaced = await browser().post("/api/panel/auth/password/reset", { token: first, password: "clave-nueva-123" });
  assert.equal(replaced.body.code, "invalid_token", "solo vale el último link");
  const invented = await browser().post("/api/panel/auth/password/reset", { token: "x".repeat(43), password: "clave-nueva-123" });
  assert.equal(invented.body.code, "invalid_token");

  await withSystem(db, (tx) => tx.update(authTokens).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(authTokens.userId, owner.userId)));
  const expired = await browser().post("/api/panel/auth/password/reset", { token: second, password: "clave-nueva-123" });
  assert.equal(expired.status, 400);
  assert.equal(expired.body.code, "invalid_token");
  await loggedIn(owner.email, owner.password!); // la clave no cambió
});

test("recuperación: pedir el correo muchas veces para la misma cuenta desde el mismo lugar → 429 (anti-bombardeo)", async () => {
  const b = browser();
  const email = uniqueEmail("bombardeo");
  for (let i = 0; i < 5; i++) assert.equal((await b.post("/api/panel/auth/password/forgot", { email })).status, 204);
  const blocked = await b.post("/api/panel/auth/password/forgot", { email });
  assert.equal(blocked.status, 429);
  assert.equal(blocked.body.code, "too_many_attempts");
});

// ─── Invitaciones ───────────────────────────────────────────────────────────

test("invitación: el dueño invita → correo de 7 días → ver la invitación → aceptar deja la sesión iniciada con el rol y la sucursal", async () => {
  const biz = await createTestBusiness(db, { name: "Estética Prueba" });
  const owner = await createTestMember(db, { businessId: biz.businessId, role: "owner", name: "Dueña Prueba" });
  const s = await loggedIn(owner.email, owner.password!);
  const email = uniqueEmail("nueva");

  const invited = await s.post("/api/panel/team/invitations", { email: email.toUpperCase(), name: "Nueva", role: "staff", locationIds: [biz.locationIds[1]] });
  assert.equal(invited.status, 201, JSON.stringify(invited.body));
  assert.equal(invited.body.data.email, email, "email normalizado");
  assert.equal(invited.body.data.status, "invited");
  assert.equal(invited.body.data.role, "staff");
  assert.deepEqual(invited.body.data.locationIds, [biz.locationIds[1]]);

  const { token, subject, text } = await tokenFromEmail(email, "/panel/accept-invitation");
  assert.match(subject, /Te invitaron a Estética Prueba/);
  assert.match(text, /Dueña Prueba te invitó/);
  assert.match(text, /vence en 7 días/);

  // Todavía no puede entrar: no eligió clave.
  assert.equal((await browser().post("/api/panel/auth/login", { email, password: "cualquier-cosa" })).status, 401);

  const info = await browser().get(`/api/panel/auth/invitations/${token}`);
  assert.equal(info.status, 200);
  assert.deepEqual(info.body.data, { email, businessName: "Estética Prueba", role: "staff", hasAccount: false });

  const missingName = await browser().post("/api/panel/auth/invitations/accept", { token, password: "clave-elegida-1", acceptTerms: true });
  assert.equal(missingName.status, 400);
  assert.ok(missingName.body.fields["body.name"]);
  // Sin aceptar los términos y el aviso de privacidad no entra (y el link sigue valiendo).
  const noTerms = await browser().post("/api/panel/auth/invitations/accept", { token, name: "Nueva Persona", password: "clave-elegida-1" });
  assert.equal(noTerms.status, 400);
  assert.ok(noTerms.body.fields["body.acceptTerms"]);

  const newcomer = browser();
  const accepted = await newcomer.post("/api/panel/auth/invitations/accept", { token, name: "Nueva Persona", password: "clave-elegida-1", acceptTerms: true });
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
  assert.ok(accepted.setCookies.some((c) => c.startsWith("panel_session=")));
  const me = accepted.body.data;
  assert.equal(me.user.email, email);
  assert.equal(me.user.name, "Nueva Persona");
  assert.equal(me.business.id, biz.businessId);
  assert.equal(me.role, "staff");
  assert.equal(me.allLocations, false);
  assert.deepEqual(me.locations, [{ id: biz.locationIds[1], name: "Norte" }]);
  assert.equal((await newcomer.get("/api/panel/auth/me")).status, 200);
  // La invitada también aceptó los términos y el aviso de privacidad: queda la versión y la fecha.
  assert.equal(me.legal.mustAccept, false);
  const [acceptance] = await withSystem(db, (tx) =>
    tx.select().from(legalAcceptances).where(and(eq(legalAcceptances.businessId, biz.businessId), eq(legalAcceptances.userId, me.user.id))),
  );
  assert.equal(acceptance.context, "invitation");
  assert.equal(acceptance.role, "staff");
  assert.equal(acceptance.termsVersion, LEGAL_VERSION);
  assert.equal(acceptance.privacyVersion, LEGAL_VERSION);

  // Un solo uso, y la persona ya figura activa.
  assert.equal((await browser().get(`/api/panel/auth/invitations/${token}`)).status, 404);
  assert.equal((await browser().post("/api/panel/auth/invitations/accept", { token, name: "X", password: "clave-elegida-2", acceptTerms: true })).body.code, "invalid_token");
  const members = (await s.get("/api/panel/team/members")).body.data;
  assert.equal(members.find((m: { email: string }) => m.email === email).status, "active");
  await loggedIn(email, "clave-elegida-1");
});

test("invitación: reenviar a quien no aceptó invalida el link anterior; a quien ya es miembro → 409", async () => {
  const biz = await createTestBusiness(db);
  const owner = await createTestMember(db, { businessId: biz.businessId, role: "owner" });
  const s = await loggedIn(owner.email, owner.password!);
  const email = uniqueEmail("reenvio");

  assert.equal((await s.post("/api/panel/team/invitations", { email, role: "staff" })).status, 201);
  const first = (await tokenFromEmail(email, "/panel/accept-invitation")).token;
  clearTestOutbox();
  const resent = await s.post("/api/panel/team/invitations", { email, role: "front_desk" });
  assert.equal(resent.status, 201);
  assert.equal(resent.body.data.role, "front_desk", "el reenvío actualiza el rol");
  const second = (await tokenFromEmail(email, "/panel/accept-invitation")).token;
  assert.equal((await browser().get(`/api/panel/auth/invitations/${first}`)).status, 404, "el link viejo ya no vale");
  assert.equal((await browser().get(`/api/panel/auth/invitations/${second}`)).body.data.role, "front_desk");

  const dup = await s.post("/api/panel/team/invitations", { email: owner.email, role: "staff" });
  assert.equal(dup.status, 409);
  assert.equal(dup.body.code, "already_member");
});

test("invitación: una cuenta que ya existe confirma con SU clave (no se la cambia) y entra al negocio nuevo", async () => {
  const home = await createTestBusiness(db, { name: "Su negocio" });
  const target = await createTestBusiness(db, { name: "Negocio nuevo" });
  const person = await createTestMember(db, { businessId: home.businessId, role: "owner" });
  const ownerT = await createTestMember(db, { businessId: target.businessId, role: "owner" });
  const s = await loggedIn(ownerT.email, ownerT.password!);

  assert.equal((await s.post("/api/panel/team/invitations", { email: person.email, role: "admin" })).status, 201);
  const { token } = await tokenFromEmail(person.email, "/panel/accept-invitation");
  assert.equal((await browser().get(`/api/panel/auth/invitations/${token}`)).body.data.hasAccount, true);

  const wrong = await browser().post("/api/panel/auth/invitations/accept", { token, password: "no-es-su-clave", acceptTerms: true });
  assert.equal(wrong.status, 400);
  assert.equal(wrong.body.code, "invalid_password");

  const ok = await browser().post("/api/panel/auth/invitations/accept", { token, name: "Otro Nombre", password: person.password, acceptTerms: true });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.data.business.id, target.businessId);
  assert.equal(ok.body.data.role, "admin");
  assert.deepEqual(ok.body.data.memberships.map((m: { businessName: string }) => m.businessName), ["Su negocio", "Negocio nuevo"]);
  assert.notEqual(ok.body.data.user.name, "Otro Nombre", "una cuenta existente conserva su nombre");
  // Aceptó los términos para el negocio nuevo (en el suyo nunca los había aceptado).
  assert.equal(ok.body.data.legal.mustAccept, false);
  const accepted = await withSystem(db, (tx) =>
    tx.select().from(legalAcceptances).where(eq(legalAcceptances.userId, person.userId)),
  );
  assert.deepEqual(accepted.map((a) => [a.businessId, a.context, a.role]), [[target.businessId, "invitation", "admin"]]);
  await loggedIn(person.email, person.password!); // su clave sigue igual
});

test("invitación: permisos — el admin no invita dueños, recepción no invita; email inválido → 400", async () => {
  const biz = await createTestBusiness(db);
  const admin = await createTestMember(db, { businessId: biz.businessId, role: "admin" });
  const desk = await createTestMember(db, { businessId: biz.businessId, role: "front_desk" });
  await createTestMember(db, { businessId: biz.businessId, role: "owner" });

  const a = await loggedIn(admin.email, admin.password!);
  const owner = await a.post("/api/panel/team/invitations", { email: uniqueEmail("x"), role: "owner" });
  assert.equal(owner.status, 403);
  assert.equal(owner.body.code, "forbidden_role");
  assert.equal((await a.post("/api/panel/team/invitations", { email: uniqueEmail("y"), role: "staff" })).status, 201, "el admin sí invita al resto");
  assert.equal((await a.post("/api/panel/team/invitations", { email: "no-es-un-email", role: "staff" })).status, 400);

  const d = await loggedIn(desk.email, desk.password!);
  assert.equal((await d.post("/api/panel/team/invitations", { email: uniqueEmail("z"), role: "staff" })).body.code, "forbidden_role");
});

test("invitación: si desactivan la membresía antes de aceptar, el link deja de valer", async () => {
  const biz = await createTestBusiness(db);
  const owner = await createTestMember(db, { businessId: biz.businessId, role: "owner" });
  const s = await loggedIn(owner.email, owner.password!);
  const email = uniqueEmail("arrepentida");
  const invited = await s.post("/api/panel/team/invitations", { email, role: "staff" });
  const { token } = await tokenFromEmail(email, "/panel/accept-invitation");
  assert.equal((await s.patch(`/api/panel/team/members/${invited.body.data.membershipId}`, { active: false })).status, 200);
  assert.equal((await browser().get(`/api/panel/auth/invitations/${token}`)).status, 404);
  const accept = await browser().post("/api/panel/auth/invitations/accept", { token, name: "X", password: "clave-elegida-1", acceptTerms: true });
  assert.equal(accept.body.code, "invalid_token");
  const [user] = await withSystem(db, (tx) => tx.select({ hash: users.passwordHash }).from(users).where(eq(users.email, email)));
  assert.equal(user.hash, null, "no se le fijó clave");
});
