import assert from "node:assert/strict";
import { after, afterEach, before, test } from "node:test";
import { and, eq } from "drizzle-orm";

// ─────────────────────────────────────────────────────────────────────────────
// Reaceptación de términos y aviso de privacidad (Carril P, "privacidad y términos"), con
// la app real sobre PGlite como `app_runtime`:
//
//   • Quien nunca aceptó en el negocio (cuentas de antes de esta función) ve
//     `me.legal.mustAccept` y acepta desde el aviso del panel.
//   • Subir `LEGAL_VERSION` hace que el panel le pida aceptar de nuevo a la dueña (y a cada
//     persona del equipo: cada una acepta por sí misma).
//   • `POST /auth/legal/accept` con la versión que vio: vieja → 409 sin registrar nada;
//     vigente → fila `reacceptance` + audit `legal_accepted`; repetirla no duplica.
//   • Sin sesión → 401.
// ─────────────────────────────────────────────────────────────────────────────

process.env.TRUST_PROXY = "loopback";
process.env.PANEL_SESSION_SECRET = "test-legal-acceptance-secret-0123456789";
process.env.TOKENS_ENCRYPTION_KEY = "c".repeat(64);
process.env.PANEL_LOGIN_RATE_LIMIT_MAX_IP = "200";

const { createAppHandler } = await import("../../src/app");
const { legalAcceptances } = await import("../../src/modules/team/schema");
const { auditLog } = await import("../../src/platform/db/schema");
const { withSystem } = await import("../../src/platform/db/scope");
const { LEGAL_VERSION, _setLegalVersionForTests } = await import("../../src/platform/legal");
const { _resetShutdownForTests } = await import("../../src/platform/net/shutdown");
const { createEphemeralDb } = await import("../helpers/pgliteDb");
const { Browser, startTestServer } = await import("../helpers/panelClient");
const { silenceConsole } = await import("../helpers/queue");
const { createTestBusiness, createTestMember } = await import("../helpers/identityFixtures");

const base = await createEphemeralDb();
const { db } = base;
let app: Awaited<ReturnType<typeof startTestServer>>;
let restoreConsole: () => void;

before(async () => {
  await base.client.exec("SET ROLE app_runtime");
  restoreConsole = silenceConsole();
  _resetShutdownForTests();
  app = await startTestServer(createAppHandler({ db, role: "web" }));
});

after(async () => {
  _setLegalVersionForTests(null);
  await app?.close();
  restoreConsole();
  await base.close();
});

afterEach(() => _setLegalVersionForTests(null));

const API = "/api/panel";
const NEXT_VERSION = "2099-01-01";

async function loggedIn(email: string, password: string) {
  const b = new Browser(app.baseUrl);
  const res = await b.post(`${API}/auth/login`, { email, password });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return b;
}

async function acceptancesOf(businessId: string, userId: string) {
  return withSystem(db, (tx) =>
    tx
      .select()
      .from(legalAcceptances)
      .where(and(eq(legalAcceptances.businessId, businessId), eq(legalAcceptances.userId, userId))),
  );
}

async function legalAudits(businessId: string) {
  return withSystem(db, (tx) => tx.select().from(auditLog).where(and(eq(auditLog.businessId, businessId), eq(auditLog.action, "legal_accepted"))));
}

test("sin aceptación previa: el panel la pide; aceptar la versión vigente la registra y apaga el aviso", async () => {
  const biz = await createTestBusiness(db);
  const owner = await createTestMember(db, { businessId: biz.businessId, role: "owner" });
  const b = await loggedIn(owner.email, owner.password!);

  const me = (await b.get(`${API}/auth/me`)).body.data;
  assert.deepEqual(me.legal, { version: LEGAL_VERSION, accepted: null, mustAccept: true });

  const res = await b.post(`${API}/auth/legal/accept`, { version: LEGAL_VERSION });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.data.mustAccept, false);
  assert.equal(res.body.data.accepted.termsVersion, LEGAL_VERSION);
  assert.equal(res.body.data.accepted.privacyVersion, LEGAL_VERSION);
  assert.equal((await b.get(`${API}/auth/me`)).body.data.legal.mustAccept, false);

  const rows = await acceptancesOf(biz.businessId, owner.userId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].context, "reacceptance");
  assert.equal(rows[0].role, "owner");

  // Ya al día: repetir (otra pestaña, un reintento) no agrega otra fila.
  assert.equal((await b.post(`${API}/auth/legal/accept`, { version: LEGAL_VERSION })).status, 200);
  assert.equal((await acceptancesOf(biz.businessId, owner.userId)).length, 1);
});

test("subir LEGAL_VERSION: la dueña tiene que aceptar de nuevo; la reaceptación queda auditada", async () => {
  const biz = await createTestBusiness(db);
  const owner = await createTestMember(db, { businessId: biz.businessId, role: "owner" });
  const staff = await createTestMember(db, { businessId: biz.businessId, role: "staff", locationIds: [biz.locationIds[0]] });
  const ownerB = await loggedIn(owner.email, owner.password!);
  const staffB = await loggedIn(staff.email, staff.password!);
  assert.equal((await ownerB.post(`${API}/auth/legal/accept`, { version: LEGAL_VERSION })).status, 200);
  assert.equal((await staffB.post(`${API}/auth/legal/accept`, { version: LEGAL_VERSION })).status, 200);
  assert.equal((await ownerB.get(`${API}/auth/me`)).body.data.legal.mustAccept, false);

  // Cambian los textos: la versión vigente pasa a ser más nueva que la aceptada.
  _setLegalVersionForTests(NEXT_VERSION);
  const pending = (await ownerB.get(`${API}/auth/me`)).body.data.legal;
  assert.equal(pending.version, NEXT_VERSION);
  assert.equal(pending.mustAccept, true);
  assert.equal(pending.accepted.termsVersion, LEGAL_VERSION, "se ve lo último que aceptó");
  // El login también lo trae (el panel pinta el aviso desde la primera pantalla).
  const relogin = await new Browser(app.baseUrl).post(`${API}/auth/login`, { email: owner.email, password: owner.password });
  assert.equal(relogin.body.data.me.legal.mustAccept, true);

  // La versión que vio ya no es la vigente → 409 y no se registra nada.
  const auditsBefore = (await legalAudits(biz.businessId)).length;
  const stale = await ownerB.post(`${API}/auth/legal/accept`, { version: LEGAL_VERSION });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.code, "legal_version_changed");
  assert.equal((await acceptancesOf(biz.businessId, owner.userId)).length, 1);
  // Una versión con otra forma ni llega a la base.
  assert.equal((await ownerB.post(`${API}/auth/legal/accept`, { version: "mañana" })).status, 400);

  const ok = await ownerB.post(`${API}/auth/legal/accept`, { version: NEXT_VERSION });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.data.mustAccept, false);
  assert.equal(ok.body.data.accepted.termsVersion, NEXT_VERSION);
  assert.equal((await ownerB.get(`${API}/auth/me`)).body.data.legal.mustAccept, false);

  const rows = await acceptancesOf(biz.businessId, owner.userId);
  assert.deepEqual(
    rows.map((r) => [r.context, r.termsVersion, r.privacyVersion]).sort(),
    [
      ["reacceptance", LEGAL_VERSION, LEGAL_VERSION],
      ["reacceptance", NEXT_VERSION, NEXT_VERSION],
    ],
    "la aceptación vieja queda como prueba de lo que aceptó antes",
  );
  const audits = await legalAudits(biz.businessId);
  assert.equal(audits.length, auditsBefore + 1);
  const last = audits.find((a) => a.details.termsVersion === NEXT_VERSION)!;
  assert.equal(last.actor, `user:${owner.userId}`);
  assert.deepEqual(last.details, { context: "reacceptance", role: "owner", termsVersion: NEXT_VERSION, privacyVersion: NEXT_VERSION });

  // Cada persona acepta por sí misma: la de la dueña no cubre al profesional.
  assert.equal((await staffB.get(`${API}/auth/me`)).body.data.legal.mustAccept, true);
  const staffOk = await staffB.post(`${API}/auth/legal/accept`, { version: NEXT_VERSION });
  assert.equal(staffOk.status, 200);
  const [staffRow] = (await acceptancesOf(biz.businessId, staff.userId)).filter((r) => r.termsVersion === NEXT_VERSION);
  assert.equal(staffRow.role, "staff");
});

test("la aceptación es por negocio (RLS) y sin sesión no se puede aceptar", async () => {
  const a = await createTestBusiness(db, { name: "Negocio A" });
  const other = await createTestBusiness(db, { name: "Negocio B" });
  const owner = await createTestMember(db, { businessId: a.businessId, role: "owner" });
  const b = await loggedIn(owner.email, owner.password!);
  assert.equal((await b.post(`${API}/auth/legal/accept`, { version: LEGAL_VERSION })).status, 200);
  // Quedó en SU negocio, no en otro.
  assert.equal((await acceptancesOf(a.businessId, owner.userId)).length, 1);
  assert.equal((await acceptancesOf(other.businessId, owner.userId)).length, 0);

  const anon = await new Browser(app.baseUrl).post(`${API}/auth/legal/accept`, { version: LEGAL_VERSION });
  assert.equal(anon.status, 401);
});
