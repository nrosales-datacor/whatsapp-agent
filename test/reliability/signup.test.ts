import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { and, eq } from "drizzle-orm";

// ─────────────────────────────────────────────────────────────────────────────
// Alta self-service (I6.7) de punta a punta: la request encola el correo (outbox), el
// worker real lo manda con el proveedor `log` y el test lee el link. Base como
// `app_runtime`.
//
//   • Apagada (sin SIGNUP_ENABLED) → 404 y la config pública lo dice.
//   • El alta crea lo mismo que el superadmin (sucursal con horario, plantilla del rubro,
//     catálogo, métodos de pago) con el plan elegido, en prueba con fecha de fin y la cuenta
//     dueña SIN verificar: el login responde 403 `email_not_verified` hasta usar el link.
//   • El link vale una vez; reenviar responde 204 siempre; restablecer la clave también
//     verifica.
//   • Un correo que ya tiene cuenta: misma respuesta, nada nuevo, aviso a esa cuenta.
//   • Tope por IP (429) y validación de lo que se manda.
//   • La aceptación de términos y privacidad queda guardada con versión y fecha
//     (`legal_acceptances` + el audit `business_signed_up`) y `me.legal` la refleja.
// ─────────────────────────────────────────────────────────────────────────────

process.env.TRUST_PROXY = "loopback";
process.env.PANEL_SESSION_SECRET = "test-signup-session-secret-0123456789ab";
process.env.TOKENS_ENCRYPTION_KEY = "a".repeat(64);
process.env.PANEL_LOGIN_RATE_LIMIT_MAX_IP = "200";
process.env.PUBLIC_BASE_URL = "https://app.example.test";
delete process.env.SIGNUP_ENABLED;
delete process.env.SIGNUP_TRIAL_DAYS;

const { createAppHandler } = await import("../../src/app");
const { registerJobHandlers } = await import("../../src/jobs");
const { businesses, locations, locationHours } = await import("../../src/modules/business/schema");
const { services } = await import("../../src/modules/catalog/schema");
const { paymentMethods } = await import("../../src/modules/sales/schema");
const { legalAcceptances, memberships, users } = await import("../../src/modules/team/schema");
const { LEGAL_VERSION } = await import("../../src/platform/legal");
const { auditLog } = await import("../../src/platform/db/schema");
const { withSystem } = await import("../../src/platform/db/scope");
const { clearTestOutbox, getTestOutbox } = await import("../../src/platform/email/email");
const { _resetJobHandlersForTests } = await import("../../src/platform/queue/handlers");
const { startQueueWorker } = await import("../../src/platform/queue/worker");
const { _resetShutdownForTests } = await import("../../src/platform/net/shutdown");
const { createEphemeralDb } = await import("../helpers/pgliteDb");
const { Browser, startTestServer } = await import("../helpers/panelClient");
const { sleep, silenceConsole, waitFor } = await import("../helpers/queue");
const { createTestBusiness, createTestMember, uniqueEmail } = await import("../helpers/identityFixtures");

const base = await createEphemeralDb();
const { db } = base;
let app: Awaited<ReturnType<typeof startTestServer>>;
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
  process.env.SIGNUP_ENABLED = "1";
});

const API = "/api/panel";
const PASSWORD = "clave-del-alta-1";

function signupBody(overrides: Record<string, unknown> = {}) {
  return {
    businessName: "Clínica Sonrisa",
    industry: "dental",
    country: "CR",
    currency: "CRC",
    timezone: "America/Costa_Rica",
    plan: "pro",
    ownerName: "Dra. Ana Mora",
    email: uniqueEmail("alta"),
    password: PASSWORD,
    acceptTerms: true,
    ...overrides,
  };
}

async function tokenFromEmail(to: string, path: string): Promise<string> {
  await waitFor(() => getTestOutbox().some((m) => m.to === to), `correo a ${to}`);
  const mail = getTestOutbox().filter((m) => m.to === to).at(-1)!;
  const match = new RegExp(`https://app\\.example\\.test${path.replace(/\//g, "\\/")}\\?token=([A-Za-z0-9_-]{43})`).exec(mail.text);
  assert.ok(match, `el correo trae el link ${path}:\n${mail.text}`);
  return match[1];
}

async function userOf(email: string) {
  const [row] = await withSystem(db, (tx) => tx.select().from(users).where(eq(users.email, email)));
  return row;
}

test("apagada: config pública `enabled: false` y el alta responde 404 sin crear nada", async () => {
  delete process.env.SIGNUP_ENABLED;
  const b = new Browser(app.baseUrl);
  const config = await b.get(`${API}/auth/signup/config`);
  assert.equal(config.status, 200);
  assert.equal(config.body.data.enabled, false);
  const body = signupBody();
  const res = await b.post(`${API}/auth/signup`, body);
  assert.equal(res.status, 404);
  assert.equal(await userOf(body.email), undefined);
});

test("alta: el negocio completo en prueba, la dueña sin verificar; el login espera la verificación", async () => {
  const b = new Browser(app.baseUrl);
  const config = await b.get(`${API}/auth/signup/config`);
  assert.deepEqual(config.body.data, { enabled: true, trialDays: 14 });

  const body = signupBody({ email: uniqueEmail("Alta").toUpperCase() });
  const email = body.email.toLowerCase();
  const before = Date.now();
  const res = await b.post(`${API}/auth/signup`, body);
  assert.equal(res.status, 202, JSON.stringify(res.body));
  assert.deepEqual(res.body.data, { status: "verification_sent" });

  const user = await userOf(email);
  assert.ok(user, "la cuenta existe con el correo en minúsculas");
  assert.equal(user.emailVerificationPending, true);
  assert.equal(user.name, "Dra. Ana Mora");
  const [membership] = await withSystem(db, (tx) => tx.select().from(memberships).where(eq(memberships.userId, user.id)));
  assert.equal(membership.role, "owner");
  const businessId = membership.businessId;
  const [biz] = await withSystem(db, (tx) => tx.select().from(businesses).where(eq(businesses.id, businessId)));
  assert.equal(biz.name, "Clínica Sonrisa");
  assert.equal(biz.industry, "dental");
  assert.equal(biz.plan, "pro");
  assert.equal(biz.billingStatus, "trial");
  assert.equal(biz.status, "active");
  const trialMs = biz.trialEndsAt!.getTime() - before;
  assert.ok(trialMs > 13.9 * 86_400_000 && trialMs < 14.1 * 86_400_000, "prueba de 14 días");
  assert.equal(biz.terminology.client, "paciente", "terminología de la plantilla dental");

  const [locs, hours, svc, methods, audit] = await withSystem(db, (tx) =>
    Promise.all([
      tx.select().from(locations).where(eq(locations.businessId, businessId)),
      tx.select().from(locationHours).where(eq(locationHours.businessId, businessId)),
      tx.select().from(services).where(eq(services.businessId, businessId)),
      tx.select().from(paymentMethods).where(eq(paymentMethods.businessId, businessId)),
      tx.select().from(auditLog).where(and(eq(auditLog.businessId, businessId), eq(auditLog.action, "business_signed_up"))),
    ]),
  );
  assert.equal(locs.length, 1);
  assert.equal(locs[0].name, "Principal");
  assert.ok(hours.length > 0, "horario default de la sucursal");
  assert.ok(svc.length > 0, "catálogo de ejemplo del rubro");
  assert.ok(methods.length > 0, "métodos de pago default");
  assert.equal(audit.length, 1);

  // Sin verificar: la clave correcta responde 403 con un código claro; la incorrecta, el 401 genérico.
  const login = await b.post(`${API}/auth/login`, { email, password: PASSWORD });
  assert.equal(login.status, 403);
  assert.equal(login.body.code, "email_not_verified");
  assert.equal((await b.post(`${API}/auth/login`, { email, password: "otra-clave-mala" })).status, 401);

  const token = await tokenFromEmail(email, "/panel/verify-email");
  const mail = getTestOutbox().find((m) => m.to === email)!;
  assert.match(mail.subject, /Confirmá tu correo/);
  assert.equal((await b.post(`${API}/auth/verify-email`, { token })).status, 204);
  assert.equal((await userOf(email)).emailVerificationPending, false);
  // El link vale una sola vez.
  const reused = await b.post(`${API}/auth/verify-email`, { token });
  assert.equal(reused.status, 400);
  assert.equal(reused.body.code, "invalid_token");

  const ok = await b.post(`${API}/auth/login`, { email, password: PASSWORD });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.data.me.business.id, businessId);
  assert.equal(ok.body.data.me.role, "owner");
  assert.equal(ok.body.data.me.plan.billingStatus, "trial");
  assert.ok(ok.body.data.me.plan.trialEndsAt);
  // Aceptó en el alta: el panel no le pide aceptar de nuevo.
  assert.equal(ok.body.data.me.legal.version, LEGAL_VERSION);
  assert.equal(ok.body.data.me.legal.mustAccept, false);
  assert.equal(ok.body.data.me.legal.accepted.termsVersion, LEGAL_VERSION);
});

test("alta: la aceptación de términos y privacidad queda consultable con versión y fecha", async () => {
  const body = signupBody();
  const before = Date.now();
  assert.equal((await new Browser(app.baseUrl).post(`${API}/auth/signup`, body)).status, 202);
  const user = await userOf(body.email);
  const [membership] = await withSystem(db, (tx) => tx.select().from(memberships).where(eq(memberships.userId, user.id)));
  const businessId = membership.businessId;

  const [rows, [audit]] = await withSystem(db, (tx) =>
    Promise.all([
      tx.select().from(legalAcceptances).where(eq(legalAcceptances.businessId, businessId)),
      tx.select().from(auditLog).where(and(eq(auditLog.businessId, businessId), eq(auditLog.action, "business_signed_up"))),
    ]),
  );
  assert.equal(rows.length, 1, "una aceptación por el alta");
  const [row] = rows;
  assert.equal(row.userId, user.id);
  assert.equal(row.role, "owner");
  assert.equal(row.context, "signup");
  assert.equal(row.termsVersion, LEGAL_VERSION);
  assert.equal(row.privacyVersion, LEGAL_VERSION);
  assert.ok(row.acceptedAt.getTime() >= before - 1000 && row.acceptedAt.getTime() <= Date.now() + 1000, "fecha de aceptación = el alta");

  // El audit del alta lleva lo mismo (sin datos personales).
  assert.equal(audit.details.termsVersion, LEGAL_VERSION);
  assert.equal(audit.details.privacyVersion, LEGAL_VERSION);
  assert.equal(audit.details.acceptedAt, row.acceptedAt.toISOString());
  const [legalAudit] = await withSystem(db, (tx) =>
    tx.select().from(auditLog).where(and(eq(auditLog.businessId, businessId), eq(auditLog.action, "legal_accepted"))),
  );
  assert.deepEqual(legalAudit.details, { context: "signup", role: "owner", termsVersion: LEGAL_VERSION, privacyVersion: LEGAL_VERSION });
  assert.equal(legalAudit.actor, `user:${user.id}`);
});

test("plan Básico y días de prueba del entorno", async () => {
  process.env.SIGNUP_TRIAL_DAYS = "30";
  try {
    const body = signupBody({ plan: "basic", industry: "nails", businessName: "Uñas Bellas" });
    assert.equal((await new Browser(app.baseUrl).post(`${API}/auth/signup`, body)).status, 202);
    const user = await userOf(body.email);
    const [membership] = await withSystem(db, (tx) => tx.select().from(memberships).where(eq(memberships.userId, user.id)));
    const [biz] = await withSystem(db, (tx) => tx.select().from(businesses).where(eq(businesses.id, membership.businessId)));
    assert.equal(biz.plan, "basic");
    const days = (biz.trialEndsAt!.getTime() - Date.now()) / 86_400_000;
    assert.ok(days > 29.9 && days < 30.1);
  } finally {
    delete process.env.SIGNUP_TRIAL_DAYS;
  }
});

test("correo que ya tiene cuenta: la misma respuesta, nada nuevo y un aviso a esa cuenta", async () => {
  const existing = await createTestBusiness(db);
  const owner = await createTestMember(db, { businessId: existing.businessId, role: "owner" });
  const [{ n: before }] = await withSystem(db, (tx) => tx.$count(businesses).then((n) => [{ n }]));
  const res = await new Browser(app.baseUrl).post(`${API}/auth/signup`, signupBody({ email: owner.email }));
  assert.equal(res.status, 202);
  assert.deepEqual(res.body.data, { status: "verification_sent" });
  const after = await withSystem(db, (tx) => tx.$count(businesses));
  assert.equal(after, before, "no se creó ningún negocio");
  await waitFor(() => getTestOutbox().some((m) => m.to === owner.email), "aviso a la cuenta existente");
  const mail = getTestOutbox().find((m) => m.to === owner.email)!;
  assert.match(mail.subject, /Ya tenés una cuenta/);
  assert.ok(mail.text.includes("https://app.example.test/panel/forgot-password"));
  // La cuenta existente sigue entrando.
  assert.equal((await new Browser(app.baseUrl).post(`${API}/auth/login`, { email: owner.email, password: owner.password })).status, 200);
});

test("reenviar el link: 204 siempre; solo le llega a una cuenta sin verificar; el link viejo deja de valer", async () => {
  const body = signupBody();
  const b = new Browser(app.baseUrl);
  assert.equal((await b.post(`${API}/auth/signup`, body)).status, 202);
  const first = await tokenFromEmail(body.email, "/panel/verify-email");
  clearTestOutbox();

  assert.equal((await b.post(`${API}/auth/verify-email/resend`, { email: body.email })).status, 204);
  const second = await tokenFromEmail(body.email, "/panel/verify-email");
  assert.notEqual(second, first);
  assert.equal((await b.post(`${API}/auth/verify-email`, { token: first })).status, 400, "solo vale el último link");

  // Sin cuenta, o ya verificada: misma respuesta y ningún correo.
  clearTestOutbox();
  const nobody = uniqueEmail("nadie");
  assert.equal((await b.post(`${API}/auth/verify-email/resend`, { email: nobody })).status, 204);
  const biz = await createTestBusiness(db);
  const verified = await createTestMember(db, { businessId: biz.businessId, role: "owner" });
  assert.equal((await b.post(`${API}/auth/verify-email/resend`, { email: verified.email })).status, 204);
  await sleep(200);
  assert.equal(getTestOutbox().length, 0);

  assert.equal((await b.post(`${API}/auth/verify-email`, { token: second })).status, 204);
});

test("restablecer la clave también verifica el correo (el link llegó a esa casilla)", async () => {
  const body = signupBody();
  const b = new Browser(app.baseUrl);
  assert.equal((await b.post(`${API}/auth/signup`, body)).status, 202);
  await tokenFromEmail(body.email, "/panel/verify-email");
  clearTestOutbox();
  assert.equal((await b.post(`${API}/auth/password/forgot`, { email: body.email })).status, 204);
  const token = await tokenFromEmail(body.email, "/panel/reset-password");
  assert.equal((await b.post(`${API}/auth/password/reset`, { token, password: "clave-nueva-12345" })).status, 204);
  assert.equal((await userOf(body.email)).emailVerificationPending, false);
  assert.equal((await b.post(`${API}/auth/login`, { email: body.email, password: "clave-nueva-12345" })).status, 200);
});

test("validación: términos sin aceptar, clave corta, rubro, plan o zona inválidos → 400 y no crea nada", async () => {
  const b = new Browser(app.baseUrl);
  const cases = [
    signupBody({ acceptTerms: false }),
    signupBody({ password: "corta" }),
    signupBody({ industry: "lavacar" }),
    signupBody({ plan: "gratis" }),
    signupBody({ timezone: "Marte/Olympus" }),
    signupBody({ email: "no-es-un-correo" }),
  ];
  for (const body of cases) {
    const res = await b.post(`${API}/auth/signup`, body);
    assert.equal(res.status, 400, JSON.stringify(body));
    if (typeof body.email === "string" && body.email.includes("@")) assert.equal(await userOf(body.email), undefined);
  }
  // Sin la casilla (o con cualquier cosa que no sea `true`) no hay alta.
  for (const acceptTerms of [undefined, "true", 1]) {
    const res = await b.post(`${API}/auth/signup`, signupBody({ acceptTerms }));
    assert.equal(res.status, 400);
    assert.ok(res.body.fields?.["body.acceptTerms"], JSON.stringify(res.body));
  }
});

test("tope por IP: altas seguidas desde la misma IP terminan en 429", async () => {
  const b = new Browser(app.baseUrl);
  let limited = false;
  for (let i = 0; i < 8 && !limited; i++) {
    const res = await b.post(`${API}/auth/signup`, signupBody());
    if (res.status === 429) {
      limited = true;
      assert.equal(res.body.code, "too_many_attempts");
      assert.ok(Number(res.headers.get("retry-after")) > 0);
    } else assert.equal(res.status, 202);
  }
  assert.ok(limited, "a partir de la 5.ª alta desde la misma IP hay que esperar");
  // Otra IP no está frenada.
  assert.equal((await new Browser(app.baseUrl).post(`${API}/auth/signup`, signupBody())).status, 202);
});
