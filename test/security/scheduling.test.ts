import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { eq } from "drizzle-orm";

// ─────────────────────────────────────────────────────────────────────────────
// Agenda por HTTP (I1) con la app real sobre PGlite como el rol de la app (RLS):
// disponibilidad, alta y acciones de una cita, conflictos (409), permisos por rol y por
// sucursal (el profesional solo lo suyo; recepción solo sus sucursales), el historial de
// la ficha y el Inicio básico (/home/today).
// ─────────────────────────────────────────────────────────────────────────────

process.env.TRUST_PROXY = "loopback";
process.env.PANEL_SESSION_SECRET = "test-scheduling-session-secret-0123456789";
process.env.TOKENS_ENCRYPTION_KEY = "d".repeat(64);
process.env.PANEL_LOGIN_RATE_LIMIT_MAX_IP = "200";

const { createAppHandler } = await import("../../src/app");
const { bookAppointment } = await import("../../src/modules/scheduling");
const { staff } = await import("../../src/modules/team/schema");
const { localDayBounds } = await import("../../src/modules/scheduling/time");
const { withTenant } = await import("../../src/platform/db/scope");
const { createEphemeralDb } = await import("../helpers/pgliteDb");
const { Browser, startTestServer } = await import("../helpers/panelClient");
const { createTestMember } = await import("../helpers/identityFixtures");
const { createSchedulingWorld, CR, crAt, crDay } = await import("../helpers/schedulingFixtures");

type B = InstanceType<typeof Browser>;
type World = Awaited<ReturnType<typeof createSchedulingWorld>>;

const base = await createEphemeralDb();
const { db } = base;
let app: Awaited<ReturnType<typeof startTestServer>>;
let w: World;
let owner: B;
let frontDesk: B;
let anaUser: B;
let loneStaff: B;

const DAY = crDay(3);
const API = "/api/panel";

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
  const member = async (role: "owner" | "front_desk" | "staff", locationIds?: string[]) => {
    const m = await createTestMember(db, { businessId: w.businessId, role, locationIds });
    return { browser: await loggedIn(m.email, m.password), membershipId: m.membershipId };
  };
  owner = (await member("owner")).browser;
  frontDesk = (await member("front_desk", [w.escazu])).browser;
  const ana = await member("staff");
  anaUser = ana.browser;
  loneStaff = (await member("staff")).browser;
  await withTenant(db, w.businessId, (tx) => tx.update(staff).set({ membershipId: ana.membershipId }).where(eq(staff.id, w.ana)));
});

after(async () => {
  await app?.close();
  await base.close();
});

const body = (overrides: Record<string, unknown> = {}) => ({
  locationId: w.escazu,
  clientId: w.maria,
  serviceIds: [w.limpieza],
  staffId: w.ana,
  startsAt: crAt(DAY, "09:00").toISOString(),
  ...overrides,
});

async function create(b: B, overrides: Record<string, unknown> = {}) {
  const res = await b.post(`${API}/appointments`, body(overrides));
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.data;
}

const range = (date = DAY) => {
  const { start, end } = localDayBounds(date, CR);
  return `from=${encodeURIComponent(start.toISOString())}&to=${encodeURIComponent(end.toISOString())}`;
};

test("disponibilidad del día: horarios con quién los puede tomar, en la zona de la sucursal", async () => {
  const res = await owner.get(`${API}/availability?locationId=${w.escazu}&date=${DAY}&serviceIds=${w.limpieza}&staffId=any`);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const { slots, timezone } = res.body.data;
  assert.equal(timezone, CR);
  const at = (hm: string) => slots.find((s: { startsAt: string }) => s.startsAt === crAt(DAY, hm).toISOString());
  assert.deepEqual(at("09:00").staff.map((s: { id: string }) => s.id), [w.ana]);
  assert.deepEqual(at("14:00").staff.map((s: { id: string }) => s.id), [w.ana, w.beto]);
  assert.equal(at("14:00").staff[1].totalCents, 3_000_000);
  assert.equal(at("12:30"), undefined);
  const bad = await owner.get(`${API}/availability?locationId=${w.escazu}&date=31-12-2026&serviceIds=nope`);
  assert.equal(bad.status, 400);
  assert.ok(bad.body.fields["query.date"]);
  assert.ok(bad.body.fields["query.serviceIds.0"] ?? bad.body.fields["query.serviceIds"]);
});

test("ciclo de una cita por HTTP: alta, lista, notas, confirmar, reprogramar, reasignar, cancelar", async () => {
  const appt = await create(owner, { notes: "Trae su crema" });
  assert.equal(appt.status, "pending");
  assert.equal(appt.services[0].name, "Limpieza");

  const dup = await owner.post(`${API}/appointments`, body({ clientId: w.sofia }));
  assert.equal(dup.status, 409);
  assert.equal(dup.body.code, "slot_taken");

  const list = await owner.get(`${API}/appointments?${range()}`);
  assert.equal(list.status, 200);
  assert.ok(list.body.data.some((a: { id: string; client: { name: string } }) => a.id === appt.id && a.client.name === "María Fernández"));

  const notes = await owner.patch(`${API}/appointments/${appt.id}`, { notes: "Trae su crema y su toalla" });
  assert.equal(notes.body.data.notes, "Trae su crema y su toalla");
  assert.equal((await owner.post(`${API}/appointments/${appt.id}/confirm`)).body.data.status, "confirmed");
  const twice = await owner.post(`${API}/appointments/${appt.id}/confirm`);
  assert.equal(twice.status, 409);
  assert.equal(twice.body.code, "invalid_transition");

  const moved = await owner.post(`${API}/appointments/${appt.id}/reschedule`, { startsAt: crAt(DAY, "15:00").toISOString() });
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  assert.equal(moved.body.data.startsAt, crAt(DAY, "15:00").toISOString());
  const outside = await owner.post(`${API}/appointments/${appt.id}/reschedule`, { startsAt: crAt(DAY, "12:30").toISOString() });
  assert.equal(outside.status, 400);
  assert.ok(outside.body.fields.startsAt);

  const assigned = await owner.post(`${API}/appointments/${appt.id}/assign`, { staffId: w.beto });
  assert.equal(assigned.body.data.staff.name, "Beto");
  const early = await owner.post(`${API}/appointments/${appt.id}/complete`);
  assert.equal(early.status, 409);
  assert.equal(early.body.code, "too_early");
  const cancelled = await owner.post(`${API}/appointments/${appt.id}/cancel`, { reason: "Se enfermó" });
  assert.equal(cancelled.body.data.status, "cancelled");
  assert.equal(cancelled.body.data.cancellationReason, "Se enfermó");
  const tooBig = await owner.get(`${API}/appointments?from=2026-01-01T00:00:00Z&to=2026-06-01T00:00:00Z`);
  assert.equal(tooBig.status, 400);
});

test("recepción: solo sus sucursales", async () => {
  const inHeredia = await create(owner, { locationId: w.heredia, staffId: w.carla, startsAt: crAt(DAY, "10:00").toISOString() });
  const res = await frontDesk.post(`${API}/appointments`, body({ locationId: w.heredia, staffId: w.carla, startsAt: crAt(DAY, "11:00").toISOString() }));
  assert.equal(res.status, 403);
  assert.equal(res.body.code, "location_forbidden");
  assert.equal((await frontDesk.get(`${API}/appointments/${inHeredia.id}`)).status, 403);
  assert.equal((await frontDesk.post(`${API}/appointments/${inHeredia.id}/cancel`, { reason: "x" })).status, 403);
  const header = await frontDesk.get(`${API}/appointments?${range()}`, { "x-location-id": w.heredia });
  assert.equal(header.status, 403);
  const mine = await frontDesk.get(`${API}/appointments?${range()}`);
  assert.equal(mine.status, 200);
  assert.ok(mine.body.data.every((a: { locationId: string }) => a.locationId === w.escazu));
  assert.equal((await frontDesk.get(`${API}/availability?locationId=${w.heredia}&date=${DAY}&serviceIds=${w.limpieza}`)).status, 403);
  // En su sucursal opera normal.
  const own = await create(frontDesk, { startsAt: crAt(DAY, "16:30").toISOString() });
  assert.equal((await frontDesk.post(`${API}/appointments/${own.id}/cancel`, {})).body.data.status, "cancelled");
  await owner.post(`${API}/appointments/${inHeredia.id}/cancel`, {});
});

test("profesional: ve y opera solo sus citas", async () => {
  const anas = await create(owner, { startsAt: crAt(DAY, "08:00").toISOString() });
  const betos = await create(owner, { staffId: w.beto, startsAt: crAt(DAY, "17:00").toISOString(), clientId: w.sofia });

  const me = await anaUser.get(`${API}/auth/me`);
  assert.equal(me.body.data.staffId, w.ana);
  const list = await anaUser.get(`${API}/appointments?${range()}`);
  assert.ok(list.body.data.length >= 1);
  assert.ok(list.body.data.every((a: { staffId: string }) => a.staffId === w.ana));
  assert.equal((await anaUser.get(`${API}/appointments?${range()}&staffId=${w.beto}`)).status, 403);

  const other = await anaUser.get(`${API}/appointments/${betos.id}`);
  assert.equal(other.status, 403);
  assert.equal(other.body.code, "own_appointments_only");
  assert.equal((await anaUser.post(`${API}/appointments/${betos.id}/confirm`)).status, 403);
  assert.equal((await anaUser.post(`${API}/appointments/${anas.id}/confirm`)).body.data.status, "confirmed");
  const assign = await anaUser.post(`${API}/appointments/${anas.id}/assign`, { staffId: w.beto });
  assert.equal(assign.status, 403);
  assert.equal(assign.body.code, "forbidden_role");
  assert.equal((await anaUser.post(`${API}/appointments/${anas.id}/reschedule`, { startsAt: crAt(DAY, "15:00").toISOString(), staffId: w.beto })).status, 403);

  // Alta: con "cualquiera" queda en su carril; para otro, 403.
  const forOther = await anaUser.post(`${API}/appointments`, body({ staffId: w.beto, startsAt: crAt(DAY, "18:00").toISOString() }));
  assert.equal(forOther.status, 403);
  const forced = await anaUser.post(`${API}/appointments`, body({ staffId: "any", startsAt: crAt(DAY, "18:00").toISOString(), clientId: w.sofia }));
  assert.equal(forced.status, 201, JSON.stringify(forced.body));
  assert.equal(forced.body.data.staffId, w.ana);
  assert.equal((await anaUser.get(`${API}/availability?locationId=${w.escazu}&date=${DAY}&serviceIds=${w.limpieza}&staffId=${w.beto}`)).status, 403);
  const slots = await anaUser.get(`${API}/availability?locationId=${w.escazu}&date=${DAY}&serviceIds=${w.limpieza}`);
  assert.ok(slots.body.data.slots.every((s: { staff: { id: string }[] }) => s.staff.every((x) => x.id === w.ana)));

  // Historial de la ficha: solo lo suyo.
  const history = await anaUser.get(`${API}/clients/${w.sofia}/appointments`);
  assert.equal(history.status, 200);
  assert.ok(history.body.data.items.every((a: { staffId: string }) => a.staffId === w.ana));
  assert.equal((await anaUser.get(`${API}/home/today`)).status, 403);

  // Sin profesional vinculado: no ve nada ni agenda.
  assert.deepEqual((await loneStaff.get(`${API}/appointments?${range()}`)).body.data, []);
  assert.equal((await loneStaff.post(`${API}/appointments`, body({ startsAt: crAt(DAY, "18:30").toISOString() }))).status, 403);

  for (const a of [anas, betos, forced.body.data]) await owner.post(`${API}/appointments/${a.id}/cancel`, {});
});

test("historial del cliente para la ficha: de la más nueva a la más vieja, paginado", async () => {
  const day = crDay(8);
  const made = [];
  for (const hm of ["08:00", "09:15", "10:30"]) made.push(await create(owner, { clientId: w.sofia, startsAt: crAt(day, hm).toISOString() }));
  const page1 = await owner.get(`${API}/clients/${w.sofia}/appointments?limit=2`);
  assert.equal(page1.status, 200);
  assert.equal(page1.body.data.items.length, 2);
  assert.equal(page1.body.data.items[0].id, made[2].id);
  assert.ok(page1.body.data.nextCursor);
  const page2 = await owner.get(`${API}/clients/${w.sofia}/appointments?limit=2&cursor=${encodeURIComponent(page1.body.data.nextCursor)}`);
  assert.equal(page2.body.data.items[0].id, made[0].id);
  assert.equal((await owner.get(`${API}/clients/00000000-0000-4000-8000-000000000000/appointments`)).status, 404);
  for (const a of made) await owner.post(`${API}/appointments/${a.id}/cancel`, {});
});

test("Inicio básico: hoy por estado, próximas, sin confirmar, no-show y las del agente", async () => {
  const now = new Date();
  const today = crDay(0);
  const { start, end } = localDayBounds(today, CR);
  const earlier = new Date(start.getTime() + (now.getTime() - start.getTime()) / 2);
  const later = new Date(now.getTime() + (end.getTime() - now.getTime()) / 2);
  const missed = await create(owner, { clientId: w.sofia, startsAt: earlier.toISOString(), allowOutsideHours: true });
  assert.equal((await owner.post(`${API}/appointments/${missed.id}/no-show`)).body.data.status, "no_show");
  const coming = await create(owner, { startsAt: later.toISOString(), allowOutsideHours: true });
  const fromBot = await bookAppointment(db, w.businessId, {
    locationId: w.escazu,
    clientId: w.maria,
    serviceIds: [w.limpieza],
    staffId: w.ana,
    startsAt: crAt(crDay(1), "09:00"),
    channel: "whatsapp_ai",
  });

  const res = await owner.get(`${API}/home/today`);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const home = res.body.data;
  assert.equal(home.date, today);
  assert.equal(home.timezone, CR);
  assert.equal(home.conversationsWaiting, 0, "lo cuenta el módulo WhatsApp (ninguna esperando a una persona)");
  assert.ok(home.today.byStatus.no_show >= 1);
  assert.ok(home.today.total >= 2);
  assert.ok(home.noShowsToday.some((a: { id: string }) => a.id === missed.id));
  assert.ok(home.upcoming.some((a: { id: string }) => a.id === coming.id));
  const unconfirmedIds = home.unconfirmed.map((a: { id: string }) => a.id);
  assert.ok(unconfirmedIds.includes(coming.id) && unconfirmedIds.includes(fromBot.id));
  assert.ok(home.aiBookings.count >= 1);
  assert.ok(home.aiBookings.recent.some((a: { id: string }) => a.id === fromBot.id));

  // Con la sucursal de Heredia elegida, nada de Escazú.
  const heredia = await owner.get(`${API}/home/today`, { "x-location-id": w.heredia });
  assert.equal(heredia.body.data.locationId, w.heredia);
  assert.equal(heredia.body.data.noShowsToday.length, 0);
  assert.equal(heredia.body.data.aiBookings.count, 0);
  // Recepción (solo Escazú) lo ve.
  assert.equal((await frontDesk.get(`${API}/home/today`)).status, 200);
});
