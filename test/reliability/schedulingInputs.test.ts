import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { eq } from "drizzle-orm";
import { createBusiness, getLocation, getLocationWeeklyHours, listLocations } from "../../src/modules/business";
import { businesses, customFields, locationHours, locations } from "../../src/modules/business/schema";
import { applyCatalogTemplate, getService, getServices, getStaffServiceOverrides, listBookableStaff } from "../../src/modules/catalog";
import { serviceLocations, services, staffServices } from "../../src/modules/catalog/schema";
import { getStaffMember, getStaffWeeklyHours, listStaff, listTimeOff } from "../../src/modules/team";
import { staff, staffHours, timeOff } from "../../src/modules/team/schema";
import { withSystem, withTenant } from "../../src/platform/db/scope";
import { createEphemeralDb } from "../helpers/pgliteDb";

// ─────────────────────────────────────────────────────────────────────────────
// API pública que usan la agenda (I1-Agenda) y el agente (I2) para calcular
// disponibilidad sin leer tablas ajenas: sucursales y su horario (business),
// profesionales, su horario y ausencias (team), servicios, overrides por profesional y
// "quién puede atender" (catalog). Y el alta de un negocio con la plantilla de su rubro.
// Todo corre con el rol de la app (RLS).
// ─────────────────────────────────────────────────────────────────────────────

const base = await createEphemeralDb();
const { db } = base;
after(() => base.close());

interface World {
  businessId: string;
  escazu: string;
  heredia: string;
  ana: string;
  carla: string;
  diego: string;
  inactive: string;
  limpieza: string;
  manicura: string;
  masaje: string;
  peeling: string;
}

let w: World;

before(async () => {
  await base.client.exec("SET ROLE app_runtime");
  const businessId = randomUUID();
  w = await withTenant(db, businessId, async (tx) => {
    await tx.insert(businesses).values({ id: businessId, slug: `api-${businessId.slice(0, 8)}`, name: "Estética API" });
    const [escazu, heredia] = await tx
      .insert(locations)
      .values([
        { businessId, name: "Escazú", timezone: "America/Costa_Rica", position: 0 },
        { businessId, name: "Heredia", timezone: "America/Costa_Rica", position: 1, active: false },
      ])
      .returning({ id: locations.id });
    await tx.insert(locationHours).values([
      { businessId, locationId: escazu.id, weekday: 1, opensAt: "14:00", closesAt: "19:00" },
      { businessId, locationId: escazu.id, weekday: 1, opensAt: "09:00", closesAt: "13:00" },
    ]);
    const [ana, carla, diego, inactive] = await tx
      .insert(staff)
      .values([
        { businessId, name: "Ana", position: 0 },
        { businessId, name: "Carla", position: 1 },
        { businessId, name: "Diego", position: 2 },
        { businessId, name: "Inactiva", position: 3, active: false },
      ])
      .returning({ id: staff.id });
    await tx.insert(staffHours).values([
      { businessId, staffId: ana.id, locationId: escazu.id, weekday: 1, startsAt: "09:00", endsAt: "13:00" },
      { businessId, staffId: ana.id, locationId: heredia.id, weekday: 2, startsAt: "10:00", endsAt: "18:00" },
      { businessId, staffId: carla.id, locationId: escazu.id, weekday: 1, startsAt: "14:00", endsAt: "19:00" },
      { businessId, staffId: diego.id, locationId: heredia.id, weekday: 3, startsAt: "10:00", endsAt: "18:00" },
      { businessId, staffId: inactive.id, locationId: escazu.id, weekday: 1, startsAt: "09:00", endsAt: "19:00" },
    ]);
    const [limpieza, manicura, masaje, peeling] = await tx
      .insert(services)
      .values([
        { businessId, name: "Limpieza", durationMin: 60, bufferMin: 10, priceCents: 2_500_000, position: 0 },
        { businessId, name: "Manicura", durationMin: 40, priceCents: 800_000, position: 1 },
        { businessId, name: "Masaje", durationMin: 60, priceCents: 2_200_000, position: 2, onlineBooking: false },
        { businessId, name: "Peeling", durationMin: 45, priceCents: 3_000_000, position: 3, active: false },
      ])
      .returning({ id: services.id });
    // Manicura solo en Escazú.
    await tx.insert(serviceLocations).values({ businessId, serviceId: manicura.id, locationId: escazu.id });
    // Ana: limpieza (con precio y duración propios) y masaje. Carla: sin filas = todo. Diego: solo masaje.
    await tx.insert(staffServices).values([
      { businessId, staffId: ana.id, serviceId: limpieza.id, priceCents: 2_800_000, durationMin: 75 },
      { businessId, staffId: ana.id, serviceId: masaje.id },
      { businessId, staffId: diego.id, serviceId: masaje.id },
    ]);
    await tx.insert(timeOff).values([
      { businessId, startsAt: new Date("2026-12-24T06:00:00Z"), endsAt: new Date("2026-12-26T06:00:00Z"), reason: "Navidad" },
      { businessId, locationId: escazu.id, startsAt: new Date("2026-11-02T15:00:00Z"), endsAt: new Date("2026-11-02T18:00:00Z") },
      { businessId, locationId: heredia.id, startsAt: new Date("2026-11-03T15:00:00Z"), endsAt: new Date("2026-11-03T18:00:00Z") },
      { businessId, staffId: ana.id, startsAt: new Date("2026-11-10T06:00:00Z"), endsAt: new Date("2026-11-17T06:00:00Z") },
      { businessId, staffId: carla.id, locationId: heredia.id, startsAt: new Date("2026-11-11T15:00:00Z"), endsAt: new Date("2026-11-11T18:00:00Z") },
    ]);
    return {
      businessId,
      escazu: escazu.id,
      heredia: heredia.id,
      ana: ana.id,
      carla: carla.id,
      diego: diego.id,
      inactive: inactive.id,
      limpieza: limpieza.id,
      manicura: manicura.id,
      masaje: masaje.id,
      peeling: peeling.id,
    };
  });
});

test("business: sucursales con su horario semanal (ordenado, horas locales)", async () => {
  const all = await listLocations(db, w.businessId);
  assert.deepEqual(
    all.map((l) => [l.name, l.active]),
    [
      ["Escazú", true],
      ["Heredia", false],
    ],
  );
  assert.deepEqual(
    (await listLocations(db, w.businessId, { activeOnly: true })).map((l) => l.name),
    ["Escazú"],
  );
  assert.deepEqual(await getLocationWeeklyHours(db, w.businessId, w.escazu), [
    { weekday: 1, start: "09:00", end: "13:00" },
    { weekday: 1, start: "14:00", end: "19:00" },
  ]);
  assert.equal((await getLocation(db, w.businessId, w.escazu.toUpperCase()))?.timezone, "America/Costa_Rica");
  assert.equal(await getLocation(db, w.businessId, randomUUID()), null);
  assert.deepEqual(await getLocationWeeklyHours(db, w.businessId, randomUUID()), []);
});

test("team: profesionales (activos, por sucursal), su horario y uno por id", async () => {
  assert.deepEqual(
    (await listStaff(db, w.businessId)).map((s) => s.name),
    ["Ana", "Carla", "Diego", "Inactiva"],
  );
  assert.deepEqual(
    (await listStaff(db, w.businessId, { activeOnly: true, locationId: w.escazu })).map((s) => s.name),
    ["Ana", "Carla"],
  );
  assert.deepEqual(await getStaffWeeklyHours(db, w.businessId, { staffId: w.ana, locationId: w.escazu }), [
    { staffId: w.ana, locationId: w.escazu, weekday: 1, start: "09:00", end: "13:00" },
  ]);
  assert.equal((await getStaffWeeklyHours(db, w.businessId, { locationId: w.escazu })).length, 3);
  assert.equal((await getStaffMember(db, w.businessId, w.diego))?.name, "Diego");
  assert.equal(await getStaffMember(db, randomUUID(), w.diego), null, "desde otro negocio no se ve");
});

test("team: ausencias que afectan a una sucursal o a un profesional en un rango", async () => {
  const range = { from: new Date("2026-11-01T00:00:00Z"), to: new Date("2027-01-01T00:00:00Z") };
  const reasons = (list: { scope: string; locationId: string | null; staffId: string | null }[]) =>
    list.map((t) => `${t.scope}:${t.locationId === w.escazu ? "escazu" : t.locationId === w.heredia ? "heredia" : "-"}:${t.staffId === w.ana ? "ana" : t.staffId === w.carla ? "carla" : "-"}`);

  assert.equal((await listTimeOff(db, w.businessId, range)).length, 5, "sin filtros: todas");
  // Escazú: el feriado, el cierre de Escazú y la ausencia de Ana (en todas sus sucursales); no lo de Heredia.
  assert.deepEqual(reasons(await listTimeOff(db, w.businessId, { ...range, locationId: w.escazu })), [
    "location:escazu:-",
    "staff:-:ana",
    "business:-:-",
  ]);
  // Carla en Escazú: el feriado y el cierre de Escazú (su ausencia es en Heredia).
  assert.deepEqual(reasons(await listTimeOff(db, w.businessId, { ...range, locationId: w.escazu, staffId: w.carla })), [
    "location:escazu:-",
    "business:-:-",
  ]);
  // Rango que no toca nada; los bordes son [from, to).
  assert.deepEqual(await listTimeOff(db, w.businessId, { from: new Date("2026-11-17T06:00:00Z"), to: new Date("2026-11-18T00:00:00Z"), staffId: w.ana }), []);
  const first = (await listTimeOff(db, w.businessId, { ...range, staffId: w.ana }))[0];
  assert.ok(first.startsAt instanceof Date);
});

test("catalog: servicios (activos, online, por sucursal) y overrides por profesional", async () => {
  assert.deepEqual(
    (await getServices(db, w.businessId)).map((s) => s.name),
    ["Limpieza", "Manicura", "Masaje", "Peeling"],
  );
  assert.deepEqual(
    (await getServices(db, w.businessId, { activeOnly: true, onlineOnly: true })).map((s) => s.name),
    ["Limpieza", "Manicura"],
  );
  assert.deepEqual(
    (await getServices(db, w.businessId, { activeOnly: true, locationId: w.heredia })).map((s) => s.name),
    ["Limpieza", "Masaje"],
    "manicura solo en Escazú",
  );
  const limpieza = await getService(db, w.businessId, w.limpieza);
  assert.deepEqual([limpieza?.durationMin, limpieza?.bufferMin, limpieza?.priceCents], [60, 10, 2_500_000]);
  assert.equal(await getService(db, randomUUID(), w.limpieza), null);
  assert.deepEqual(await getStaffServiceOverrides(db, w.businessId, { serviceId: w.limpieza }), [
    { staffId: w.ana, serviceId: w.limpieza, priceCents: 2_800_000, durationMin: 75 },
  ]);
  assert.equal((await getStaffServiceOverrides(db, w.businessId, { staffId: w.ana })).length, 2);
});

test("catalog: quién puede atender un servicio en una sucursal, con sus condiciones efectivas", async () => {
  const names = (list: { name: string }[]) => list.map((s) => s.name);
  // Sin servicio: activos con horario en la sucursal.
  const inEscazu = await listBookableStaff(db, w.businessId, { locationId: w.escazu });
  assert.deepEqual(names(inEscazu), ["Ana", "Carla"]);
  assert.ok(inEscazu.every((s) => s.service === null));

  // Limpieza en Escazú: Ana (con su precio y duración) y Carla (hace todo, valores del servicio).
  const limpieza = await listBookableStaff(db, w.businessId, { locationId: w.escazu, serviceId: w.limpieza });
  assert.deepEqual(
    limpieza.map((s) => [s.name, s.service?.durationMin, s.service?.priceCents, s.service?.bufferMin]),
    [
      ["Ana", 75, 2_800_000, 10],
      ["Carla", 60, 2_500_000, 10],
    ],
  );
  // Masaje en cualquier sucursal: Ana, Carla y Diego (Diego solo hace masaje).
  assert.deepEqual(names(await listBookableStaff(db, w.businessId, { serviceId: w.masaje })), ["Ana", "Carla", "Diego"]);
  // Manicura en Heredia: no se ofrece ahí.
  assert.deepEqual(await listBookableStaff(db, w.businessId, { locationId: w.heredia, serviceId: w.manicura }), []);
  // Servicio desactivado o inexistente: nadie.
  assert.deepEqual(await listBookableStaff(db, w.businessId, { serviceId: w.peeling }), []);
  assert.deepEqual(await listBookableStaff(db, w.businessId, { serviceId: randomUUID() }), []);
});

test("alta de negocio: aplica la plantilla del rubro (terminología, reglas, campos y catálogo)", async () => {
  const { business, location } = await createBusiness(
    db,
    { name: "Clínica Dental Sonrisa", industry: "dental", timezone: "America/Costa_Rica", currency: "CRC", country: "CR", locationName: "Central" },
    { seedCatalog: applyCatalogTemplate },
  );
  assert.equal(business.terminology.client, "paciente");
  assert.equal(business.clientStatusRules.atRiskAfterDays, 210);
  const catalog = await getServices(db, business.id);
  assert.ok(catalog.length >= 8);
  assert.ok(catalog.some((s) => s.name === "Limpieza dental" && s.bufferMin === 15 && s.priceCents === 0));
  assert.ok(catalog.some((s) => s.name === "Endodoncia" && s.variablePrice && !s.onlineBooking));
  const fields = await withTenant(db, business.id, (tx) => tx.select().from(customFields).where(eq(customFields.businessId, business.id)));
  assert.deepEqual(
    fields.map((f) => `${f.entity}:${f.key}`).sort(),
    ["appointment:tooth", "client:allergies", "client:current_medications", "client:health_insurance"],
  );
  assert.equal((await getLocationWeeklyHours(db, business.id, location.id)).length, 6, "horario default de la primera sucursal");

  // Si falla un paso (p. ej. el catálogo), no queda nada a medias.
  const before = await withSystem(db, (tx) => tx.select({ id: businesses.id }).from(businesses));
  await assert.rejects(
    createBusiness(
      db,
      { name: "Uñas Rotas", industry: "nails", timezone: "America/Panama", currency: "USD", country: "PA", locationName: "Centro" },
      {
        seedCatalog: async () => {
          throw new Error("falla simulada del catálogo");
        },
      },
    ),
    /falla simulada/,
  );
  const afterRows = await withSystem(db, (tx) => tx.select({ id: businesses.id }).from(businesses));
  assert.equal(afterRows.length, before.length);
});
