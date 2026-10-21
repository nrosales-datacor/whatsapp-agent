import assert from "node:assert/strict";
import { test } from "node:test";
import {
  checkStart,
  computeSlots,
  summarizeTerms,
  type AvailabilityInputs,
  type BusyInterval,
  type StaffCandidate,
} from "../../src/modules/scheduling/availability";
import { addDays, localDatesBetween, localDayBounds, wallClock, weekdayOf, zonedInstant } from "../../src/modules/scheduling/time";

// ─────────────────────────────────────────────────────────────────────────────
// Disponibilidad pura (src/modules/scheduling/availability.ts): descansos, ausencias,
// buffers, varios servicios, margen mínimo, citas existentes, otro profesional libre y el
// cambio de día en la zona horaria de la sucursal. Sin base: los datos se arman a mano.
// ─────────────────────────────────────────────────────────────────────────────

const CR = "America/Costa_Rica"; // UTC−6, sin horario de verano
const MONDAY = "2026-10-26";
const LOCATION = "11111111-1111-4111-8111-111111111111";
const ANA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const BETO = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

/** "10:15" del lunes en Costa Rica → instante. */
const at = (hm: string, date = MONDAY, tz = CR) => {
  const [h, m] = hm.split(":").map(Number);
  return zonedInstant(date, h * 60 + m, tz);
};
const hhmm = (d: Date, tz = CR) => {
  const { minute } = wallClock(d, tz);
  return `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
};

function candidate(id: string, terms: Array<[number, number, number?]>): StaffCandidate {
  const t = terms.map(([durationMin, bufferMin, priceCents = 1000], i) => ({
    serviceId: `s${i}`,
    name: `Servicio ${i}`,
    durationMin,
    bufferMin,
    priceCents,
    variablePrice: false,
  }));
  return { id, name: id === ANA ? "Ana" : "Beto", color: null, position: id === ANA ? 0 : 1, terms: t, ...summarizeTerms(t) };
}

function world(overrides: Partial<AvailabilityInputs> = {}, date = MONDAY): AvailabilityInputs {
  const { start, end } = localDayBounds(date, CR);
  return {
    location: {
      id: LOCATION,
      name: "Escazú",
      timezone: CR,
      active: true,
      // Lunes con almuerzo.
      hours: [
        { weekday: 1, start: "09:00", end: "13:00" },
        { weekday: 1, start: "14:00", end: "19:00" },
      ],
    },
    services: [],
    candidates: [candidate(ANA, [[60, 10]]), candidate(BETO, [[60, 10]])],
    staffHours: [
      { staffId: ANA, locationId: LOCATION, weekday: 1, start: "09:00", end: "13:00" },
      { staffId: ANA, locationId: LOCATION, weekday: 1, start: "14:00", end: "19:00" },
      { staffId: BETO, locationId: LOCATION, weekday: 1, start: "14:00", end: "19:00" },
    ],
    timeOff: [],
    busy: [],
    from: start,
    to: end,
    ...overrides,
  };
}

/** Domingo anterior: nada de margen ni pasado en el medio. */
const EARLY = { now: new Date("2026-10-20T12:00:00Z"), minLeadMin: 30 };

const startsFor = (inputs: AvailabilityInputs, staffId: string, options = EARLY) =>
  computeSlots(inputs, options)
    .filter((s) => s.staff.some((x) => x.id === staffId))
    .map((s) => hhmm(s.startsAt));

test("tiempo: hora local ↔ instante y días locales en la zona de la sucursal", () => {
  assert.equal(at("09:00").toISOString(), "2026-10-26T15:00:00.000Z");
  assert.deepEqual(wallClock(new Date("2026-10-27T05:30:00Z"), CR), { date: MONDAY, minute: 23 * 60 + 30, weekday: 1 });
  assert.equal(weekdayOf(MONDAY), 1);
  assert.equal(addDays("2026-12-31", 1), "2027-01-01");
  const { start, end } = localDayBounds(MONDAY, CR);
  assert.equal(start.toISOString(), "2026-10-26T06:00:00.000Z");
  assert.equal(end.toISOString(), "2026-10-27T06:00:00.000Z");
  assert.deepEqual(localDatesBetween(start, end, CR), [MONDAY]);
  // Horario de verano (Nueva York, 8 de marzo de 2026): el día local dura 23 h.
  const ny = localDayBounds("2026-03-08", "America/New_York");
  assert.equal(ny.end.getTime() - ny.start.getTime(), 23 * 3600_000);
  assert.equal(zonedInstant("2026-03-08", 3 * 60, "America/New_York").toISOString(), "2026-03-08T07:00:00.000Z");
});

test("descansos: el trabajo cae entero en una ventana; el buffer final puede pasarse del cierre", () => {
  const ana = startsFor(world(), ANA);
  assert.equal(ana[0], "09:00");
  assert.ok(ana.includes("12:00"), "12:00–13:00 entra (la limpieza puede caer en el almuerzo)");
  for (const t of ["12:15", "12:45", "13:00", "13:30", "13:45"]) assert.ok(!ana.includes(t), `${t} pisa el almuerzo`);
  assert.ok(ana.includes("14:00"));
  assert.equal(ana.at(-1), "18:00", "la última del día termina al cierre");
  // Beto solo trabaja la tarde.
  assert.equal(startsFor(world(), BETO)[0], "14:00");
});

test("ausencias: del profesional, de la sucursal y del negocio", () => {
  const off = (startsAt: string, endsAt: string, scope: { staffId?: string; locationId?: string } = {}) => ({
    id: "t",
    scope: scope.staffId ? ("staff" as const) : scope.locationId ? ("location" as const) : ("business" as const),
    staffId: scope.staffId ?? null,
    locationId: scope.locationId ?? null,
    startsAt: at(startsAt),
    endsAt: at(endsAt),
    reason: null,
  });
  const mine = startsFor(world({ timeOff: [off("10:00", "11:00", { staffId: ANA })] }), ANA);
  assert.ok(mine.includes("09:00"), "09:00–10:00 no pisa la ausencia [10:00, 11:00)");
  for (const t of ["09:15", "10:00", "10:45"]) assert.ok(!mine.includes(t));
  assert.ok(mine.includes("11:00"));
  // La de Ana no afecta a Beto.
  assert.ok(startsFor(world({ timeOff: [off("14:00", "16:00", { staffId: ANA })] }), BETO).includes("14:00"));
  // Cierre de la sucursal y feriado del negocio: nadie.
  assert.deepEqual(startsFor(world({ timeOff: [off("00:00", "23:59", { locationId: LOCATION })] }), BETO), []);
  assert.deepEqual(computeSlots(world({ timeOff: [off("08:00", "20:00")] }), EARLY), []);
});

test("citas existentes y buffers: lo ocupado incluye la limpieza de las dos citas", () => {
  const busy: BusyInterval[] = [{ appointmentId: "x", staffId: ANA, startsAt: at("10:00"), endsAt: at("11:10") }];
  const ana = startsFor(world({ busy }), ANA);
  assert.ok(!ana.includes("09:00"), "09:00 + 60 min + 10 de limpieza pisa la de las 10:00");
  assert.ok(!ana.includes("11:00"), "a las 11:00 todavía está la limpieza de la anterior");
  assert.ok(ana.includes("11:15"));
  // Otro profesional libre: la cita de Ana no ocupa a Beto.
  const busyAfternoon: BusyInterval[] = [{ appointmentId: "y", staffId: ANA, startsAt: at("15:00"), endsAt: at("16:10") }];
  const slot = computeSlots(world({ busy: busyAfternoon }), EARLY).find((s) => hhmm(s.startsAt) === "15:00");
  assert.deepEqual(slot?.staff.map((s) => s.id), [BETO]);
  const both = computeSlots(world(), EARLY).find((s) => hhmm(s.startsAt) === "15:00");
  assert.deepEqual(both?.staff.map((s) => s.id), [ANA, BETO], "en el orden de la agenda");
  assert.equal(both?.staff[0].endsAt.toISOString(), at("16:10").toISOString());
});

test("varios servicios: uno detrás del otro con el mismo profesional", () => {
  // Manicura 40 + 5 de buffer, pedicura 60 + 10: trabajo 105 min, buffer final 10.
  const combo = candidate(ANA, [
    [40, 5, 800],
    [60, 10, 1200],
  ]);
  assert.equal(combo.workMin, 105);
  assert.equal(combo.trailingBufferMin, 10);
  assert.equal(combo.totalCents, 2000);
  const starts = startsFor(world({ candidates: [combo] }), ANA);
  assert.ok(starts.includes("11:15"), "11:15 + 105 = 13:00");
  assert.ok(!starts.includes("11:30"), "11:30 + 105 = 13:15 pisa el almuerzo");
  const slot = computeSlots(world({ candidates: [combo] }), EARLY)[0];
  assert.equal(slot.staff[0].durationMin, 105);
  assert.equal(slot.staff[0].totalCents, 2000);
});

test("margen mínimo: no se ofrece lo que ya pasó ni lo que está a menos del margen", () => {
  const now = at("10:07");
  assert.equal(startsFor(world(), ANA, { now, minLeadMin: 30 })[0], "10:45");
  assert.equal(startsFor(world(), ANA, { now, minLeadMin: 0 })[0], "10:15");
  // Un día que ya pasó no ofrece nada.
  assert.deepEqual(startsFor(world(), ANA, { now: at("09:00", "2026-10-27"), minLeadMin: 0 }), []);
});

test("cambio de día en la zona horaria: las 23:00 del lunes local son martes en UTC", () => {
  const late = world({
    location: { id: LOCATION, name: "Escazú", timezone: CR, active: true, hours: [{ weekday: 1, start: "20:00", end: "24:00" }] },
    staffHours: [{ staffId: ANA, locationId: LOCATION, weekday: 1, start: "20:00", end: "24:00" }],
    candidates: [candidate(ANA, [[60, 0]])],
  });
  const slots = computeSlots(late, EARLY);
  const last = slots.at(-1);
  assert.equal(hhmm(last!.startsAt), "23:00");
  assert.equal(last!.startsAt.toISOString(), "2026-10-27T05:00:00.000Z", "martes en UTC, lunes en Costa Rica");
  // Y el martes local (sin horario) no ofrece nada aunque en UTC todavía sea lunes de noche.
  const tuesday = localDayBounds("2026-10-27", CR);
  assert.deepEqual(computeSlots({ ...late, from: tuesday.start, to: tuesday.end }, EARLY), []);
});

test("horario de verano: el día del salto da 23 horas locales distintas", () => {
  const ny = "America/New_York";
  const day = "2026-03-08"; // domingo
  const bounds = localDayBounds(day, ny);
  const slots = computeSlots(
    {
      location: { id: LOCATION, name: "NY", timezone: ny, active: true, hours: [{ weekday: 0, start: "00:00", end: "24:00" }] },
      services: [],
      candidates: [candidate(ANA, [[30, 0]])],
      staffHours: [{ staffId: ANA, locationId: LOCATION, weekday: 0, start: "00:00", end: "24:00" }],
      timeOff: [],
      busy: [],
      from: bounds.start,
      to: bounds.end,
    },
    { now: new Date("2026-03-01T00:00:00Z"), minLeadMin: 0, intervalMin: 60 },
  );
  assert.equal(slots.length, 23);
  assert.equal(new Set(slots.map((s) => s.startsAt.getTime())).size, 23);
});

test("checkStart: dice por qué no se puede", () => {
  const w = world({ busy: [{ appointmentId: "x", staffId: ANA, startsAt: at("10:00"), endsAt: at("11:10") }] });
  assert.equal(checkStart(w, ANA, at("09:00"), EARLY), "busy");
  assert.equal(checkStart(w, ANA, at("09:00"), { ...EARLY, ignoreBusy: true }), null);
  assert.equal(checkStart(w, ANA, at("13:15"), EARLY), "outside_hours");
  assert.equal(checkStart(w, ANA, at("13:15"), { ...EARLY, ignoreHours: true }), null);
  assert.equal(checkStart(w, BETO, at("09:00"), EARLY), "outside_hours");
  assert.equal(checkStart(w, "cccccccc-cccc-4ccc-8ccc-cccccccccccc", at("15:00"), EARLY), "staff_unavailable");
  assert.equal(checkStart(w, ANA, at("14:00"), { now: at("13:50"), minLeadMin: 30 }), "too_soon");
  assert.equal(checkStart(w, ANA, at("14:00"), { now: at("15:00"), minLeadMin: 0, allowPast: true }), null);
  // Fuera de la grilla también vale (el equipo puede cargar 10:50 a mano).
  assert.equal(checkStart(world(), ANA, at("11:50"), EARLY), null);
});

test("sucursal desactivada o sin candidatos: sin horarios", () => {
  assert.deepEqual(computeSlots(world({ location: { ...world().location, active: false } }), EARLY), []);
  assert.deepEqual(computeSlots(world({ candidates: [] }), EARLY), []);
});
