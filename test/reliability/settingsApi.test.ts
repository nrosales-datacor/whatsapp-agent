import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { and, eq } from "drizzle-orm";

// ─────────────────────────────────────────────────────────────────────────────
// Configuración (I1) de punta a punta por HTTP, con la app real sobre PGlite como el rol
// de la app: negocio, sucursales y horario, catálogo (orden incluido), profesionales,
// servicios por profesional y ausencias. Verifica también lo que no se ve en la
// respuesta: el snapshot en config_history, la invalidación del caché del negocio y que
// "eliminar" desactive lo que tiene historial.
// ─────────────────────────────────────────────────────────────────────────────

process.env.TRUST_PROXY = "loopback";
process.env.PANEL_SESSION_SECRET = "test-settings-api-secret-0123456789ab";
process.env.TOKENS_ENCRYPTION_KEY = "d".repeat(64);
process.env.PANEL_LOGIN_RATE_LIMIT_MAX_IP = "500";

const { createAppHandler } = await import("../../src/app");
const { withTenant } = await import("../../src/platform/db/scope");
const { listConfigHistory } = await import("../../src/platform/audit/configHistory");
const { getBusinessContext } = await import("../../src/modules/business");
const { clients } = await import("../../src/modules/clients/schema");
const { appointments } = await import("../../src/modules/scheduling/schema");
const { staff } = await import("../../src/modules/team/schema");
const { createEphemeralDb } = await import("../helpers/pgliteDb");
const { Browser, startTestServer } = await import("../helpers/panelClient");
const { createTestBusiness, createTestMember } = await import("../helpers/identityFixtures");

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

const API = "/api/panel";

async function ownerOf(businessId: string): Promise<{ b: InstanceType<typeof Browser>; userId: string }> {
  const member = await createTestMember(db, { businessId, role: "owner" });
  const b = new Browser(app.baseUrl);
  const res = await b.post(`${API}/auth/login`, { email: member.email, password: member.password });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return { b, userId: member.userId };
}

/** Una cita (historial) de un profesional en una sucursal. */
async function insertAppointment(businessId: string, locationId: string, staffId: string): Promise<void> {
  await withTenant(db, businessId, async (tx) => {
    const [client] = await tx
      .insert(clients)
      .values({ businessId, name: "Cliente", phone: `+5068${Math.floor(Math.random() * 1e7).toString().padStart(7, "0")}` })
      .returning({ id: clients.id });
    await tx.insert(appointments).values({
      businessId,
      locationId,
      clientId: client.id,
      staffId,
      startsAt: new Date("2026-10-01T15:00:00Z"),
      endsAt: new Date("2026-10-01T16:00:00Z"),
      status: "completed",
    });
  });
}

// ─── Negocio ────────────────────────────────────────────────────────────────

test("negocio: PATCH guarda terminología, canales y marca; `me` lo ve al toque y queda en config_history", async () => {
  const biz = await createTestBusiness(db);
  const { b, userId } = await ownerOf(biz.businessId);
  // Calienta el caché del contexto: el cambio tiene que invalidarlo.
  assert.equal((await b.get(`${API}/auth/me`)).body.data.business.name, biz.name);

  const res = await b.patch(`${API}/settings/business`, {
    name: "Clínica Sonrisa",
    terminology: { client: "Paciente", clients: "pacientes", appointment: "" },
    reminderChannels: ["email", "whatsapp"],
    branding: { accentColor: "#0B7D72", logoUrl: "https://cdn.example.com/logo.png", headerColor: null },
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const settings = res.body.data;
  assert.equal(settings.name, "Clínica Sonrisa");
  assert.equal(settings.terminology.client, "paciente", "se guarda en minúscula");
  assert.equal(settings.terminology.appointment, "cita", "vacío = vuelve al default");
  assert.deepEqual(settings.reminderChannels, ["email", "whatsapp"]);
  assert.deepEqual(settings.branding, { accentColor: "#0B7D72", logoUrl: "https://cdn.example.com/logo.png" });
  assert.equal(settings.brandingEditable, true);

  const me = (await b.get(`${API}/auth/me`)).body.data;
  assert.equal(me.business.name, "Clínica Sonrisa", "el caché del negocio se invalidó");
  assert.equal(me.business.terminology.clients, "pacientes");
  const ctx = await getBusinessContext(db, biz.businessId);
  assert.deepEqual(ctx?.reminderChannels, ["email", "whatsapp"]);

  const history = await listConfigHistory(db, biz.businessId, { entity: "business" });
  assert.equal(history.length, 1);
  assert.equal(history[0].changedBy, userId);
  assert.equal((history[0].snapshot as { name: string }).name, "Clínica Sonrisa");
  assert.deepEqual((history[0].snapshot as { terminology: object }).terminology, { client: "paciente", clients: "pacientes" });

  // Un override igual al default se borra; el logo tiene que ser https.
  const reset = await b.patch(`${API}/settings/business`, { terminology: { client: "cliente" }, branding: { logoUrl: null } });
  assert.equal(reset.body.data.terminology.client, "cliente");
  assert.deepEqual(reset.body.data.branding, { accentColor: "#0B7D72" });
  const insecure = await b.patch(`${API}/settings/business`, { branding: { logoUrl: "http://example.com/logo.png" } });
  assert.equal(insecure.status, 400);
  assert.ok(insecure.body.fields["body.branding.logoUrl"]);
  assert.equal((await listConfigHistory(db, biz.businessId, { entity: "business" })).length, 2, "el PATCH inválido no deja rastro");
});

// ─── Sucursales ─────────────────────────────────────────────────────────────

test("sucursales: alta con horario default, horario con descanso y validación de cruces", async () => {
  const biz = await createTestBusiness(db, { locations: ["Central"] });
  const { b } = await ownerOf(biz.businessId);

  const created = await b.post(`${API}/settings/locations`, { name: "  Escazú ", address: "Plaza 4", phone: "" });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const loc = created.body.data;
  assert.equal(loc.name, "Escazú");
  assert.equal(loc.phone, null);
  assert.equal(loc.timezone, "America/Costa_Rica", "hereda la zona del negocio");
  assert.equal(loc.position, 1);
  assert.equal(loc.hours.length, 6, "lunes a sábado");
  assert.deepEqual(loc.hours[0], { weekday: 1, start: "08:00", end: "18:00" });

  const hours = [
    { weekday: 2, start: "14:00", end: "19:00" },
    { weekday: 2, start: "09:00", end: "13:00" },
    { weekday: 6, start: "09:00", end: "24:00" },
  ];
  const put = await b.request("PUT", `${API}/settings/locations/${loc.id}/hours`, { hours });
  assert.equal(put.status, 200, JSON.stringify(put.body));
  assert.deepEqual(put.body.data.hours, [
    { weekday: 2, start: "09:00", end: "13:00" },
    { weekday: 2, start: "14:00", end: "19:00" },
    { weekday: 6, start: "09:00", end: "24:00" },
  ]);
  // El caché del contexto ya trae el horario nuevo.
  const ctx = await getBusinessContext(db, biz.businessId);
  assert.equal(ctx?.locations.find((l) => l.id === loc.id)?.hours.length, 3);

  const clash = await b.request("PUT", `${API}/settings/locations/${loc.id}/hours`, {
    hours: [
      { weekday: 1, start: "09:00", end: "13:00" },
      { weekday: 1, start: "12:00", end: "18:00" },
    ],
  });
  assert.equal(clash.status, 400);
  assert.match(clash.body.fields["body.hours.1.start"], /se cruza/);
  const reversed = await b.request("PUT", `${API}/settings/locations/${loc.id}/hours`, { hours: [{ weekday: 1, start: "18:00", end: "09:00" }] });
  assert.ok(reversed.body.fields["body.hours.0.end"]);

  const history = await listConfigHistory(db, biz.businessId, { entity: "location", entityId: loc.id });
  assert.equal(history.length, 2, "alta + cambio de horario (los inválidos no cuentan)");
  assert.equal((history[0].snapshot as { hours: unknown[] }).hours.length, 3);
});

test("sucursales: siempre queda una activa; eliminar borra sin historial y desactiva con historial", async () => {
  const biz = await createTestBusiness(db, { locations: ["Central"] });
  const [central] = biz.locationIds;
  const { b } = await ownerOf(biz.businessId);

  const last = await b.patch(`${API}/settings/locations/${central}`, { active: false });
  assert.equal(last.status, 409);
  assert.equal(last.body.code, "last_location");
  assert.equal((await b.request("DELETE", `${API}/settings/locations/${central}`)).body.code, "last_location");

  // Sin historial: se borra.
  const temp = (await b.post(`${API}/settings/locations`, { name: "Temporal" })).body.data;
  const del = await b.request("DELETE", `${API}/settings/locations/${temp.id}`);
  assert.equal(del.status, 200);
  assert.deepEqual(del.body.data, { deleted: true });
  assert.equal((await b.get(`${API}/settings/locations`)).body.data.length, 1);

  // Con una cita: se desactiva.
  const withHistory = (await b.post(`${API}/settings/locations`, { name: "Con citas" })).body.data;
  const [s] = await withTenant(db, biz.businessId, (tx) => tx.insert(staff).values({ businessId: biz.businessId, name: "Ana" }).returning({ id: staff.id }));
  await insertAppointment(biz.businessId, withHistory.id, s.id);
  const soft = await b.request("DELETE", `${API}/settings/locations/${withHistory.id}`);
  assert.equal(soft.status, 200, JSON.stringify(soft.body));
  assert.equal(soft.body.data.deleted, false);
  assert.equal(soft.body.data.location.active, false);
  assert.equal(soft.body.data.location.hours.length, 6, "el horario sigue ahí (rollback del savepoint)");

  // Con un miembro limitado a ella: se desactiva (borrarla lo dejaría con "todas").
  const restricted = (await b.post(`${API}/settings/locations`, { name: "De Lucía" })).body.data;
  await createTestMember(db, { businessId: biz.businessId, role: "front_desk", locationIds: [restricted.id] });
  assert.equal((await b.request("DELETE", `${API}/settings/locations/${restricted.id}`)).body.data.deleted, false);

  // Con un servicio que se ofrece solo ahí: se desactiva.
  const onlyHere = (await b.post(`${API}/settings/locations`, { name: "Spa" })).body.data;
  assert.equal((await b.post(`${API}/settings/services`, { name: "Sauna", durationMin: 30, locationIds: [onlyHere.id] })).status, 201);
  assert.equal((await b.request("DELETE", `${API}/settings/locations/${onlyHere.id}`)).body.data.deleted, false);

  // Reactivar.
  const back = await b.patch(`${API}/settings/locations/${withHistory.id}`, { active: true, timezone: "America/Panama" });
  assert.equal(back.body.data.active, true);
  assert.equal(back.body.data.timezone, "America/Panama");
  assert.equal((await b.patch(`${API}/settings/locations/${withHistory.id}`, { timezone: "Marte/Olympus" })).status, 400);
});

// ─── Catálogo ───────────────────────────────────────────────────────────────

test("catálogo: categorías y servicios con orden (subir/bajar), cambio de categoría y borrado de categoría", async () => {
  const biz = await createTestBusiness(db);
  const { b } = await ownerOf(biz.businessId);
  const faciales = (await b.post(`${API}/settings/service-categories`, { name: "Faciales" })).body.data;
  const corporales = (await b.post(`${API}/settings/service-categories`, { name: "Corporales" })).body.data;
  assert.deepEqual([faciales.position, corporales.position], [0, 1]);

  const svc = async (body: Record<string, unknown>) => {
    const res = await b.post(`${API}/settings/services`, body);
    assert.equal(res.status, 201, JSON.stringify(res.body));
    return res.body.data;
  };
  const limpieza = await svc({ categoryId: faciales.id, name: "Limpieza", durationMin: 60, bufferMin: 10, priceCents: 2_500_050 });
  const hidratacion = await svc({ categoryId: faciales.id, name: "Hidratación", durationMin: 45, priceCents: 1_800_000, variablePrice: true });
  const masaje = await svc({ categoryId: corporales.id, name: "Masaje", durationMin: 60, onlineBooking: false, locationIds: [biz.locationIds[1]] });
  assert.equal(limpieza.priceCents, 2_500_050, "céntimos exactos");
  assert.deepEqual([limpieza.position, hidratacion.position, masaje.position], [0, 1, 0]);
  assert.deepEqual(masaje.locationIds, [biz.locationIds[1]]);
  assert.equal(masaje.onlineBooking, false);

  // Montos y duraciones inválidos.
  for (const bad of [{ priceCents: -1 }, { priceCents: 10.5 }, { durationMin: 7 }, { durationMin: 0 }, { bufferMin: -5 }]) {
    const res = await b.post(`${API}/settings/services`, { name: "Malo", durationMin: 30, ...bad });
    assert.equal(res.status, 400, JSON.stringify(bad));
  }

  // Bajar "Limpieza" (queda Hidratación, Limpieza) y subir "Corporales".
  const order = await b.request("PUT", `${API}/settings/services/order`, { categoryId: faciales.id, ids: [hidratacion.id, limpieza.id] });
  assert.equal(order.status, 200, JSON.stringify(order.body));
  const catOrder = await b.request("PUT", `${API}/settings/service-categories/order`, { ids: [corporales.id, faciales.id] });
  assert.deepEqual(
    catOrder.body.data.map((c: { name: string }) => c.name),
    ["Corporales", "Faciales"],
  );
  let catalog = (await b.get(`${API}/settings/services`)).body.data;
  assert.deepEqual(
    catalog.services.map((s: { name: string }) => s.name),
    ["Masaje", "Hidratación", "Limpieza"],
  );
  // Una lista incompleta o con ids de más se rechaza.
  assert.equal((await b.request("PUT", `${API}/settings/services/order`, { categoryId: faciales.id, ids: [limpieza.id] })).status, 400);
  assert.equal((await b.request("PUT", `${API}/settings/service-categories/order`, { ids: [faciales.id, faciales.id] })).status, 400);

  // Cambiar de categoría: va al final de la nueva.
  const moved = await b.patch(`${API}/settings/services/${limpieza.id}`, { categoryId: corporales.id, priceCents: 2_600_000 });
  assert.equal(moved.body.data.position, 1);
  assert.equal(moved.body.data.priceCents, 2_600_000);
  // Borrar una categoría deja sus servicios sin categoría (al final).
  assert.equal((await b.request("DELETE", `${API}/settings/service-categories/${corporales.id}`)).status, 204);
  catalog = (await b.get(`${API}/settings/services`)).body.data;
  assert.deepEqual(
    catalog.categories.map((c: { name: string }) => c.name),
    ["Faciales"],
  );
  assert.deepEqual(
    catalog.services.map((s: { name: string; categoryId: string | null }) => [s.name, s.categoryId]),
    [
      ["Hidratación", faciales.id],
      ["Masaje", null],
      ["Limpieza", null],
    ],
  );
  // Borrar un servicio.
  assert.equal((await b.request("DELETE", `${API}/settings/services/${hidratacion.id}`)).status, 204);
  const history = await listConfigHistory(db, biz.businessId, { entity: "service", entityId: hidratacion.id });
  assert.equal((history[0].snapshot as { deleted?: boolean }).deleted, true);
});

// ─── Equipo ─────────────────────────────────────────────────────────────────

test("equipo: profesionales con color, usuario vinculado, horario por sucursal sin cruces y orden", async () => {
  const biz = await createTestBusiness(db);
  const [central, norte] = biz.locationIds;
  const { b } = await ownerOf(biz.businessId);
  const pro = await createTestMember(db, { businessId: biz.businessId, role: "staff", name: "Ana Rojas" });

  const ana = (await b.post(`${API}/settings/staff`, { name: "Ana", membershipId: pro.membershipId })).body.data;
  const beto = (await b.post(`${API}/settings/staff`, { name: "Beto", color: "#123abc" })).body.data;
  assert.match(ana.color, /^#[0-9a-f]{6}$/i, "color por defecto");
  assert.equal(beto.color, "#123abc");
  assert.deepEqual(ana.member, { name: "Ana Rojas", email: pro.email });
  const dup = await b.post(`${API}/settings/staff`, { name: "Otra Ana", membershipId: pro.membershipId });
  assert.equal(dup.status, 409);
  assert.equal(dup.body.code, "membership_taken");

  const h1 = await b.request("PUT", `${API}/settings/staff/${ana.id}/hours`, {
    locationId: central,
    hours: [
      { weekday: 1, start: "09:00", end: "13:00" },
      { weekday: 1, start: "14:00", end: "18:00" },
    ],
  });
  assert.equal(h1.status, 200, JSON.stringify(h1.body));
  // Martes en la otra sucursal: no choca.
  const h2 = await b.request("PUT", `${API}/settings/staff/${ana.id}/hours`, { locationId: norte, hours: [{ weekday: 2, start: "10:00", end: "18:00" }] });
  assert.equal(h2.body.data.hours.length, 3);
  // El lunes 12:00–15:00 en Norte choca con lo que hace en Central.
  const clash = await b.request("PUT", `${API}/settings/staff/${ana.id}/hours`, { locationId: norte, hours: [{ weekday: 1, start: "12:00", end: "15:00" }] });
  assert.equal(clash.status, 400);
  assert.match(clash.body.fields["body.hours.0.start"], /otra sucursal/);

  const reorder = await b.request("PUT", `${API}/settings/staff/order`, { ids: [beto.id, ana.id] });
  assert.deepEqual(
    reorder.body.data.map((s: { name: string }) => s.name),
    ["Beto", "Ana"],
  );
  const unlinked = await b.patch(`${API}/settings/staff/${ana.id}`, { membershipId: null, active: false });
  assert.equal(unlinked.body.data.member, null);
  assert.equal(unlinked.body.data.active, false);
});

test("equipo: eliminar borra sin historial y desactiva con citas; servicios por profesional con precio propio", async () => {
  const biz = await createTestBusiness(db);
  const { b } = await ownerOf(biz.businessId);
  const temp = (await b.post(`${API}/settings/staff`, { name: "Temporal" })).body.data;
  assert.deepEqual((await b.request("DELETE", `${API}/settings/staff/${temp.id}`)).body.data, { deleted: true });

  const ana = (await b.post(`${API}/settings/staff`, { name: "Ana" })).body.data;
  await insertAppointment(biz.businessId, biz.locationIds[0], ana.id);
  const soft = await b.request("DELETE", `${API}/settings/staff/${ana.id}`);
  assert.equal(soft.body.data.deleted, false);
  assert.equal(soft.body.data.staff.active, false);

  const limpieza = (await b.post(`${API}/settings/services`, { name: "Limpieza", durationMin: 60, priceCents: 2_500_000 })).body.data;
  const masaje = (await b.post(`${API}/settings/services`, { name: "Masaje", durationMin: 60 })).body.data;
  assert.deepEqual((await b.get(`${API}/settings/staff/${ana.id}/services`)).body.data, { staffId: ana.id, allServices: true, services: [] });
  const put = await b.request("PUT", `${API}/settings/staff/${ana.id}/services`, {
    services: [{ serviceId: limpieza.id, priceCents: 2_800_000, durationMin: 75 }, { serviceId: masaje.id }],
  });
  assert.equal(put.status, 200, JSON.stringify(put.body));
  assert.equal(put.body.data.allServices, false);
  assert.deepEqual(
    put.body.data.services.find((s: { serviceId: string }) => s.serviceId === limpieza.id),
    { serviceId: limpieza.id, priceCents: 2_800_000, durationMin: 75 },
  );
  const dup = await b.request("PUT", `${API}/settings/staff/${ana.id}/services`, { services: [{ serviceId: masaje.id }, { serviceId: masaje.id }] });
  assert.equal(dup.status, 400);
  assert.equal((await b.request("PUT", `${API}/settings/staff/${ana.id}/services`, { services: [] })).body.data.allServices, true);
});

test("ausencias: del negocio, de una sucursal y de un profesional; validación del rango; editar y borrar", async () => {
  const biz = await createTestBusiness(db);
  const { b } = await ownerOf(biz.businessId);
  const ana = (await b.post(`${API}/settings/staff`, { name: "Ana" })).body.data;

  const holiday = await b.post(`${API}/settings/time-off`, { startsAt: "2026-12-24T00:00:00-06:00", endsAt: "2026-12-26T00:00:00-06:00", reason: "Navidad" });
  assert.equal(holiday.status, 201, JSON.stringify(holiday.body));
  assert.equal(holiday.body.data.scope, "business");
  assert.equal(holiday.body.data.startsAt, "2026-12-24T06:00:00.000Z");
  const closed = (await b.post(`${API}/settings/time-off`, { locationId: biz.locationIds[1], startsAt: "2026-11-02T13:00:00Z", endsAt: "2026-11-02T18:00:00Z" })).body.data;
  assert.equal(closed.scope, "location");
  const vacation = (await b.post(`${API}/settings/time-off`, { staffId: ana.id, startsAt: "2026-11-10T06:00:00Z", endsAt: "2026-11-17T06:00:00Z", reason: "Vacaciones" })).body.data;
  assert.equal(vacation.scope, "staff");

  const reversed = await b.post(`${API}/settings/time-off`, { startsAt: "2026-12-26T00:00:00-06:00", endsAt: "2026-12-24T00:00:00-06:00" });
  assert.equal(reversed.status, 400);
  assert.ok(reversed.body.fields["body.endsAt"]);
  const noZone = await b.post(`${API}/settings/time-off`, { startsAt: "2026-12-24T00:00", endsAt: "2026-12-25T00:00" });
  assert.ok(noZone.body.fields["body.startsAt"], "sin zona horaria no se acepta");

  const list = (await b.get(`${API}/settings/time-off?from=2026-10-01T00:00:00Z&to=2027-01-31T00:00:00Z`)).body.data;
  assert.deepEqual(
    list.map((t: { scope: string }) => t.scope),
    ["location", "staff", "business"],
  );
  const patched = await b.patch(`${API}/settings/time-off/${vacation.id}`, { endsAt: "2026-11-20T06:00:00Z" });
  assert.equal(patched.body.data.endsAt, "2026-11-20T06:00:00.000Z");
  assert.equal((await b.patch(`${API}/settings/time-off/${vacation.id}`, { endsAt: "2026-11-01T06:00:00Z" })).status, 400);
  assert.equal((await b.request("DELETE", `${API}/settings/time-off/${closed.id}`)).status, 204);
  assert.equal((await b.request("DELETE", `${API}/settings/time-off/${closed.id}`)).status, 404);
  const history = await listConfigHistory(db, biz.businessId, { entity: "time_off" });
  assert.equal(history.length, 5, "3 altas + 1 edición + 1 borrado");
});

test("historial de configuración: queda el usuario que hizo cada cambio, sin filas de otro negocio", async () => {
  const a = await createTestBusiness(db);
  const other = await createTestBusiness(db);
  const { b, userId } = await ownerOf(a.businessId);
  await b.post(`${API}/settings/staff`, { name: "Ana" });
  await b.post(`${API}/settings/service-categories`, { name: "Faciales" });
  const rows = await listConfigHistory(db, a.businessId);
  assert.deepEqual(rows.map((r) => r.entity).sort(), ["service_category", "staff"]);
  assert.ok(rows.every((r) => r.changedBy === userId));
  assert.deepEqual(await listConfigHistory(db, other.businessId), []);
  // Un staff de otro negocio no aparece aunque se pida por id.
  const [foreign] = await withTenant(db, other.businessId, (tx) =>
    tx.insert(staff).values({ businessId: other.businessId, name: "Ajena" }).returning({ id: staff.id }),
  );
  const visible = await withTenant(db, a.businessId, (tx) => tx.select().from(staff).where(and(eq(staff.id, foreign.id))));
  assert.deepEqual(visible, []);
});
