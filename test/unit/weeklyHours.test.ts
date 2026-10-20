import assert from "node:assert/strict";
import { test } from "node:test";
import { minutesOfDay, overlappingBlocks, sortBlocks, WeeklyHoursSchema } from "../../src/modules/business";
import { validateInput } from "../../src/platform/http/validation";

// ─────────────────────────────────────────────────────────────────────────────
// Reglas del horario semanal (src/modules/business/hours.ts), compartidas por el horario
// de las sucursales y el de los profesionales: rango, cruces, tramos por día y formato.
// ─────────────────────────────────────────────────────────────────────────────

const check = (hours: unknown) => validateInput(WeeklyHoursSchema, hours, "body");

test("horario: turnos partidos el mismo día (descanso) y tramos pegados son válidos", async () => {
  const r = await check([
    { weekday: 1, start: "09:00", end: "12:00" },
    { weekday: 1, start: "13:00", end: "18:00" },
    { weekday: 2, start: "08:00", end: "12:00" },
    { weekday: 2, start: "12:00", end: "16:00" },
    { weekday: 6, start: "18:00", end: "24:00" },
  ]);
  assert.equal(r.ok, true, JSON.stringify(r));
});

test("horario: fin antes del inicio, cruces y formato inválido se marcan en el tramo exacto", async () => {
  const r = await check([
    { weekday: 1, start: "09:00", end: "12:00" },
    { weekday: 1, start: "11:30", end: "14:00" }, // se cruza con el anterior
    { weekday: 2, start: "15:00", end: "10:00" }, // fin antes del inicio
    { weekday: 3, start: "9:00", end: "12:00" }, // formato
    { weekday: 7, start: "09:00", end: "10:00" }, // día inválido
    { weekday: 4, start: "24:00", end: "24:00" }, // "24:00" solo como fin
  ]);
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.match(r.fields["body.1.start"], /se cruza/);
  assert.match(r.fields["body.2.end"], /después/);
  assert.match(r.fields["body.3.start"], /HH:MM/);
  assert.ok(r.fields["body.4.weekday"]);
  assert.ok(r.fields["body.5.start"]);
});

test("horario: un tramo con tipos raros da 400 por campo, no un error interno", async () => {
  const r = await check([{ weekday: 1, start: 900, end: null }, null, { weekday: 1, start: "09:00", end: "10:00" }]);
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.ok(r.fields["body.0.start"]);
  assert.ok(r.fields["body.0.end"]);
  assert.ok(r.fields["body.1"]);
});

test("horario: como máximo 6 tramos por día", async () => {
  const blocks = Array.from({ length: 7 }, (_, i) => ({ weekday: 3, start: `${String(8 + i).padStart(2, "0")}:00`, end: `${String(8 + i).padStart(2, "0")}:30` }));
  const r = await check(blocks);
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.fields["body.6.start"], /Máximo 6/);
});

test("horario: utilidades (minutos, orden canónico y cruces entre dos horarios)", () => {
  assert.equal(minutesOfDay("09:30"), 570);
  assert.equal(minutesOfDay("18:15:00"), 1095);
  assert.equal(minutesOfDay("24:00"), 1440);
  const sorted = sortBlocks([
    { weekday: 2, start: "10:00", end: "11:00" },
    { weekday: 1, start: "14:00", end: "15:00" },
    { weekday: 1, start: "09:00", end: "10:00" },
  ]);
  assert.deepEqual(
    sorted.map((b) => `${b.weekday} ${b.start}`),
    ["1 09:00", "1 14:00", "2 10:00"],
  );
  const a = [
    { weekday: 1, start: "09:00", end: "12:00" },
    { weekday: 2, start: "09:00", end: "12:00" },
    { weekday: 3, start: "12:00", end: "14:00" },
  ];
  const b = [
    { weekday: 1, start: "11:00", end: "13:00" }, // choca con a[0]
    { weekday: 3, start: "09:00", end: "12:00" }, // pegado a a[2]: no choca
  ];
  assert.deepEqual(overlappingBlocks(a, b), [0]);
});
