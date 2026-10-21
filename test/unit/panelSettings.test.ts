import assert from "node:assert/strict";
import { test } from "node:test";
import { centsToInput, formatCents, parseAmountToCents } from "../../web/src/lib/money";
import {
  blocksFromDraft,
  draftFromBlocks,
  mapServerErrors,
  summarizeHours,
  validateDraft,
} from "../../web/src/modules/settings/hoursDraft";
import { addDays, formatRange, isoToZoned, zonedToIso } from "../../web/src/modules/settings/zonedTime";

// ─────────────────────────────────────────────────────────────────────────────
// Lógica pura de Configuración en el panel (web/src): montos en céntimos, el borrador del
// editor de horario (con las mismas reglas que el backend) y fechas en la zona del
// negocio. Sin DOM ni red.
// ─────────────────────────────────────────────────────────────────────────────

test("panel: lo que se escribe como precio pasa a céntimos exactos (o null si no es un monto)", () => {
  const cases: [string, number | null][] = [
    ["", 0],
    ["25000", 2_500_000],
    ["25 000", 2_500_000],
    ["25.000", 2_500_000],
    ["25,000", 2_500_000],
    ["1.234.567", 123_456_700],
    ["25.000,50", 2_500_050],
    ["25,000.50", 2_500_050],
    ["1500,5", 150_050],
    ["1500.05", 150_005],
    ["0,99", 99],
    ["-5", null],
    ["12a", null],
    ["25.000,505", null],
    ["1234567890123", null],
  ];
  for (const [input, expected] of cases) assert.equal(parseAmountToCents(input), expected, JSON.stringify(input));
  assert.equal(centsToInput(2_500_000), "25000");
  assert.equal(centsToInput(2_500_050), "25000,50");
  assert.equal(parseAmountToCents(centsToInput(1_234_505)), 1_234_505, "ida y vuelta");
  assert.equal(formatCents(2_500_000, "CRC"), "₡" + (25000).toLocaleString("es-CR"));
  assert.equal(formatCents(150_050, "USD"), "$1,500.50");
});

test("panel: borrador del horario ↔ tramos de la API (24:00 como fin 00:00)", () => {
  const draft = draftFromBlocks([
    { weekday: 1, start: "14:00", end: "18:00" },
    { weekday: 1, start: "09:00", end: "13:00" },
    { weekday: 6, start: "20:00", end: "24:00" },
  ]);
  assert.deepEqual(draft[1], [
    { start: "09:00", end: "13:00" },
    { start: "14:00", end: "18:00" },
  ]);
  assert.deepEqual(draft[6], [{ start: "20:00", end: "00:00" }]);
  const { blocks, index } = blocksFromDraft(draft);
  assert.deepEqual(blocks, [
    { weekday: 1, start: "09:00", end: "13:00" },
    { weekday: 1, start: "14:00", end: "18:00" },
    { weekday: 6, start: "20:00", end: "24:00" },
  ]);
  assert.deepEqual(index[2], { weekday: 6, i: 0 });
  // Los errores del servidor (`body.hours.<i>`) caen en el tramo del borrador que corresponde.
  assert.deepEqual(mapServerErrors({ "body.hours.1.start": "Se cruza", "body.name": "x" }, index), { "1.1": "Se cruza" });
  assert.deepEqual(validateDraft(draft), {});
});

test("panel: validación del borrador igual que el backend (fin, cruces, horas vacías)", () => {
  const draft = draftFromBlocks([]);
  draft[2] = [
    { start: "09:00", end: "13:00" },
    { start: "12:00", end: "15:00" },
  ];
  draft[3] = [{ start: "18:00", end: "09:00" }];
  draft[4] = [{ start: "", end: "10:00" }];
  draft[5] = [{ start: "22:00", end: "00:00" }]; // hasta la medianoche: válido
  const errors = validateDraft(draft);
  assert.match(errors["2.1"], /se cruza/);
  assert.match(errors["3.0"], /después/);
  assert.match(errors["4.0"], /Completá/);
  assert.equal(errors["5.0"], undefined);
});

test("panel: resumen del horario agrupa días seguidos con el mismo horario", () => {
  const hours = [
    ...[1, 2, 3, 4, 5].flatMap((weekday) => [
      { weekday, start: "09:00", end: "13:00" },
      { weekday, start: "14:00", end: "18:00" },
    ]),
    { weekday: 6, start: "08:00", end: "12:00" },
  ];
  assert.equal(summarizeHours(hours), "Lun–Vie 9:00–13:00, 14:00–18:00 · Sáb 8:00–12:00");
  assert.equal(summarizeHours([], "Cerrada"), "Cerrada");
  assert.equal(
    summarizeHours([
      { weekday: 1, start: "09:00", end: "12:00" },
      { weekday: 3, start: "09:00", end: "12:00" },
    ]),
    "Lun 9:00–12:00 · Mié 9:00–12:00",
    "días no seguidos no se agrupan",
  );
});

test("panel: fechas en la zona del negocio (no la del navegador)", () => {
  assert.equal(zonedToIso("2026-12-24", "00:00", "America/Costa_Rica"), "2026-12-24T06:00:00.000Z");
  assert.equal(zonedToIso("2026-07-01", "08:30", "America/Mexico_City"), "2026-07-01T14:30:00.000Z");
  assert.deepEqual(isoToZoned("2026-12-24T06:00:00.000Z", "America/Costa_Rica"), { date: "2026-12-24", time: "00:00" });
  assert.equal(addDays("2026-12-31", 1), "2027-01-01");
  assert.match(formatRange("2026-12-24T06:00:00.000Z", "2026-12-26T06:00:00.000Z", "America/Costa_Rica"), /24.*–.*25/);
  assert.match(formatRange("2026-12-25T06:00:00.000Z", "2026-12-26T06:00:00.000Z", "America/Costa_Rica"), /todo el día/);
});
