import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";

// ─────────────────────────────────────────────────────────────────────────────
// Inventario de acceso de la API del panel (Carril P, "auth en todos los endpoints"):
// congela QUIÉN puede llamar CADA ruta real que compone src/routes.ts. Agregar una ruta
// pública, cambiar `auth`, `roles`, `module`, `location` o `allowWhenPaused` de cualquier
// ruta, o sumar/quitar una ruta, hace fallar este test hasta que se actualiza la tabla de
// abajo: el cambio de acceso queda explícito en el diff del PR y lo revisa una persona.
//
// Además, por HTTP con la app real (createAppHandler sobre PGlite, como `app_runtime`):
//   • toda ruta `user` sin sesión → 401, y con la cookie del superadmin → 401;
//   • toda ruta `superadmin` sin sesión → 401, y con la cookie de un miembro del equipo → 401.
// Se itera el inventario: una ruta nueva entra sola en estos chequeos.
//
// Rutas `user` de escritura SIN `roles` (citas, clave, 2FA, cambio de negocio): el acceso
// fino lo hace el handler (`accessibleAppointment`/`ownStaffId` en scheduling: el rol
// `staff` solo toca sus citas; las de /auth/* son de la propia cuenta). Revisado a mano el
// 2026-10-30 al armar la tabla; `POST /auth/legal/accept` (2026-10-31) también es de la
// propia cuenta: registra la aceptación de quien llama en su negocio actual.
// ─────────────────────────────────────────────────────────────────────────────

process.env.TRUST_PROXY = "loopback";
process.env.PANEL_SESSION_SECRET = "test-route-inventory-session-secret-0123";
process.env.TOKENS_ENCRYPTION_KEY = "e".repeat(64);
process.env.PANEL_LOGIN_RATE_LIMIT_MAX_IP = "200";
process.env.PANEL_SUPERADMIN_USERNAME = "root";
delete process.env.PANEL_SUPERADMIN_TOTP_SECRET;

const ADMIN_PASSWORD = "clave-del-superadmin-inventario-1";
const { hashPassword } = await import("../../src/platform/auth/password");
process.env.PANEL_SUPERADMIN_HASH = await hashPassword(ADMIN_PASSWORD);

const { createAppHandler } = await import("../../src/app");
const { createPlans } = await import("../../src/plans");
const { panelRoutes } = await import("../../src/routes");
const { createEphemeralDb } = await import("../helpers/pgliteDb");
const { Browser, startTestServer } = await import("../helpers/panelClient");
const { createTestBusiness, createTestMember } = await import("../helpers/identityFixtures");

type TestServer = Awaited<ReturnType<typeof startTestServer>>;
type Route = ReturnType<typeof panelRoutes>[number];

/** Lo que define el acceso de una ruta (sin el handler ni los esquemas). */
interface Access {
  auth: "user" | "superadmin" | "public";
  roles?: readonly string[];
  module?: string;
  location?: "required" | "optional";
  allowWhenPaused?: true;
}

// ── Allowlist de rutas públicas (sin sesión) ────────────────────────────────
// Sumar una acá es una decisión de seguridad: justificala en el PR.
const PUBLIC_ROUTES: readonly string[] = [
  "GET /auth/invitations/:token", // ver una invitación por su token (lado de quien la recibe)
  "GET /auth/signup/config", // config pública del alta self-service
  "GET /ping",
  "POST /admin/login",
  "POST /admin/logout",
  "POST /auth/invitations/accept",
  "POST /auth/login",
  "POST /auth/logout", // si trae sesión válida, la revoca en todos los dispositivos
  "POST /auth/password/forgot",
  "POST /auth/password/reset",
  "POST /auth/signup",
  "POST /auth/verify-email",
  "POST /auth/verify-email/resend",
];

// ── Snapshot de acceso de TODAS las rutas (orden alfabético por "MÉTODO ruta") ──
// Generado desde panelRoutes() y revisado a mano. Si cambiás el acceso de una ruta,
// cambiá su fila acá en el mismo PR.
const ACCESS_SNAPSHOT: Record<string, Access> = {
  "DELETE /campaigns/:id": { auth: "user", roles: ["owner", "admin"], module: "campaigns" },
  "DELETE /commissions/payouts/:id": { auth: "user", roles: ["owner", "admin"], module: "commissions" },
  "DELETE /settings/commission-rules/:id": { auth: "user", roles: ["owner", "admin"], module: "commissions" },
  "DELETE /settings/custom-fields/:id": { auth: "user", roles: ["owner", "admin"] },
  "DELETE /settings/locations/:id": { auth: "user", roles: ["owner", "admin"] },
  "DELETE /settings/payment-methods/:id": { auth: "user", roles: ["owner", "admin"], module: "sales" },
  "DELETE /settings/service-categories/:id": { auth: "user", roles: ["owner", "admin"] },
  "DELETE /settings/services/:id": { auth: "user", roles: ["owner", "admin"] },
  "DELETE /settings/staff/:id": { auth: "user", roles: ["owner", "admin"] },
  "DELETE /settings/time-off/:id": { auth: "user", roles: ["owner", "admin"] },
  "GET /admin/businesses": { auth: "superadmin" },
  "GET /admin/businesses/:id": { auth: "superadmin" },
  "GET /admin/businesses/:id/usage": { auth: "superadmin" },
  "GET /admin/me": { auth: "superadmin" },
  "GET /admin/metrics": { auth: "superadmin" },
  "GET /appointments": { auth: "user", location: "optional" },
  "GET /appointments/:id": { auth: "user" },
  "GET /appointments/:id/balance": { auth: "user", module: "sales" },
  "GET /auth/invitations/:token": { auth: "public" },
  "GET /auth/me": { auth: "user" },
  "GET /auth/signup/config": { auth: "public" },
  "GET /availability": { auth: "user" },
  "GET /billing/status": { auth: "user", roles: ["owner"], allowWhenPaused: true },
  "GET /campaigns": { auth: "user", roles: ["owner", "admin"], module: "campaigns" },
  "GET /campaigns/:id": { auth: "user", roles: ["owner", "admin"], module: "campaigns" },
  "GET /campaigns/overview": { auth: "user", roles: ["owner", "admin"], module: "campaigns" },
  "GET /clients": { auth: "user" },
  "GET /clients/:id": { auth: "user" },
  "GET /clients/:id/appointments": { auth: "user" },
  "GET /clients/export.csv": { auth: "user", roles: ["owner", "admin"] },
  "GET /clients/form-options": { auth: "user" },
  "GET /clients/status-counts": { auth: "user" },
  "GET /clients/tags": { auth: "user" },
  "GET /commissions/entries": { auth: "user", roles: ["owner", "admin", "staff"], module: "commissions" },
  "GET /commissions/payouts": { auth: "user", roles: ["owner", "admin", "staff"], module: "commissions" },
  "GET /commissions/summary": { auth: "user", roles: ["owner", "admin", "staff"], module: "commissions" },
  "GET /home/overview": { auth: "user", roles: ["owner", "admin", "front_desk"], module: "reports", location: "optional" },
  "GET /home/today": { auth: "user", roles: ["owner", "admin", "front_desk"], location: "optional" },
  "GET /onboarding": { auth: "user", roles: ["owner", "admin"] },
  "GET /ping": { auth: "public" },
  "GET /push/public-key": { auth: "user", roles: ["owner", "admin", "front_desk"], module: "whatsapp" },
  "GET /reports/channels": { auth: "user", roles: ["owner", "admin"], module: "reports", location: "optional" },
  "GET /reports/channels.csv": { auth: "user", roles: ["owner", "admin"], module: "reports", location: "optional" },
  "GET /reports/clients": { auth: "user", roles: ["owner", "admin"], module: "reports", location: "optional" },
  "GET /reports/clients.csv": { auth: "user", roles: ["owner", "admin"], module: "reports", location: "optional" },
  "GET /reports/sales": { auth: "user", roles: ["owner", "admin"], module: "reports", location: "optional" },
  "GET /reports/sales.csv": { auth: "user", roles: ["owner", "admin"], module: "reports", location: "optional" },
  "GET /reports/services": { auth: "user", roles: ["owner", "admin"], module: "reports", location: "optional" },
  "GET /reports/services.csv": { auth: "user", roles: ["owner", "admin"], module: "reports", location: "optional" },
  "GET /reports/staff": { auth: "user", roles: ["owner", "admin"], module: "reports", location: "optional" },
  "GET /reports/staff.csv": { auth: "user", roles: ["owner", "admin"], module: "reports", location: "optional" },
  "GET /sales/payments": { auth: "user", roles: ["owner", "admin", "front_desk"], module: "sales", location: "optional" },
  "GET /sales/pending": { auth: "user", roles: ["owner", "admin", "front_desk"], module: "sales", location: "optional" },
  "GET /sales/summary": { auth: "user", roles: ["owner", "admin", "front_desk"], module: "sales", location: "optional" },
  "GET /settings/business": { auth: "user" },
  "GET /settings/client-rules": { auth: "user", roles: ["owner", "admin"] },
  "GET /settings/commission-rules": { auth: "user", roles: ["owner", "admin"], module: "commissions" },
  "GET /settings/custom-fields": { auth: "user" },
  "GET /settings/locations": { auth: "user" },
  "GET /settings/payment-methods": { auth: "user", module: "sales" },
  "GET /settings/services": { auth: "user" },
  "GET /settings/staff": { auth: "user" },
  "GET /settings/staff/:id/services": { auth: "user" },
  "GET /settings/time-off": { auth: "user" },
  "GET /team/members": { auth: "user", roles: ["owner", "admin"] },
  "GET /whatsapp/channels": { auth: "user", roles: ["owner", "admin"], module: "whatsapp" },
  "GET /whatsapp/channels/signup-config": { auth: "user", roles: ["owner", "admin"], module: "whatsapp" },
  "GET /whatsapp/conversations": { auth: "user", roles: ["owner", "admin", "front_desk"], module: "whatsapp", location: "optional" },
  "GET /whatsapp/conversations/:id": { auth: "user", roles: ["owner", "admin", "front_desk"], module: "whatsapp", location: "optional" },
  "GET /whatsapp/growth": { auth: "user", module: "whatsapp" },
  "GET /whatsapp/metrics": { auth: "user", roles: ["owner", "admin", "front_desk"], module: "whatsapp", location: "optional" },
  "GET /whatsapp/settings": { auth: "user", module: "whatsapp" },
  "GET /whatsapp/summary": { auth: "user", roles: ["owner", "admin", "front_desk"], module: "whatsapp", location: "optional" },
  "PATCH /admin/businesses/:id/plan": { auth: "superadmin" },
  "PATCH /appointments/:id": { auth: "user" },
  "PATCH /campaigns/:id": { auth: "user", roles: ["owner", "admin"], module: "campaigns" },
  "PATCH /clients/:id": { auth: "user", roles: ["owner", "admin", "front_desk"] },
  "PATCH /settings/business": { auth: "user", roles: ["owner", "admin"] },
  "PATCH /settings/commission-rules/:id": { auth: "user", roles: ["owner", "admin"], module: "commissions" },
  "PATCH /settings/custom-fields/:id": { auth: "user", roles: ["owner", "admin"] },
  "PATCH /settings/locations/:id": { auth: "user", roles: ["owner", "admin"] },
  "PATCH /settings/payment-methods/:id": { auth: "user", roles: ["owner", "admin"], module: "sales" },
  "PATCH /settings/service-categories/:id": { auth: "user", roles: ["owner", "admin"] },
  "PATCH /settings/services/:id": { auth: "user", roles: ["owner", "admin"] },
  "PATCH /settings/staff/:id": { auth: "user", roles: ["owner", "admin"] },
  "PATCH /settings/time-off/:id": { auth: "user", roles: ["owner", "admin"] },
  "PATCH /team/members/:membershipId": { auth: "user", roles: ["owner", "admin"] },
  "PATCH /whatsapp/channels/:id": { auth: "user", roles: ["owner", "admin"], module: "whatsapp" },
  "PATCH /whatsapp/growth": { auth: "user", roles: ["owner", "admin"], module: "whatsapp" },
  "PATCH /whatsapp/settings": { auth: "user", roles: ["owner", "admin"], module: "whatsapp" },
  "POST /admin/businesses": { auth: "superadmin" },
  "POST /admin/businesses/:id/pause": { auth: "superadmin" },
  "POST /admin/businesses/:id/reactivate": { auth: "superadmin" },
  "POST /admin/businesses/:id/whatsapp": { auth: "superadmin" },
  "POST /admin/login": { auth: "public" },
  "POST /admin/logout": { auth: "public" },
  "POST /appointments": { auth: "user" },
  "POST /appointments/:id/assign": { auth: "user", roles: ["owner", "admin", "front_desk"] },
  "POST /appointments/:id/cancel": { auth: "user" },
  "POST /appointments/:id/complete": { auth: "user" },
  "POST /appointments/:id/confirm": { auth: "user" },
  "POST /appointments/:id/no-show": { auth: "user" },
  "POST /appointments/:id/payments": { auth: "user", roles: ["owner", "admin", "front_desk"], module: "sales" },
  "POST /appointments/:id/reschedule": { auth: "user" },
  "POST /auth/invitations/accept": { auth: "public" },
  // Términos y aviso de privacidad vigentes: cada persona acepta por sí misma, cualquier rol
  // (Carril P, privacidad-y-terminos, 2026-10-31).
  "POST /auth/legal/accept": { auth: "user" },
  "POST /auth/login": { auth: "public" },
  "POST /auth/logout": { auth: "public" },
  "POST /auth/password/change": { auth: "user" },
  "POST /auth/password/forgot": { auth: "public" },
  "POST /auth/password/reset": { auth: "public" },
  "POST /auth/signup": { auth: "public" },
  "POST /auth/switch-business": { auth: "user" },
  "POST /auth/totp/disable": { auth: "user" },
  "POST /auth/totp/enable": { auth: "user" },
  "POST /auth/totp/setup": { auth: "user" },
  "POST /auth/verify-email": { auth: "public" },
  "POST /auth/verify-email/resend": { auth: "public" },
  "POST /billing/checkout": { auth: "user", roles: ["owner"], allowWhenPaused: true },
  "POST /billing/portal": { auth: "user", roles: ["owner"], allowWhenPaused: true },
  "POST /campaigns": { auth: "user", roles: ["owner", "admin"], module: "campaigns" },
  "POST /campaigns/:id/cancel": { auth: "user", roles: ["owner", "admin"], module: "campaigns" },
  "POST /campaigns/:id/launch": { auth: "user", roles: ["owner", "admin"], module: "campaigns" },
  "POST /campaigns/preview": { auth: "user", roles: ["owner", "admin"], module: "campaigns" },
  "POST /clients": { auth: "user", roles: ["owner", "admin", "front_desk"] },
  "POST /clients/:id/anonymize": { auth: "user", roles: ["owner"] },
  "POST /clients/import": { auth: "user", roles: ["owner", "admin"] },
  "POST /commissions/payouts": { auth: "user", roles: ["owner", "admin"], module: "commissions" },
  "POST /commissions/payouts/:id/paid": { auth: "user", roles: ["owner", "admin"], module: "commissions" },
  "POST /onboarding/dismiss": { auth: "user", roles: ["owner", "admin"] },
  "POST /push/subscribe": { auth: "user", roles: ["owner", "admin", "front_desk"], module: "whatsapp" },
  "POST /push/test": { auth: "user", roles: ["owner", "admin", "front_desk"], module: "whatsapp" },
  "POST /push/unsubscribe": { auth: "user", roles: ["owner", "admin", "front_desk"], module: "whatsapp" },
  "POST /sales/payments": { auth: "user", roles: ["owner", "admin", "front_desk"], module: "sales" },
  "POST /sales/payments/:id/refund": { auth: "user", roles: ["owner", "admin"], module: "sales" },
  "POST /settings/commission-rules": { auth: "user", roles: ["owner", "admin"], module: "commissions" },
  "POST /settings/custom-fields": { auth: "user", roles: ["owner", "admin"] },
  "POST /settings/locations": { auth: "user", roles: ["owner", "admin"] },
  "POST /settings/payment-methods": { auth: "user", roles: ["owner", "admin"], module: "sales" },
  "POST /settings/service-categories": { auth: "user", roles: ["owner", "admin"] },
  "POST /settings/services": { auth: "user", roles: ["owner", "admin"] },
  "POST /settings/staff": { auth: "user", roles: ["owner", "admin"] },
  "POST /settings/time-off": { auth: "user", roles: ["owner", "admin"] },
  "POST /team/invitations": { auth: "user", roles: ["owner", "admin"] },
  "POST /whatsapp/channels/:id/test": { auth: "user", roles: ["owner", "admin"], module: "whatsapp" },
  "POST /whatsapp/channels/connect": { auth: "user", roles: ["owner", "admin"], module: "whatsapp" },
  "POST /whatsapp/conversations/:id/messages": { auth: "user", roles: ["owner", "admin", "front_desk"], module: "whatsapp", location: "optional" },
  "POST /whatsapp/conversations/:id/mode": { auth: "user", roles: ["owner", "admin", "front_desk"], module: "whatsapp", location: "optional" },
  "POST /whatsapp/conversations/:id/read": { auth: "user", roles: ["owner", "admin", "front_desk"], module: "whatsapp", location: "optional" },
  "POST /whatsapp/conversations/:id/reopen": { auth: "user", roles: ["owner", "admin", "front_desk"], module: "whatsapp", location: "optional" },
  "POST /whatsapp/conversations/:id/status": { auth: "user", roles: ["owner", "admin", "front_desk"], module: "whatsapp", location: "optional" },
  "PUT /clients/:id/marketing-consent": { auth: "user", roles: ["owner", "admin", "front_desk"], module: "campaigns" },
  "PUT /settings/client-rules": { auth: "user", roles: ["owner", "admin"] },
  "PUT /settings/custom-fields/order": { auth: "user", roles: ["owner", "admin"] },
  "PUT /settings/locations/:id/hours": { auth: "user", roles: ["owner", "admin"] },
  "PUT /settings/payment-methods/order": { auth: "user", roles: ["owner", "admin"], module: "sales" },
  "PUT /settings/service-categories/order": { auth: "user", roles: ["owner", "admin"] },
  "PUT /settings/services/order": { auth: "user", roles: ["owner", "admin"] },
  "PUT /settings/staff/:id/hours": { auth: "user", roles: ["owner", "admin"] },
  "PUT /settings/staff/:id/services": { auth: "user", roles: ["owner", "admin"] },
  "PUT /settings/staff/order": { auth: "user", roles: ["owner", "admin"] },
};

// ── Ayudas ──────────────────────────────────────────────────────────────────

function accessOf(r: Route): Access {
  const a: Access = { auth: r.auth };
  if (r.roles) a.roles = [...r.roles];
  if (r.module) a.module = r.module;
  if (r.location) a.location = r.location;
  if (r.allowWhenPaused) a.allowWhenPaused = true;
  return a;
}

const keyOf = (r: Route) => `${r.method} ${r.path}`;
const byKey = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Ruta concreta: cada `:param` → un uuid al azar (no existe; da igual: el 401 va antes). */
const concretePath = (path: string) => `/api/panel${path.replace(/:[A-Za-z_][A-Za-z0-9_]*/g, () => randomUUID())}`;

const base = await createEphemeralDb();
const { db } = base;
// La misma composición que usa la app (src/app.ts → panelRoutes).
const routes = panelRoutes({ db, plans: createPlans(db) });
let app: TestServer;

before(async () => {
  await base.client.exec("SET ROLE app_runtime");
  app = await startTestServer(createAppHandler({ db, role: "all" }));
});

after(async () => {
  await app?.close();
  await base.close();
});

// ── Inventario ──────────────────────────────────────────────────────────────

test("inventario: la tabla de este test está ordenada y sin repetidos", () => {
  const keys = Object.keys(ACCESS_SNAPSHOT);
  assert.deepEqual(keys, [...keys].sort(byKey), "ordená ACCESS_SNAPSHOT alfabéticamente");
  assert.deepEqual(PUBLIC_ROUTES, [...PUBLIC_ROUTES].sort(byKey), "ordená PUBLIC_ROUTES alfabéticamente");
  assert.equal(new Set(routes.map(keyOf)).size, routes.length, "dos rutas con el mismo método y ruta");
});

test("inventario: las rutas públicas son exactamente las de la allowlist", () => {
  const actual = routes.filter((r) => r.auth === "public").map(keyOf).sort(byKey);
  assert.deepEqual(actual, PUBLIC_ROUTES);
});

test("inventario: auth, roles, módulo, sucursal y pausa de TODAS las rutas coinciden con el snapshot", () => {
  const actual: Record<string, Access> = {};
  for (const r of [...routes].sort((a, b) => byKey(keyOf(a), keyOf(b)))) actual[keyOf(r)] = accessOf(r);
  assert.deepStrictEqual(actual, ACCESS_SNAPSHOT);
});

test("inventario: las rutas del superadmin viven bajo /admin/ y ninguna ruta del equipo", () => {
  for (const r of routes) {
    if (r.auth === "superadmin") assert.ok(r.path.startsWith("/admin/"), `${keyOf(r)}: superadmin fuera de /admin/`);
    if (r.auth === "user") assert.ok(!r.path.startsWith("/admin/"), `${keyOf(r)}: ruta del equipo bajo /admin/`);
  }
});

// ── Humo por HTTP: sin la sesión correcta, 401 ─────────────────────────────

async function teamBrowser() {
  const biz = await createTestBusiness(db);
  const owner = await createTestMember(db, { businessId: biz.businessId, role: "owner" });
  const b = new Browser(app.baseUrl);
  const res = await b.post("/api/panel/auth/login", { email: owner.email, password: owner.password });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal((await b.get("/api/panel/auth/me")).status, 200, "la cookie del equipo es válida");
  return b;
}

async function adminBrowser() {
  const b = new Browser(app.baseUrl);
  const res = await b.post("/api/panel/admin/login", { username: "root", password: ADMIN_PASSWORD });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal((await b.get("/api/panel/admin/me")).status, 200, "la cookie del superadmin es válida");
  return b;
}

async function expect401(b: InstanceType<typeof Browser>, r: Route, who: string) {
  const res = await b.request(r.method, concretePath(r.path));
  assert.equal(res.status, 401, `${keyOf(r)} ${who} → ${res.status} ${JSON.stringify(res.body)}`);
  assert.equal(res.body?.code, "unauthorized", `${keyOf(r)} ${who}`);
}

test("humo: toda ruta del equipo y del superadmin responde 401 sin sesión", async () => {
  const anonymous = new Browser(app.baseUrl);
  const guarded = routes.filter((r) => r.auth !== "public");
  assert.ok(guarded.length > 100, "se iteran las rutas reales");
  for (const r of guarded) await expect401(anonymous, r, "sin sesión");
});

test("humo: toda ruta del superadmin responde 401 con la cookie de un miembro del equipo", async () => {
  const team = await teamBrowser();
  const adminOnly = routes.filter((r) => r.auth === "superadmin");
  assert.ok(adminOnly.length > 0);
  for (const r of adminOnly) await expect401(team, r, "con sesión del equipo");
});

test("humo: toda ruta del equipo responde 401 con la cookie del superadmin", async () => {
  const admin = await adminBrowser();
  for (const r of routes.filter((x) => x.auth === "user")) await expect401(admin, r, "con sesión del superadmin");
});
