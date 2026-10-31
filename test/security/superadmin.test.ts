import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { and, eq, isNull } from "drizzle-orm";

// ─────────────────────────────────────────────────────────────────────────────
// Superadmin mínimo (I0.6) por HTTP: login por env (con y sin 2FA), su cookie aparte,
// auditoría, y el alta de un negocio (negocio + primera sucursal con horario default +
// invitación al dueño, atómico) hasta que el dueño acepta y entra. Base como `app_runtime`.
// ─────────────────────────────────────────────────────────────────────────────

process.env.TRUST_PROXY = "loopback";
process.env.PANEL_SESSION_SECRET = "test-superadmin-session-secret-012345678";
process.env.TOKENS_ENCRYPTION_KEY = "d".repeat(64);
process.env.PANEL_LOGIN_RATE_LIMIT_MAX_IP = "200";
process.env.PUBLIC_BASE_URL = "https://app.example.test";
process.env.PANEL_SUPERADMIN_USERNAME = "root";
delete process.env.PANEL_SUPERADMIN_TOTP_SECRET;

const ADMIN_PASSWORD = "clave-del-superadmin-1";
const TOTP_SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

const { hashPassword } = await import("../../src/platform/auth/password");
process.env.PANEL_SUPERADMIN_HASH = await hashPassword(ADMIN_PASSWORD);

const { createAppHandler } = await import("../../src/app");
const { registerJobHandlers } = await import("../../src/jobs");
const { businesses, locationHours, locations } = await import("../../src/modules/business/schema");
const { memberships, users } = await import("../../src/modules/team/schema");
const { decodeBase32, totp, _resetForTests: resetTotpReplay } = await import("../../src/platform/auth/totp");
const { auditLog } = await import("../../src/platform/db/schema");
const { withSystem } = await import("../../src/platform/db/scope");
const { clearTestOutbox, getTestOutbox } = await import("../../src/platform/email/email");
const { _resetShutdownForTests } = await import("../../src/platform/net/shutdown");
const { _resetJobHandlersForTests } = await import("../../src/platform/queue/handlers");
const { startQueueWorker } = await import("../../src/platform/queue/worker");
const { createEphemeralDb } = await import("../helpers/pgliteDb");
const { Browser, startTestServer } = await import("../helpers/panelClient");
const { silenceConsole, waitFor } = await import("../helpers/queue");
const { createTestBusiness, createTestMember, createTestUser, uniqueEmail } = await import("../helpers/identityFixtures");

type TestServer = Awaited<ReturnType<typeof startTestServer>>;

const base = await createEphemeralDb();
const { db } = base;
let app: TestServer;
let worker: ReturnType<typeof startQueueWorker>;
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

beforeEach(() => {
  clearTestOutbox();
  delete process.env.PANEL_SUPERADMIN_TOTP_SECRET;
});

const browser = () => new Browser(app.baseUrl);

async function adminSession() {
  const b = browser();
  const res = await b.post("/api/panel/admin/login", { username: "root", password: ADMIN_PASSWORD });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return b;
}

const newBusiness = (overrides: Record<string, unknown> = {}) => ({
  name: "Clínica Dental Sonrisa",
  industry: "dental",
  timezone: "America/Costa_Rica",
  currency: "crc",
  country: "cr",
  locationName: "Sede Central",
  ownerEmail: uniqueEmail("duena"),
  ownerName: "Dra. Sonrisa",
  ...overrides,
});

test("superadmin: sin sesión (o con la del equipo) → 401; usuario o clave mal → 401 genérico", async () => {
  assert.equal((await browser().get("/api/panel/admin/me")).status, 401);
  assert.equal((await browser().get("/api/panel/admin/businesses")).status, 401);

  const biz = await createTestBusiness(db);
  const owner = await createTestMember(db, { businessId: biz.businessId, role: "owner" });
  const team = browser();
  assert.equal((await team.post("/api/panel/auth/login", { email: owner.email, password: owner.password })).status, 200);
  assert.equal((await team.get("/api/panel/admin/me")).status, 401, "la sesión de un negocio no abre el superadmin");

  for (const attempt of [
    { username: "root", password: "no-es" },
    { username: "otro", password: ADMIN_PASSWORD },
  ]) {
    const res = await browser().post("/api/panel/admin/login", attempt);
    assert.equal(res.status, 401);
    assert.equal(res.body.code, "invalid_credentials");
    assert.equal(res.setCookies.length, 0);
  }
});

test("superadmin: login → cookie aparte (Strict, 8 h), /admin/me y rastro en audit_log sin la IP en claro; logout la borra", async () => {
  const b = browser();
  const res = await b.post("/api/panel/admin/login", { username: "root", password: ADMIN_PASSWORD });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.data, { status: "ok", me: { username: "root", totpEnabled: false } });
  const cookie = res.setCookies.find((c) => c.startsWith("panel_admin_session="));
  assert.ok(cookie);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  assert.match(cookie, /Max-Age=28800/);
  assert.equal(b.cookies.has("panel_session"), false, "no toca la sesión del equipo");

  assert.deepEqual((await b.get("/api/panel/admin/me")).body.data, { username: "root", totpEnabled: false });
  const audit = await withSystem(db, (tx) => tx.select().from(auditLog).where(and(isNull(auditLog.businessId), eq(auditLog.action, "admin_login"))));
  assert.ok(audit.length >= 1);
  assert.equal(audit[0].actor, "superadmin:root");
  assert.match(String(audit[0].details.origin), /^[0-9a-f]{12}$/);
  assert.ok(!JSON.stringify(audit[0].details).includes(b.ip), "la IP no va en claro");

  assert.equal((await b.post("/api/panel/admin/logout")).status, 204);
  assert.equal((await b.get("/api/panel/admin/me")).status, 401);
});

test("superadmin con 2FA: pide el código, rechaza (y audita) el malo, y una cookie abierta sin 2FA deja de valer", async () => {
  const before2fa = await adminSession();
  process.env.PANEL_SUPERADMIN_TOTP_SECRET = TOTP_SECRET;
  assert.equal((await before2fa.get("/api/panel/admin/me")).status, 401, "sesión abierta sin código: ya no vale");

  const step1 = await browser().post("/api/panel/admin/login", { username: "root", password: ADMIN_PASSWORD });
  assert.deepEqual(step1.body.data, { status: "totp_required" });
  assert.equal(step1.setCookies.length, 0);

  const code = totp(decodeBase32(TOTP_SECRET)!, Date.now());
  const bad = await browser().post("/api/panel/admin/login", { username: "root", password: ADMIN_PASSWORD, totpCode: code === "000000" ? "111111" : "000000" });
  assert.equal(bad.status, 401);
  const rejected = await withSystem(db, (tx) => tx.select().from(auditLog).where(eq(auditLog.action, "admin_login_rejected")));
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].details.reason, "code_invalid");

  resetTotpReplay();
  const b = browser();
  const ok = await b.post("/api/panel/admin/login", { username: "root", password: ADMIN_PASSWORD, totpCode: code });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body.data.me, { username: "root", totpEnabled: true });
  assert.equal((await b.get("/api/panel/admin/me")).status, 200);
});

test("superadmin: crea un negocio con su sucursal y horario default, invita al dueño, y el dueño acepta y entra", async () => {
  const admin = await adminSession();
  const input = newBusiness();
  const res = await admin.post("/api/panel/admin/businesses", input);
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const summary = res.body.data;
  assert.equal(summary.name, "Clínica Dental Sonrisa");
  assert.equal(summary.slug, "clinica-dental-sonrisa");
  assert.equal(summary.industry, "dental");
  assert.equal(summary.currency, "CRC");
  assert.equal(summary.country, "CR");
  assert.equal(summary.timezone, "America/Costa_Rica");
  assert.equal(summary.status, "active");
  assert.equal(summary.locationCount, 1);

  // En la base: sucursal con su horario, dueño sin clave con membresía de dueño, rastro.
  const stored = await withSystem(db, async (tx) => ({
    locations: await tx.select().from(locations).where(eq(locations.businessId, summary.id)),
    hours: await tx.select().from(locationHours).where(eq(locationHours.businessId, summary.id)),
    owner: (await tx.select().from(users).where(eq(users.email, input.ownerEmail)))[0],
    memberships: await tx.select().from(memberships).where(eq(memberships.businessId, summary.id)),
    audit: await tx.select().from(auditLog).where(and(eq(auditLog.businessId, summary.id), eq(auditLog.action, "business_created"))),
  }));
  assert.deepEqual(stored.locations.map((l) => [l.name, l.timezone]), [["Sede Central", "America/Costa_Rica"]]);
  assert.deepEqual(stored.hours.map((h) => h.weekday).sort(), [1, 2, 3, 4, 5, 6], "lunes a sábado");
  assert.equal(stored.owner.passwordHash, null);
  assert.equal(stored.owner.name, "Dra. Sonrisa");
  assert.deepEqual(stored.memberships.map((m) => [m.userId, m.role, m.active]), [[stored.owner.id, "owner", true]]);
  assert.equal(stored.audit.length, 1);
  assert.equal(stored.audit[0].actor, "superadmin:root");

  const list = (await admin.get("/api/panel/admin/businesses")).body.data;
  assert.equal(list[0].id, summary.id, "el más nuevo primero");

  // El dueño recibe la invitación, la acepta y queda adentro como dueño.
  await waitFor(() => getTestOutbox().some((m) => m.to === input.ownerEmail), "invitación al dueño");
  const mail = getTestOutbox().find((m) => m.to === input.ownerEmail)!;
  assert.match(mail.subject, /Te invitaron a Clínica Dental Sonrisa/);
  const token = /accept-invitation\?token=([A-Za-z0-9_-]{43})/.exec(mail.text)![1];
  const owner = browser();
  const accepted = await owner.post("/api/panel/auth/invitations/accept", { token, name: "Dra. Sonrisa", password: "clave-de-la-duena-1", acceptTerms: true });
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
  assert.equal(accepted.body.data.role, "owner");
  assert.equal(accepted.body.data.business.id, summary.id);
  assert.equal(accepted.body.data.business.industry, "dental");
  assert.equal(accepted.body.data.allLocations, true);
  assert.deepEqual(accepted.body.data.locations.map((l: { name: string }) => l.name), ["Sede Central"]);

  // Mismo nombre otra vez: slug con sufijo.
  const twin = await admin.post("/api/panel/admin/businesses", newBusiness());
  assert.equal(twin.status, 201);
  assert.equal(twin.body.data.slug, "clinica-dental-sonrisa-2");
});

test("superadmin: validación del alta y atomicidad (si la invitación falla, no queda un negocio a medias)", async () => {
  const admin = await adminSession();
  const bad = await admin.post("/api/panel/admin/businesses", newBusiness({ timezone: "Marte/Olympus", industry: "lavacar", currency: "colones" }));
  assert.equal(bad.status, 400);
  assert.ok(bad.body.fields["body.timezone"]);
  assert.ok(bad.body.fields["body.industry"]);
  assert.ok(bad.body.fields["body.currency"]);

  const disabled = await createTestUser(db, { active: false });
  const countBefore = (await withSystem(db, (tx) => tx.select({ id: businesses.id }).from(businesses))).length;
  const failed = await admin.post("/api/panel/admin/businesses", newBusiness({ name: "Negocio Fallido", ownerEmail: disabled.email }));
  assert.equal(failed.status, 409);
  assert.equal(failed.body.code, "user_inactive");
  const countAfter = (await withSystem(db, (tx) => tx.select({ id: businesses.id }).from(businesses))).length;
  assert.equal(countAfter, countBefore, "rollback: ni negocio ni sucursal");
});

test("superadmin: rate limit del login (5 fallos → 429)", async () => {
  const b = browser();
  for (let i = 0; i < 5; i++) assert.equal((await b.post("/api/panel/admin/login", { username: "root", password: `mala-${i}` })).status, 401);
  const blocked = await b.post("/api/panel/admin/login", { username: "root", password: ADMIN_PASSWORD });
  assert.equal(blocked.status, 429);
  assert.equal(blocked.body.code, "too_many_attempts");
});
