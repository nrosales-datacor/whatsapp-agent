import assert from "node:assert/strict";
import { after, before, test } from "node:test";

// ─────────────────────────────────────────────────────────────────────────────
// CRM de clientes (I3) por HTTP con la app real sobre PGlite como `app_runtime` (sin
// BYPASSRLS): el corte Básico vs Pro en cada ruta y parámetro del CRM, los permisos por rol
// de Configuración › Reglas y Campos personalizados y de importar/exportar, y "Mis clientes"
// del profesional (solo los clientes con citas suyas, en solo lectura).
// ─────────────────────────────────────────────────────────────────────────────

process.env.TRUST_PROXY = "loopback";
process.env.PANEL_SESSION_SECRET = "test-crm-clients-session-secret-0123456789";
process.env.TOKENS_ENCRYPTION_KEY = "d".repeat(64);
process.env.PANEL_LOGIN_RATE_LIMIT_MAX_IP = "500";

const { createAppHandler } = await import("../../src/app");
const { createEphemeralDb } = await import("../helpers/pgliteDb");
const { startTestServer } = await import("../helpers/panelClient");
const { createCrmTeam, insertAppointment, insertClient } = await import("../helpers/crmFixtures");

type TestServer = Awaited<ReturnType<typeof startTestServer>>;

const base = await createEphemeralDb();
const { db } = base;
let app: TestServer;

before(async () => {
  await base.client.exec("SET ROLE app_runtime");
  app = await startTestServer(createAppHandler({ db, role: "all" }));
});

after(async () => {
  await app?.close();
  await base.close();
});

const DAY = 86_400_000;
const CSV = "Nombre,Teléfono\nAna,8888 1111\n";

// ─── Gating: Básico vs Pro ──────────────────────────────────────────────────

test("Básico: todo lo del CRM responde 403 module_not_in_plan; la ficha básica sigue andando", async () => {
  const t = await createCrmTeam(db, app.baseUrl, { plan: "basic" });
  const clientId = await insertClient(db, t.businessId, { name: "Marta Básica", phone: "+50688880101" });

  const denied: [string, () => Promise<{ status: number; body: any }>][] = [
    ["lista por estado", () => t.owner.get("/api/panel/clients?status=vip")],
    ["lista por etiqueta", () => t.owner.get("/api/panel/clients?tag=VIP")],
    ["lista por última visita", () => t.owner.get("/api/panel/clients?lastVisitFrom=2026-01-01")],
    ["lista por profesional preferido", () => t.owner.get(`/api/panel/clients?preferredStaffId=${t.staffIds[0]}`)],
    ["lista por sucursal preferida", () => t.owner.get(`/api/panel/clients?preferredLocationId=${t.locationIds[0]}`)],
    ["lista solo VIP", () => t.owner.get("/api/panel/clients?vip=true")],
    ["orden por gasto", () => t.owner.get("/api/panel/clients?sort=total_spent")],
    ["orden por visitas", () => t.owner.get("/api/panel/clients?sort=visit_count")],
    ["conteo por estado", () => t.owner.get("/api/panel/clients/status-counts")],
    ["etiquetas", () => t.owner.get("/api/panel/clients/tags")],
    ["exportar", () => t.owner.get("/api/panel/clients/export.csv")],
    ["importar", () => t.owner.post("/api/panel/clients/import", { csv: CSV })],
    ["VIP manual", () => t.owner.patch(`/api/panel/clients/${clientId}`, { vip: true })],
    ["campos personalizados en la ficha", () => t.owner.patch(`/api/panel/clients/${clientId}`, { customData: {} })],
    ["alta con campos personalizados", () => t.owner.post("/api/panel/clients", { name: "Otra", customData: {} })],
    ["reglas (leer)", () => t.owner.get("/api/panel/settings/client-rules")],
    [
      "reglas (guardar)",
      () =>
        t.owner.put("/api/panel/settings/client-rules", {
          newDays: 30,
          vipMinVisits: 10,
          vipMinSpentCents: null,
          atRiskMode: "fixed",
          atRiskAfterDays: 60,
          atRiskFrequencyFactor: 2,
          inactiveAfterDays: 120,
        }),
    ],
    ["campos (listar)", () => t.owner.get("/api/panel/settings/custom-fields")],
    ["campos (crear)", () => t.owner.post("/api/panel/settings/custom-fields", { entity: "client", label: "Alergias", type: "text" })],
  ];
  for (const [what, call] of denied) {
    const res = await call();
    assert.equal(res.status, 403, `${what}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.code, "module_not_in_plan", what);
  }

  // Lo de la ficha básica: lista por nombre / última visita, búsqueda, ficha y edición.
  const list = await t.owner.get("/api/panel/clients?q=marta&sort=last_visit");
  assert.equal(list.status, 200);
  assert.deepEqual(
    list.body.data.items.map((c: { name: string; status: unknown; isVip: unknown }) => [c.name, c.status, c.isVip]),
    [["Marta Básica", null, null]],
    "sin estado calculado en el Básico",
  );
  const detail = await t.frontDesk.get(`/api/panel/clients/${clientId}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.body.data.status, null);
  assert.equal((await t.frontDesk.patch(`/api/panel/clients/${clientId}`, { notes: "Todo bien" })).status, 200);
});

test("Pro: el mismo negocio pasa a tener el CRM (estado en la lista y en la ficha)", async () => {
  const t = await createCrmTeam(db, app.baseUrl, { plan: "pro" });
  const id = await insertClient(db, t.businessId, { name: "Pía Pro", visitCount: 12, firstVisitAt: new Date(Date.now() - 300 * DAY), lastVisitAt: new Date(Date.now() - 5 * DAY) });
  const list = await t.owner.get("/api/panel/clients?status=vip&sort=visit_count");
  assert.equal(list.status, 200, JSON.stringify(list.body));
  assert.deepEqual(
    list.body.data.items.map((c: { id: string; status: string; isVip: boolean }) => [c.id, c.status, c.isVip]),
    [[id, "vip", true]],
  );
  const detail = await t.owner.get(`/api/panel/clients/${id}`);
  assert.equal(detail.body.data.status, "vip");
  assert.equal(detail.body.data.isVip, true);
  assert.equal((await t.owner.get("/api/panel/clients/status-counts")).status, 200);
});

// ─── Permisos por rol ───────────────────────────────────────────────────────

test("permisos: reglas y campos los edita dueño/admin; importar y exportar solo dueño/admin", async () => {
  const t = await createCrmTeam(db, app.baseUrl);
  for (const b of [t.frontDesk, t.staffMember]) {
    for (const res of [
      await b.get("/api/panel/settings/client-rules"),
      await b.post("/api/panel/settings/custom-fields", { entity: "client", label: "X", type: "text" }),
      await b.get("/api/panel/clients/export.csv"),
      await b.post("/api/panel/clients/import", { csv: CSV }),
    ]) {
      assert.equal(res.status, 403);
      assert.equal(res.body.code, "forbidden_role");
    }
  }
  // Todos los roles leen las definiciones activas (los formularios las necesitan)…
  for (const b of [t.owner, t.admin, t.frontDesk, t.staffMember]) assert.equal((await b.get("/api/panel/settings/custom-fields")).status, 200);
  // …y dueño/admin también las desactivadas.
  for (const b of [t.owner, t.admin]) {
    assert.equal((await b.get("/api/panel/settings/client-rules")).status, 200);
    const csv = await b.getText("/api/panel/clients/export.csv");
    assert.equal(csv.status, 200);
    assert.match(csv.headers.get("content-type") ?? "", /^text\/csv/);
    const preview = await b.post("/api/panel/clients/import", { csv: CSV });
    assert.equal(preview.status, 200, JSON.stringify(preview.body));
    assert.equal(preview.body.data.committed, false);
  }
});

// ─── "Mis clientes" del profesional ─────────────────────────────────────────

test("profesional: solo ve clientes con citas suyas (pasadas o futuras, no canceladas) y en solo lectura", async () => {
  const t = await createCrmTeam(db, app.baseUrl);
  const [ana, beto] = t.staffIds;
  const past = await insertClient(db, t.businessId, { name: "Carla con cita pasada", tags: ["Frecuente"] });
  const future = await insertClient(db, t.businessId, { name: "Diego con cita futura" });
  const cancelled = await insertClient(db, t.businessId, { name: "Elena con cita cancelada" });
  const other = await insertClient(db, t.businessId, { name: "Fabio de otro profesional", tags: ["Secreto"] });
  const nobody = await insertClient(db, t.businessId, { name: "Gloria sin citas" });
  await insertAppointment(db, t, { clientId: past, staffId: ana, startsAt: new Date(Date.now() - 20 * DAY) });
  await insertAppointment(db, t, { clientId: future, staffId: ana, startsAt: new Date(Date.now() + 3 * DAY), status: "confirmed" });
  await insertAppointment(db, t, { clientId: cancelled, staffId: ana, startsAt: new Date(Date.now() + 4 * DAY), status: "cancelled" });
  await insertAppointment(db, t, { clientId: other, staffId: beto, startsAt: new Date(Date.now() - 2 * DAY) });

  const names = async (b: typeof t.owner, query = "") =>
    ((await b.get(`/api/panel/clients${query}`)).body.data.items as { name: string }[]).map((c) => c.name).sort();
  assert.deepEqual(await names(t.staffMember), ["Carla con cita pasada", "Diego con cita futura"]);
  assert.deepEqual(await names(t.staffMember, "?q=fabio"), [], "ni buscándolo");
  assert.equal((await names(t.owner)).length, 5, "el dueño ve todos");

  assert.equal((await t.staffMember.get(`/api/panel/clients/${past}`)).status, 200);
  for (const id of [cancelled, other, nobody]) assert.equal((await t.staffMember.get(`/api/panel/clients/${id}`)).status, 404, id);

  // Conteos y etiquetas, con el mismo alcance.
  const counts = await t.staffMember.get("/api/panel/clients/status-counts");
  assert.equal(counts.body.data.total, 2);
  const tags = await t.staffMember.get("/api/panel/clients/tags");
  assert.deepEqual(tags.body.data, [{ tag: "Frecuente", count: 1 }]);

  // Solo lectura: no edita ni a los suyos.
  const patch = await t.staffMember.patch(`/api/panel/clients/${past}`, { notes: "No" });
  assert.equal(patch.status, 403);
  assert.equal(patch.body.code, "forbidden_role");
});

test("profesional sin ficha de profesional vinculada: no ve ningún cliente", async () => {
  const t = await createCrmTeam(db, app.baseUrl);
  const { createTestMember } = await import("../helpers/identityFixtures");
  const { Browser } = await import("../helpers/panelClient");
  await insertClient(db, t.businessId, { name: "Hilda" });
  const loose = await createTestMember(db, { businessId: t.businessId, role: "staff" });
  const b = new Browser(app.baseUrl);
  assert.equal((await b.post("/api/panel/auth/login", { email: loose.email, password: loose.password })).status, 200);
  const res = await b.get("/api/panel/clients");
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.data.items, []);
});
