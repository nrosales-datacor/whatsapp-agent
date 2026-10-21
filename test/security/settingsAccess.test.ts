import assert from "node:assert/strict";
import { after, before, test } from "node:test";

// ─────────────────────────────────────────────────────────────────────────────
// Permisos de Configuración (I1) por HTTP, con la app real sobre PGlite corriendo como el
// rol de la app (`app_runtime`, sin BYPASSRLS):
//   • dueño y administración editan; recepción y profesional solo leen (403 forbidden_role);
//   • los datos legales del negocio solo los ve quien edita;
//   • una sesión limitada a una sucursal no toca las otras ni crea sucursales;
//   • aislamiento entre negocios: ids de otro negocio son 404 o 400, nunca se tocan.
// ─────────────────────────────────────────────────────────────────────────────

process.env.TRUST_PROXY = "loopback";
process.env.PANEL_SESSION_SECRET = "test-settings-access-secret-0123456789";
process.env.TOKENS_ENCRYPTION_KEY = "c".repeat(64);
process.env.PANEL_LOGIN_RATE_LIMIT_MAX_IP = "500";

const { createAppHandler } = await import("../../src/app");
const { withTenant } = await import("../../src/platform/db/scope");
const { staff } = await import("../../src/modules/team/schema");
const { services } = await import("../../src/modules/catalog/schema");
const { createEphemeralDb } = await import("../helpers/pgliteDb");
const { Browser, startTestServer } = await import("../helpers/panelClient");
const { createTestBusiness, createTestMember } = await import("../helpers/identityFixtures");

type TestServer = Awaited<ReturnType<typeof startTestServer>>;
type Role = "owner" | "admin" | "front_desk" | "staff";

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

const API = "/api/panel";

async function loginAs(businessId: string, role: Role, locationIds?: string[]): Promise<InstanceType<typeof Browser>> {
  const member = await createTestMember(db, { businessId, role, locationIds });
  const b = new Browser(app.baseUrl);
  const res = await b.post(`${API}/auth/login`, { email: member.email, password: member.password });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return b;
}

async function seedStaffAndService(businessId: string): Promise<{ staffId: string; serviceId: string }> {
  return withTenant(db, businessId, async (tx) => {
    const [s] = await tx.insert(staff).values({ businessId, name: "Ana" }).returning({ id: staff.id });
    const [svc] = await tx.insert(services).values({ businessId, name: "Consulta", durationMin: 30 }).returning({ id: services.id });
    return { staffId: s.id, serviceId: svc.id };
  });
}

test("recepción y profesional leen toda la configuración pero no cambian nada (403 forbidden_role)", async () => {
  const biz = await createTestBusiness(db);
  const { staffId, serviceId } = await seedStaffAndService(biz.businessId);
  const [loc] = biz.locationIds;

  for (const role of ["front_desk", "staff"] as const) {
    const b = await loginAs(biz.businessId, role, [loc]);
    for (const path of ["/settings/business", "/settings/locations", "/settings/services", "/settings/staff", "/settings/time-off", `/settings/staff/${staffId}/services`]) {
      const res = await b.get(`${API}${path}`);
      assert.equal(res.status, 200, `${role} lee ${path}: ${JSON.stringify(res.body)}`);
    }
    const writes: [string, string, unknown][] = [
      ["PATCH", "/settings/business", { name: "Otro nombre" }],
      ["POST", "/settings/locations", { name: "Nueva" }],
      ["PATCH", `/settings/locations/${loc}`, { name: "X" }],
      ["PUT", `/settings/locations/${loc}/hours`, { hours: [] }],
      ["DELETE", `/settings/locations/${loc}`, undefined],
      ["POST", "/settings/service-categories", { name: "Cat" }],
      ["POST", "/settings/services", { name: "Nuevo", durationMin: 30 }],
      ["PATCH", `/settings/services/${serviceId}`, { priceCents: 100 }],
      ["DELETE", `/settings/services/${serviceId}`, undefined],
      ["PUT", "/settings/services/order", { categoryId: null, ids: [serviceId] }],
      ["POST", "/settings/staff", { name: "Beto" }],
      ["PATCH", `/settings/staff/${staffId}`, { name: "Ana María" }],
      ["PUT", `/settings/staff/${staffId}/hours`, { locationId: loc, hours: [] }],
      ["PUT", `/settings/staff/${staffId}/services`, { services: [] }],
      ["DELETE", `/settings/staff/${staffId}`, undefined],
      ["POST", "/settings/time-off", { startsAt: "2026-12-24T00:00:00-06:00", endsAt: "2026-12-26T00:00:00-06:00" }],
    ];
    for (const [method, path, body] of writes) {
      const res = await b.request(method, `${API}${path}`, body);
      assert.equal(res.status, 403, `${role} ${method} ${path} → ${res.status}`);
      assert.equal(res.body.code, "forbidden_role");
    }
  }
});

test("datos legales del negocio: los ve dueño/admin, no recepción", async () => {
  const biz = await createTestBusiness(db);
  const owner = await loginAs(biz.businessId, "owner");
  const patched = await owner.patch(`${API}/settings/business`, { legalName: "Clínica S.A.", taxId: "3-101-123456", billingEmail: "Facturas@Clinica.test" });
  assert.equal(patched.status, 200, JSON.stringify(patched.body));
  assert.deepEqual(patched.body.data.legal, { legalName: "Clínica S.A.", taxId: "3-101-123456", billingEmail: "facturas@clinica.test" });

  const admin = await loginAs(biz.businessId, "admin");
  assert.equal((await admin.get(`${API}/settings/business`)).body.data.legal.taxId, "3-101-123456");
  const desk = await loginAs(biz.businessId, "front_desk");
  const seen = (await desk.get(`${API}/settings/business`)).body.data;
  assert.equal(seen.legal, null);
  assert.equal(seen.name, biz.name);
});

test("admin limitado a una sucursal: solo edita la suya y no crea sucursales ni feriados del negocio", async () => {
  const biz = await createTestBusiness(db);
  const [central, norte] = biz.locationIds;
  const { staffId } = await seedStaffAndService(biz.businessId);
  const admin = await loginAs(biz.businessId, "admin", [central]);

  assert.equal((await admin.patch(`${API}/settings/locations/${central}`, { phone: "+50622220000" })).status, 200);
  const other = await admin.patch(`${API}/settings/locations/${norte}`, { phone: "+50622220000" });
  assert.equal(other.status, 403);
  assert.equal(other.body.code, "location_forbidden");
  assert.equal((await admin.request("PUT", `${API}/settings/locations/${norte}/hours`, { hours: [] })).status, 403);
  assert.equal((await admin.post(`${API}/settings/locations`, { name: "Sur" })).body.code, "location_forbidden");
  assert.equal((await admin.request("PUT", `${API}/settings/staff/${staffId}/hours`, { locationId: norte, hours: [] })).status, 403);
  assert.equal((await admin.request("PUT", `${API}/settings/staff/${staffId}/hours`, { locationId: central, hours: [] })).status, 200);
  const holiday = await admin.post(`${API}/settings/time-off`, { startsAt: "2026-12-24T00:00:00-06:00", endsAt: "2026-12-25T00:00:00-06:00" });
  assert.equal(holiday.body.code, "location_forbidden", "un feriado de todo el negocio pide acceso a todas");
  const local = await admin.post(`${API}/settings/time-off`, { locationId: central, startsAt: "2026-12-24T00:00:00-06:00", endsAt: "2026-12-25T00:00:00-06:00" });
  assert.equal(local.status, 201, JSON.stringify(local.body));

  // Solo ve su sucursal en la lista.
  const list = (await admin.get(`${API}/settings/locations`)).body.data;
  assert.deepEqual(
    list.map((l: { id: string }) => l.id),
    [central],
  );
});

test("aislamiento: ids de otro negocio no se pueden leer, editar ni referenciar", async () => {
  const mine = await createTestBusiness(db);
  const theirs = await createTestBusiness(db);
  const their = await seedStaffAndService(theirs.businessId);
  const theirMember = await createTestMember(db, { businessId: theirs.businessId, role: "staff" });
  const owner = await loginAs(mine.businessId, "owner");

  assert.equal((await owner.patch(`${API}/settings/locations/${theirs.locationIds[0]}`, { name: "Mía" })).status, 404);
  assert.equal((await owner.request("PUT", `${API}/settings/locations/${theirs.locationIds[0]}/hours`, { hours: [] })).status, 404);
  assert.equal((await owner.request("DELETE", `${API}/settings/locations/${theirs.locationIds[0]}`)).status, 404);
  assert.equal((await owner.patch(`${API}/settings/services/${their.serviceId}`, { priceCents: 1 })).status, 404);
  assert.equal((await owner.request("DELETE", `${API}/settings/services/${their.serviceId}`)).status, 404);
  assert.equal((await owner.patch(`${API}/settings/staff/${their.staffId}`, { name: "Mío" })).status, 404);
  assert.equal((await owner.get(`${API}/settings/staff/${their.staffId}/services`)).status, 404);

  // Referenciar sucursales, servicios o usuarios ajenos: 400 en el campo (una FK sola no alcanza: no pasa por RLS).
  const svc = await owner.post(`${API}/settings/services`, { name: "Limpieza", durationMin: 30, locationIds: [theirs.locationIds[0]] });
  assert.equal(svc.status, 400);
  assert.ok(svc.body.fields["body.locationIds"]);
  const linked = await owner.post(`${API}/settings/staff`, { name: "Infiltrada", membershipId: theirMember.membershipId });
  assert.equal(linked.status, 400);
  assert.ok(linked.body.fields["body.membershipId"]);
  const myStaff = await owner.post(`${API}/settings/staff`, { name: "Propia" });
  assert.equal(myStaff.status, 201);
  const borrowed = await owner.request("PUT", `${API}/settings/staff/${myStaff.body.data.id}/services`, { services: [{ serviceId: their.serviceId }] });
  assert.equal(borrowed.status, 400);
  const theirHours = await owner.request("PUT", `${API}/settings/staff/${myStaff.body.data.id}/hours`, { locationId: theirs.locationIds[0], hours: [] });
  assert.equal(theirHours.status, 400);
  assert.ok(theirHours.body.fields["body.locationId"]);
  const off = await owner.post(`${API}/settings/time-off`, { staffId: their.staffId, startsAt: "2026-12-24T00:00:00-06:00", endsAt: "2026-12-25T00:00:00-06:00" });
  assert.equal(off.status, 400);
  assert.ok(off.body.fields["body.staffId"]);

  // Las listas solo traen lo propio.
  const staffList = (await owner.get(`${API}/settings/staff`)).body.data;
  assert.deepEqual(
    staffList.map((s: { name: string }) => s.name),
    ["Propia"],
  );
  assert.deepEqual((await owner.get(`${API}/settings/services`)).body.data.services, []);
});

test("sin sesión: 401; con sesión, un cuerpo inválido es 400 con el error por campo", async () => {
  const anon = new Browser(app.baseUrl);
  assert.equal((await anon.get(`${API}/settings/business`)).status, 401);
  const biz = await createTestBusiness(db);
  const owner = await loginAs(biz.businessId, "owner");
  const bad = await owner.patch(`${API}/settings/business`, { timezone: "Marte/Olympus", currency: "colones", reminderChannels: ["sms"] });
  assert.equal(bad.status, 400);
  assert.ok(bad.body.fields["body.timezone"]);
  assert.ok(bad.body.fields["body.currency"]);
  assert.ok(bad.body.fields["body.reminderChannels.0"]);
  const empty = await owner.patch(`${API}/settings/business`, {});
  assert.equal(empty.status, 400);
});
