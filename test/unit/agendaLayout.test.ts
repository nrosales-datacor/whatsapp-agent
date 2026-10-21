import assert from "node:assert/strict";
import { test } from "node:test";
import { addDays, gridRange, hhmm, layoutColumns, weekDates, workingWindows } from "../../web/src/modules/scheduling/agendaLayout";

// ─────────────────────────────────────────────────────────────────────────────
// Geometría de la Agenda del panel (web/src/modules/scheduling/agendaLayout.ts, sin
// imports a propósito para probarla desde acá): rango de la rejilla, ventanas de trabajo y
// columnas de citas que se pisan.
// ─────────────────────────────────────────────────────────────────────────────

const HOURS = [
  { weekday: 1, start: "09:00", end: "13:00" },
  { weekday: 1, start: "14:00", end: "19:30" },
];

test("rejilla: de la apertura al cierre redondeado a horas; se estira con las citas; cerrado = 8 a 18", () => {
  assert.deepEqual(gridRange(HOURS, 1), { startMin: 9 * 60, endMin: 20 * 60 });
  assert.deepEqual(gridRange(HOURS, 1, [{ startMin: 7 * 60 + 30, endMin: 8 * 60 + 30 }]), { startMin: 7 * 60, endMin: 20 * 60 });
  assert.deepEqual(gridRange(HOURS, 0), { startMin: 8 * 60, endMin: 18 * 60 });
  assert.deepEqual(gridRange([{ weekday: 1, start: "20:00", end: "24:00" }], 1), { startMin: 20 * 60, endMin: 24 * 60 });
});

test("ventanas de trabajo: horario del profesional ∩ horario de la sucursal", () => {
  const staff = [{ weekday: 1, start: "08:00", end: "15:00" }];
  assert.deepEqual(workingWindows(HOURS, staff, 1), [
    { startMin: 9 * 60, endMin: 13 * 60 },
    { startMin: 14 * 60, endMin: 15 * 60 },
  ]);
  assert.deepEqual(workingWindows(HOURS, staff, 2), []);
});

test("columnas: las citas que se pisan se reparten; las que no, usan todo el ancho", () => {
  const out = layoutColumns([
    { id: "a", startMin: 540, endMin: 600 },
    { id: "b", startMin: 570, endMin: 630 },
    { id: "c", startMin: 600, endMin: 660 },
    { id: "d", startMin: 700, endMin: 760 },
  ]);
  const by = Object.fromEntries(out.map((o) => [o.id, [o.column, o.columns]]));
  assert.deepEqual(by.a, [0, 2]);
  assert.deepEqual(by.b, [1, 2]);
  assert.deepEqual(by.c, [0, 2], "reusa la columna que dejó libre a");
  assert.deepEqual(by.d, [0, 1]);
});

test("fechas: semana de lunes a domingo y formato de horas", () => {
  assert.deepEqual(weekDates("2026-10-21"), ["2026-10-19", "2026-10-20", "2026-10-21", "2026-10-22", "2026-10-23", "2026-10-24", "2026-10-25"]);
  assert.equal(weekDates("2026-10-25")[0], "2026-10-19", "el domingo es el último día de su semana");
  assert.equal(addDays("2026-02-28", 1), "2026-03-01");
  assert.equal(hhmm(9 * 60 + 5), "09:05");
});
