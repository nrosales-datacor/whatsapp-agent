import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { eq } from "drizzle-orm";

// ─────────────────────────────────────────────────────────────────────────────
// Reportes, Inicio completo y métricas de producto por HTTP (I5) con la app real (planes
// reales de la composición) sobre PGlite como el rol de la app (RLS):
//   • gating: un negocio Básico recibe 403 `module_not_in_plan` en /reports/* (también el
//     CSV) y en /home/overview; /home/today sigue abierto;
//   • roles: Reportes es de dueño y admin (recepción y profesional → 403); el Inicio
//     completo también lo ve recepción;
//   • sucursal: un admin limitado a Escazú no pide Heredia (403) y sin sucursal solo ve lo
//     suyo; rango inválido → 400;
//   • CSV: text/csv, descarga con nombre, BOM, encabezados y fórmulas neutralizadas;
//   • daily_usage desde la composición: login, usuarios activos (una vez por día aunque
//     haya muchos requests), citas creadas y pagos registrados;
//   • superadmin: /admin/metrics y /admin/businesses/:id/usage solo con su sesión.
// ─────────────────────────────────────────────────────────────────────────────

process.env.TRUST_PROXY = "loopback";
process.env.PANEL_SESSION_SECRET = "test-reports-session-secret-0123456789abc";
process.env.TOKENS_ENCRYPTION_KEY = "d".repeat(64);
process.env.PANEL_LOGIN_RATE_LIMIT_MAX_IP = "500";
process.env.PANEL_SUPERADMIN_USERNAME = "root";
delete process.env.PANEL_SUPERADMIN_TOTP_SECRET;
const ADMIN_PASSWORD = "clave-del-superadmin-1";
const { hashPassword } = await import("../../src/platform/auth/password");
process.env.PANEL_SUPERADMIN_HASH = await hashPassword(ADMIN_PASSWORD);

const { createAppHandler } = await import("../../src/app");
const { invalidateBusinessContext } = await import("../../src/modules/business");
const { businesses } = await import("../../src/modules/business/schema");
const { services } = await import("../../src/modules/catalog/schema");
const { seedDefaultPaymentMethods } = await import("../../src/modules/sales");
const { bookAppointment, completeAppointment } = await import("../../src/modules/scheduling");
const { withTenant } = await import("../../src/platform/db/scope");
const { readDailyUsage, USAGE_METRICS } = await import("../../src/platform/observability/dailyUsage");
const { createEphemeralDb } = await import("../helpers/pgliteDb");
const { Browser, startTestServer } = await import("../helpers/panelClient");
const { createTestBusiness, createTestMember, ROOMY_EXTRAS } = await import("../helpers/identityFixtures");
const { createSchedulingWorld, crAt, crDay } = await import("../helpers/schedulingFixtures");

type B = InstanceType<typeof Browser>;
type World = Awaited<ReturnType<typeof createSchedulingWorld>>;
const API = "/api/panel";
const REPORTS = ["sales", "services", "staff", "clients", "channels"] as const;

const base = await createEphemeralDb();
const { db } = base;
let app: Awaited<ReturnType<typeof startTestServer>>;
let w: World;
let owner: B;
let admin: B;
let escazuAdmin: B;
let frontDesk: B;
let staffMember: B;
let cash: string;

async function loggedIn(email: string, password: string | null): Promise<B> {
  const b = new Browser(app.baseUrl);
  const res = await b.post(`${API}/auth/login`, { email, password });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return b;
}

before(async () => {
  await base.client.exec("SET ROLE app_runtime");
  app = await startTestServer(createAppHandler({ db, role: "all" }));
  w = await createSchedulingWorld(db);
  await withTenant(db, w.businessId, (tx) => tx.update(businesses).set({ plan: "pro", extraModules: ROOMY_EXTRAS }).where(eq(businesses.id, w.businessId)));
  invalidateBusinessContext(w.businessId);
  cash = (await seedDefaultPaymentMethods(db, { businessId: w.businessId }))[0].id;
  const member = async (role: "owner" | "admin" | "front_desk" | "staff", locationIds?: string[]) => {
    const m = await createTestMember(db, { businessId: w.businessId, role, locationIds });
    return { browser: await loggedIn(m.email, m.password), userId: m.userId };
  };
  owner = (await member("owner")).browser;
  admin = (await member("admin")).browser;
  escazuAdmin = (await member("admin", [w.escazu])).browser;
  frontDesk = (await member("front_desk", [w.escazu])).browser;
  staffMember = (await member("staff")).browser;

  // Datos: una cita completada y cobrada en cada sucursal, de un servicio con nombre "peligroso".
  await withTenant(db, w.businessId, (tx) => tx.update(services).set({ name: "=SUMA(A1)" }).where(eq(services.id, w.pedicura)));
  for (const [locationId, staffId, serviceId] of [
    [w.escazu, w.ana, w.limpieza],
    [w.heredia, w.carla, w.pedicura],
  ] as const) {
    const a = await bookAppointment(db, w.businessId, {
      locationId,
      clientId: w.maria,
      serviceIds: [serviceId],
      staffId,
      startsAt: crAt(crDay(-3), "10:00"),
      channel: "panel",
      allowOutsideHours: true,
    });
    await completeAppointment(db, w.businessId, a.id);
    const res = await owner.post(`${API}/appointments/${a.id}/payments`, { kind: "payment", amountCents: 1_000_000, methodId: cash });
    assert.equal(res.status, 201, JSON.stringify(res.body));
  }
});

after(async () => {
  await app?.close();
  await base.close();
});

test("gating: un negocio Básico recibe 403 module_not_in_plan en Reportes (y su CSV) y en el Inicio completo", async () => {
  const basic = await createTestBusiness(db, { plan: "basic", locations: ["Central"] });
  const m = await createTestMember(db, { businessId: basic.businessId, role: "owner" });
  const b = await loggedIn(m.email, m.password);
  for (const path of [...REPORTS.map((r) => `/reports/${r}`), ...REPORTS.map((r) => `/reports/${r}.csv`), "/home/overview"]) {
    const res = await b.get(`${API}${path}`);
    assert.equal(res.status, 403, `${path}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.code, "module_not_in_plan", path);
  }
  assert.equal((await b.get(`${API}/home/today`)).status, 200, "el Inicio básico sigue");
});

test("roles: Reportes es de dueño y admin; el Inicio completo lo ve también recepción, no el profesional", async () => {
  for (const r of REPORTS) {
    assert.equal((await owner.get(`${API}/reports/${r}`)).status, 200, `dueño: ${r}`);
    assert.equal((await admin.get(`${API}/reports/${r}`)).status, 200, `admin: ${r}`);
    const fd = await frontDesk.get(`${API}/reports/${r}`);
    assert.equal(fd.status, 403);
    assert.equal(fd.body.code, "forbidden_role");
    assert.equal((await staffMember.get(`${API}/reports/${r}.csv`)).status, 403);
  }
  const home = await frontDesk.get(`${API}/home/overview`);
  assert.equal(home.status, 200, JSON.stringify(home.body));
  assert.equal(home.body.data.collectedToday.netCents, 1_000_000, "recepción de Escazú: solo lo cobrado hoy en Escazú (no Heredia)");
  assert.equal((await owner.get(`${API}/home/overview`)).body.data.collectedToday.netCents, 2_000_000, "la dueña ve todas");
  assert.equal(home.body.data.revenue.length, 14);
  assert.equal((await staffMember.get(`${API}/home/overview`)).status, 403);
});

test("sucursal y rango: el admin de Escazú no pide Heredia y sin sucursal solo ve la suya; rango inválido → 400", async () => {
  const range = `from=${crDay(-7)}&to=${crDay(0)}`;
  const all = await owner.get(`${API}/reports/sales?${range}`);
  assert.equal(all.status, 200);
  assert.equal(all.body.data.totals.netCents, 2_000_000);
  assert.equal(all.body.data.range.days, 8);
  assert.equal(all.body.data.byDay.length, 8);
  assert.equal(all.body.data.byLocation.length, 2);

  const forbidden = await escazuAdmin.get(`${API}/reports/sales?${range}&locationId=${w.heredia}`);
  assert.equal(forbidden.status, 403);
  assert.equal(forbidden.body.code, "location_forbidden");
  const own = await escazuAdmin.get(`${API}/reports/sales?${range}`);
  assert.equal(own.body.data.totals.netCents, 1_000_000, "solo Escazú");
  const byHeader = await owner.get(`${API}/reports/staff?${range}`, { "x-location-id": w.heredia });
  assert.deepEqual(
    byHeader.body.data.items.filter((i: { appointments: number }) => i.appointments > 0).map((i: { name: string }) => i.name),
    ["Carla"],
    "la sucursal también puede venir por X-Location-Id",
  );

  for (const bad of [`from=${crDay(0)}&to=${crDay(-1)}`, `from=${crDay(-400)}&to=${crDay(0)}`, "from=2026-02-30", "locationId=nope"]) {
    const res = await owner.get(`${API}/reports/clients?${bad}`);
    assert.equal(res.status, 400, `${bad}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.code, "validation_error");
  }
});

test("CSV: descarga text/csv con nombre, BOM, encabezados con la moneda y fórmulas neutralizadas", async () => {
  const from = crDay(-7);
  const to = crDay(0);
  // El cliente de prueba parsea JSON: el CSV se pide crudo, con la cookie de la dueña.
  const raw = await fetch(`${app.baseUrl}${API}/reports/services.csv?from=${from}&to=${to}`, {
    headers: { cookie: [...owner.cookies].map(([k, v]) => `${k}=${v}`).join("; "), "x-forwarded-for": owner.ip },
  });
  assert.equal(raw.status, 200);
  assert.equal(raw.headers.get("content-type"), "text/csv; charset=utf-8");
  assert.equal(raw.headers.get("content-disposition"), `attachment; filename="reporte-servicios_${from}_${to}.csv"`);
  assert.equal(raw.headers.get("cache-control"), "no-store");
  const body = Buffer.from(await raw.arrayBuffer()).toString("utf8");
  assert.ok(body.startsWith("﻿"), "con BOM");
  const lines = body.slice(1).trimEnd().split("\r\n");
  assert.equal(lines[0], "Servicio,Agendados,Realizados,Valor realizado (CRC),Cobrado neto (CRC)");
  assert.ok(lines.includes("'=SUMA(A1),1,1,12000.00,10000.00"), lines.join(" | "));
  assert.ok(lines.includes("Limpieza,1,1,25000.00,10000.00"), lines.join(" | "));
});

test("daily_usage desde la composición: login, usuarios activos una vez por día, citas creadas y pagos", async () => {
  const today = crDay(0);
  const read = (metric: string) => readDailyUsage(db, w.businessId, { metric, from: today, to: today }).then((r) => r[0]?.value ?? 0);
  assert.equal(await read(USAGE_METRICS.logins), 5, "los cinco logins del before");
  const activeBefore = await read(USAGE_METRICS.activeUsers);
  for (let i = 0; i < 3; i++) await owner.get(`${API}/auth/me`);
  assert.equal(await read(USAGE_METRICS.activeUsers), activeBefore, "más requests de la misma persona no suman");
  assert.ok(activeBefore >= 1);
  assert.equal(await read(USAGE_METRICS.paymentsRecorded), 2, "los dos cobros del before (por HTTP)");

  const created = await owner.post(`${API}/appointments`, {
    locationId: w.escazu,
    clientId: w.sofia,
    serviceIds: [w.limpieza],
    staffId: w.ana,
    startsAt: crAt(crDay(-2), "16:00").toISOString(),
    allowOutsideHours: true,
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(await read(USAGE_METRICS.appointmentsCreated), 1, "las del before se crearon sin pasar por la ruta");
});

test("superadmin: /admin/metrics y /admin/businesses/:id/usage solo con su sesión", async () => {
  assert.equal((await owner.get(`${API}/admin/metrics`)).status, 401, "la sesión del panel no sirve");
  const root = new Browser(app.baseUrl);
  const login = await root.post(`${API}/admin/login`, { username: "root", password: ADMIN_PASSWORD });
  assert.equal(login.status, 200, JSON.stringify(login.body));

  const metrics = await root.get(`${API}/admin/metrics`);
  assert.equal(metrics.status, 200, JSON.stringify(metrics.body));
  const data = metrics.body.data;
  assert.equal(data.range.days, 30);
  assert.equal(data.daily.length, 30);
  const row = data.businesses.find((b: { id: string }) => b.id === w.businessId);
  assert.ok(row, "el negocio aparece");
  assert.equal(row.planLabel, "Pro");
  assert.equal(row.agentOn, false, "sin número conectado");
  assert.equal(row.usage.paymentsRecorded, 2);
  assert.ok(row.usage.logins >= 5);
  assert.equal(row.activation.activated, true, "entró alguien y creó una cita");
  assert.ok(data.totals.withActivity >= 1);
  assert.ok(data.totals.withAppointmentsLastWeek >= 1);
  assert.ok(data.totals.businesses >= 2);

  const usage = await root.get(`${API}/admin/businesses/${w.businessId}/usage?from=${crDay(-6)}&to=${crDay(0)}`);
  assert.equal(usage.status, 200);
  assert.equal(usage.body.data.daily.length, 7);
  assert.equal(usage.body.data.totals.paymentsRecorded, 2);
  assert.equal(usage.body.data.daily[6].date, crDay(0));
  assert.equal((await root.get(`${API}/admin/businesses/00000000-0000-4000-8000-000000000999/usage`)).status, 404);
  assert.equal((await root.get(`${API}/admin/metrics?from=${crDay(0)}&to=${crDay(-1)}`)).status, 400);
});
