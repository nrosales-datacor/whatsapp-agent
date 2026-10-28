import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { and, eq } from "drizzle-orm";

// ─────────────────────────────────────────────────────────────────────────────
// Alta self-service (I6) por HTTP: crea el negocio con la plantilla del rubro (sucursal con
// horario, servicios, campos, métodos de pago), la dueña con el correo sin verificar y la
// prueba; la verificación por enlace de un solo uso deja la sesión; anti-abuso (honeypot,
// rate limit por IP y por correo, dominio del correo) y la misma respuesta exista o no el
// correo. El DNS del chequeo de correo es un doble. Base como `app_runtime`.
// ─────────────────────────────────────────────────────────────────────────────

process.env.TRUST_PROXY = "loopback";
process.env.PANEL_SESSION_SECRET = "test-signup-session-secret-0123456789ab";
process.env.TOKENS_ENCRYPTION_KEY = "d".repeat(64);
process.env.PANEL_LOGIN_RATE_LIMIT_MAX_IP = "500";
process.env.PUBLIC_BASE_URL = "https://app.example.test";
delete process.env.TRIAL_DAYS;

const { createAppHandler } = await import("../../src/app");
const { businesses, customFields, locationHours, locations } = await import("../../src/modules/business/schema");
const { services } = await import("../../src/modules/catalog/schema");
const { paymentMethods } = await import("../../src/modules/sales/schema");
const { memberships, users } = await import("../../src/modules/team/schema");
const { _resetSignupLimitsForTests } = await import("../../src/modules/onboarding");
const { auditLog } = await import("../../src/platform/db/schema");
const { readDailyUsage, USAGE_METRICS } = await import("../../src/platform/observability/dailyUsage");
const { localDate } = await import("../../src/modules/scheduling");
const { jobs } = await import("../../src/platform/queue/schema");
const { withSystem } = await import("../../src/platform/db/scope");
const { createEphemeralDb } = await import("../helpers/pgliteDb");
const { Browser, startTestServer } = await import("../helpers/panelClient");
const { createTestBusiness, createTestMember } = await import("../helpers/identityFixtures");

type TestServer = Awaited<ReturnType<typeof startTestServer>>;

/** DNS de mentira: `clinica.cr` y `correo.cr` reciben correo; `sinmx.cr` no existe; `caido.cr` falla el resolver. */
const resolver = {
  async resolveMx(domain: string) {
    if (domain === "clinica.cr" || domain === "correo.cr") return [{ exchange: `mx.${domain}`, priority: 10 }];
    if (domain === "nulo.cr") return [{ exchange: "", priority: 0 }];
    if (domain === "caido.cr") throw Object.assign(new Error("servfail"), { code: "ESERVFAIL" });
    throw Object.assign(new Error("not found"), { code: "ENOTFOUND" });
  },
  async resolveAddresses(): Promise<string[]> {
    throw Object.assign(new Error("not found"), { code: "ENOTFOUND" });
  },
};

const base = await createEphemeralDb();
const { db } = base;
let app: TestServer;

before(async () => {
  await base.client.exec("SET ROLE app_runtime");
  app = await startTestServer(createAppHandler({ db, role: "all", signup: { emailDomain: { resolver, dnsCheck: true } } }));
});

after(async () => {
  await app?.close();
  await base.close();
});

beforeEach(() => _resetSignupLimitsForTests());

const API = "/api/panel";
let seq = 0;
const email = (domain = "clinica.cr") => `duena-${++seq}-${Date.now() % 100000}@${domain}`;
const browser = () => new Browser(app.baseUrl);

function signupBody(overrides: Record<string, unknown> = {}) {
  return {
    businessName: `Clínica Sonrisa ${++seq}`,
    industry: "dental",
    country: "cr",
    timezone: "America/Costa_Rica",
    currency: "crc",
    ownerName: "Ana Mora",
    email: email(),
    password: "clave-segura-123",
    website: "",
    ...overrides,
  };
}

/** Correos encolados para `to` (outbox: jobs `email.send`). */
async function emailsTo(to: string): Promise<{ subject: string; text: string; html: string }[]> {
  const rows = await withSystem(db, (tx) => tx.select().from(jobs).where(eq(jobs.type, "email.send")));
  return rows
    .map((r) => (r.payload as { message: { to: string; subject: string; text: string; html: string } }).message)
    .filter((m) => m.to === to);
}

/** Token del último enlace de verificación mandado a `to`. */
async function verificationToken(to: string): Promise<string> {
  const mails = await emailsTo(to);
  const last = mails.filter((m) => m.text.includes("/panel/verify-email")).at(-1);
  assert.ok(last, `hay un correo de verificación para ${to}`);
  const match = /https:\/\/app\.example\.test\/panel\/verify-email\?token=([A-Za-z0-9_-]{43})/.exec(last.text);
  assert.ok(match, last.text);
  return match[1];
}

async function businessNamed(name: string) {
  const [row] = await withSystem(db, (tx) => tx.select().from(businesses).where(eq(businesses.name, name)));
  return row;
}

test("alta: crea el negocio con la plantilla, la sucursal con horario, la dueña sin verificar y la prueba de 14 días; manda el enlace", async () => {
  const body = signupBody();
  const res = await browser().post(`${API}/signup`, body);
  assert.equal(res.status, 202, JSON.stringify(res.body));
  assert.deepEqual(res.body.data, { status: "verification_sent" });

  const biz = await businessNamed(body.businessName);
  assert.ok(biz, "se creó el negocio");
  assert.equal(biz.industry, "dental");
  assert.equal(biz.country, "CR");
  assert.equal(biz.currency, "CRC");
  assert.equal(biz.status, "active");
  assert.equal(biz.billingStatus, "trial");
  assert.equal(biz.plan, "basic");
  assert.equal(biz.onboardingDismissedAt, null, "la checklist se muestra en un negocio nuevo");
  const days = (biz.trialEndsAt!.getTime() - Date.now()) / 86_400_000;
  assert.ok(days > 13.9 && days <= 14, `prueba de 14 días (${days})`);
  assert.equal((biz.terminology as { client?: string }).client, "paciente", "terminología de la plantilla dental");

  const counts = await withSystem(db, async (tx) => ({
    locations: await tx.select().from(locations).where(eq(locations.businessId, biz.id)),
    hours: await tx.select().from(locationHours).where(eq(locationHours.businessId, biz.id)),
    services: await tx.select().from(services).where(eq(services.businessId, biz.id)),
    fields: await tx.select().from(customFields).where(eq(customFields.businessId, biz.id)),
    methods: await tx.select().from(paymentMethods).where(eq(paymentMethods.businessId, biz.id)),
    owner: await tx
      .select({ role: memberships.role, unverified: users.emailUnverifiedSince, name: users.name })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(eq(memberships.businessId, biz.id)),
    audit: await tx.select().from(auditLog).where(eq(auditLog.businessId, biz.id)),
  }));
  assert.equal(counts.locations.length, 1);
  assert.equal(counts.locations[0].name, "Principal");
  assert.ok(counts.hours.length > 0, "horario default");
  assert.ok(counts.services.length > 0, "servicios de la plantilla");
  assert.ok(counts.fields.length > 0, "campos de la plantilla");
  assert.ok(counts.methods.length >= 4, "métodos de pago precargados");
  assert.equal(counts.owner.length, 1);
  assert.equal(counts.owner[0].role, "owner");
  assert.equal(counts.owner[0].name, "Ana Mora");
  assert.ok(counts.owner[0].unverified, "correo sin verificar");
  const actions = counts.audit.map((a) => a.action);
  assert.ok(actions.includes("business_created") && actions.includes("trial_started"));
  assert.equal((counts.audit.find((a) => a.action === "business_created")!.details as { source: string }).source, "self_service");

  const mails = await emailsTo(body.email);
  assert.equal(mails.length, 1);
  assert.match(mails[0].subject, /Confirmá tu correo/);
  assert.match(mails[0].text, /14 días/);
  await verificationToken(body.email);
});

test("verificación: sin verificar no entra (403 con la clave buena, 401 genérico con la mala); el enlace deja la sesión una sola vez", async () => {
  const body = signupBody();
  assert.equal((await browser().post(`${API}/signup`, body)).status, 202);

  const early = await browser().post(`${API}/auth/login`, { email: body.email, password: body.password });
  assert.equal(early.status, 403);
  assert.equal(early.body.code, "email_not_verified");
  assert.equal(early.setCookies.length, 0);
  const wrong = await browser().post(`${API}/auth/login`, { email: body.email, password: "otra-clave-999" });
  assert.equal(wrong.status, 401, "sin la clave no revela que la cuenta está pendiente");
  assert.equal(wrong.body.code, "invalid_credentials");

  const token = await verificationToken(body.email);
  const b = browser();
  const verified = await b.post(`${API}/signup/verify`, { token });
  assert.equal(verified.status, 200, JSON.stringify(verified.body));
  const me = verified.body.data;
  assert.equal(me.business.name, body.businessName);
  assert.equal(me.role, "owner");
  assert.equal(me.plan.billingStatus, "trial");
  assert.ok(me.plan.billing.trialEndsAt, "me.plan trae el fin de la prueba");
  assert.equal(me.plan.billing.onlinePayments, false, "sin Stripe configurado");
  assert.equal((await b.get(`${API}/auth/me`)).status, 200, "la cookie quedó");

  const again = await browser().post(`${API}/signup/verify`, { token });
  assert.equal(again.status, 400);
  assert.equal(again.body.code, "invalid_token", "el enlace es de un solo uso");
  const invented = await browser().post(`${API}/signup/verify`, { token: "x".repeat(43) });
  assert.equal(invented.body.code, "invalid_token");

  const login = await browser().post(`${API}/auth/login`, { email: body.email.toUpperCase(), password: body.password });
  assert.equal(login.status, 200, "ya verificada, entra normal");
});

test("métricas: verificar el correo cuenta como login y la dueña como usuaria activa en daily_usage (I5)", async () => {
  const body = signupBody();
  assert.equal((await browser().post(`${API}/signup`, body)).status, 202);
  const biz = await businessNamed(body.businessName);
  const today = localDate(new Date(), biz.timezone);
  const read = (metric: string) => readDailyUsage(db, biz.id, { metric, from: today, to: today });
  // Solo darse de alta (sin abrir el enlace) no es entrar al panel.
  assert.deepEqual(await read(USAGE_METRICS.logins), []);

  const b = browser();
  assert.equal((await b.post(`${API}/signup/verify`, { token: await verificationToken(body.email) })).status, 200);
  assert.deepEqual(await read(USAGE_METRICS.logins), [{ date: today, value: 1 }], "el primer ingreso es por el enlace");
  // Con la sesión del enlace, el panel la cuenta como activa (una vez por día).
  assert.equal((await b.get(`${API}/onboarding`)).status, 200);
  assert.equal((await b.get(`${API}/auth/me`)).status, 200);
  assert.deepEqual(await read(USAGE_METRICS.activeUsers), [{ date: today, value: 1 }]);

  // Los siguientes ingresos, por /auth/login como cualquiera.
  assert.equal((await browser().post(`${API}/auth/login`, { email: body.email, password: body.password })).status, 200);
  assert.deepEqual(await read(USAGE_METRICS.logins), [{ date: today, value: 2 }]);
});

test("honeypot: responde lo mismo y no crea nada", async () => {
  const body = signupBody({ website: "https://spam.example" });
  const res = await browser().post(`${API}/signup`, body);
  assert.equal(res.status, 202);
  assert.deepEqual(res.body.data, { status: "verification_sent" });
  assert.equal(await businessNamed(body.businessName), undefined);
  assert.equal((await emailsTo(body.email)).length, 0);
});

test("correo existente: misma respuesta, no crea negocio y le avisa por correo; si estaba pendiente, le reenvía el enlace", async () => {
  const biz = await createTestBusiness(db);
  const member = await createTestMember(db, { businessId: biz.businessId, role: "owner", email: email("correo.cr") });
  const body = signupBody({ email: member.email.toUpperCase() });
  const res = await browser().post(`${API}/signup`, body);
  assert.equal(res.status, 202);
  assert.deepEqual(res.body.data, { status: "verification_sent" }, "idéntica a un alta nueva");
  assert.equal(await businessNamed(body.businessName), undefined, "no se creó nada");
  const mails = await emailsTo(member.email);
  assert.equal(mails.length, 1);
  assert.match(mails[0].subject, /Ya tenés una cuenta/);
  assert.match(mails[0].text, /\/panel\/forgot-password/);
  assert.equal((await browser().post(`${API}/auth/login`, { email: member.email, password: member.password })).status, 200, "su clave no cambió");

  // Pendiente de verificar: el segundo intento reenvía el enlace (el viejo deja de servir).
  const pending = signupBody();
  await browser().post(`${API}/signup`, pending);
  const first = await verificationToken(pending.email);
  const retry = await browser().post(`${API}/signup`, { ...pending, businessName: "Otro nombre", password: "una-clave-distinta-1" });
  assert.equal(retry.status, 202);
  assert.equal(await businessNamed("Otro nombre"), undefined);
  const second = await verificationToken(pending.email);
  assert.notEqual(first, second);
  assert.equal((await browser().post(`${API}/signup/verify`, { token: first })).body.code, "invalid_token");
  assert.equal((await browser().post(`${API}/signup/verify`, { token: second })).status, 200);
});

test("dominio del correo: reservado, descartable, sin servidor o con MX nulo → 400 en body.email; con el DNS caído pasa", async () => {
  for (const address of ["ana@example.com", "ana@algo.test", "ana@mailinator.com", `ana@sinmx.cr`, "ana@nulo.cr", "ana@10.0.0.1"]) {
    const res = await browser().post(`${API}/signup`, signupBody({ email: address }));
    assert.equal(res.status, 400, address);
    assert.ok(res.body.fields?.["body.email"], `${address}: ${JSON.stringify(res.body)}`);
  }
  const res = await browser().post(`${API}/signup`, signupBody({ email: email("caido.cr") }));
  assert.equal(res.status, 202, "un fallo del resolver no frena a una persona real");
});

test("validación: clave corta, rubro inexistente, zona y moneda inválidas → 400 con los campos", async () => {
  const res = await browser().post(`${API}/signup`, signupBody({ password: "corta", industry: "carwash", timezone: "Marte/Olimpo", currency: "pesos" }));
  assert.equal(res.status, 400);
  for (const field of ["body.password", "body.industry", "body.timezone", "body.currency"]) assert.ok(res.body.fields[field], field);
});

test("rate limit: por IP (el 6.º intento en la hora) y por correo desde IPs distintas (el 4.º)", async () => {
  const b = browser();
  for (let i = 0; i < 5; i++) {
    // Dominio reservado: 400 rápido, pero el intento cuenta igual (el límite va primero).
    assert.equal((await b.post(`${API}/signup`, signupBody({ email: `x${i}@algo.test` }))).status, 400);
  }
  const blocked = await b.post(`${API}/signup`, signupBody());
  assert.equal(blocked.status, 429);
  assert.equal(blocked.body.code, "too_many_attempts");
  assert.ok(Number(blocked.headers.get("retry-after")) > 0);

  const target = "victima@algo.test";
  for (let i = 0; i < 3; i++) assert.equal((await browser().post(`${API}/signup`, signupBody({ email: target }))).status, 400);
  assert.equal((await browser().post(`${API}/signup`, signupBody({ email: target.toUpperCase() }))).status, 429, "por correo, desde otra IP");
});

test("reenvío: 204 siempre; solo a una cuenta pendiente le llega un enlace nuevo", async () => {
  const pending = signupBody();
  await browser().post(`${API}/signup`, pending);
  const before = (await emailsTo(pending.email)).length;
  assert.equal((await browser().post(`${API}/signup/resend`, { email: pending.email })).status, 204);
  assert.equal((await emailsTo(pending.email)).length, before + 1);

  const ghost = email();
  assert.equal((await browser().post(`${API}/signup/resend`, { email: ghost })).status, 204, "no revela que no existe");
  assert.equal((await emailsTo(ghost)).length, 0);

  const biz = await createTestBusiness(db);
  const member = await createTestMember(db, { businessId: biz.businessId, role: "owner" });
  assert.equal((await browser().post(`${API}/signup/resend`, { email: member.email })).status, 204);
  assert.equal((await emailsTo(member.email)).length, 0, "una cuenta verificada no recibe nada");
});

test("restablecer la clave también verifica el correo de un alta pendiente", async () => {
  const pending = signupBody();
  await browser().post(`${API}/signup`, pending);
  assert.equal((await browser().post(`${API}/auth/password/forgot`, { email: pending.email })).status, 204);
  const mail = (await emailsTo(pending.email)).filter((m) => m.text.includes("/panel/reset-password")).at(-1);
  const token = /reset-password\?token=([A-Za-z0-9_-]{43})/.exec(mail!.text)![1];
  assert.equal((await browser().post(`${API}/auth/password/reset`, { token, password: "clave-recuperada-9" })).status, 204);
  const [user] = await withSystem(db, (tx) => tx.select().from(users).where(and(eq(users.email, pending.email))));
  assert.equal(user.emailUnverifiedSince, null);
  assert.equal((await browser().post(`${API}/auth/login`, { email: pending.email, password: "clave-recuperada-9" })).status, 200);
});

test("opciones del formulario: rubros de las plantillas con su nombre y los días de prueba", async () => {
  const res = await browser().get(`${API}/signup/options`);
  assert.equal(res.status, 200);
  assert.equal(res.body.data.trialDays, 14);
  assert.deepEqual(
    res.body.data.industries.map((i: { id: string }) => i.id).sort(),
    ["aesthetics", "dental", "generic", "nails"],
  );
  assert.ok(res.body.data.industries.find((i: { id: string; label: string }) => i.id === "dental").label);
});
