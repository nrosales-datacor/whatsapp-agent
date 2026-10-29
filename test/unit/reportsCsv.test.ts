import assert from "node:assert/strict";
import { test } from "node:test";
import { csvCell, csvFileName, money, percent, reportToCsv, toCsv, type ServicesReport } from "../../src/modules/reports";

// ─────────────────────────────────────────────────────────────────────────────
// Exportación CSV de Reportes (I5): escape RFC 4180, BOM y CRLF, fórmulas neutralizadas
// (inyección en planillas) sin tocar los números, montos y porcentajes, nombre del archivo
// y las columnas de un reporte.
// ─────────────────────────────────────────────────────────────────────────────

test("csv: comillas, comas y saltos de línea van entre comillas (las comillas se duplican)", () => {
  assert.equal(csvCell("Limpieza"), "Limpieza");
  assert.equal(csvCell("Mani, pedi"), '"Mani, pedi"');
  assert.equal(csvCell('La "Dra." Ruiz'), '"La ""Dra."" Ruiz"');
  assert.equal(csvCell("dos\nlíneas"), '"dos\nlíneas"');
  assert.equal(csvCell(null), "");
  assert.equal(csvCell(undefined), "");
  assert.equal(csvCell(Number.NaN), "");
});

test("csv: un texto que empieza como fórmula se neutraliza; los números (también en texto) no", () => {
  assert.equal(csvCell("=HYPERLINK(\"http://x\")"), `"'=HYPERLINK(""http://x"")"`);
  assert.equal(csvCell("+50688887777"), "'+50688887777");
  assert.equal(csvCell("-algo"), "'-algo");
  assert.equal(csvCell("@SUMA(A1)"), "'@SUMA(A1)");
  assert.equal(csvCell("\tx"), "'\tx");
  assert.equal(csvCell(-1500), "-1500");
  assert.equal(csvCell("-15.00"), "-15.00");
  assert.equal(csvCell(0), "0");
});

test("csv: documento con BOM, CRLF y una línea final; montos y porcentajes", () => {
  const doc = toCsv(["Servicio", "Monto"], [["A", money(250000)], ["B, C", money(-5050)]]);
  assert.equal(doc, '﻿Servicio,Monto\r\nA,2500.00\r\n"B, C",-50.50\r\n');
  assert.equal(percent(0.375), "37.5");
  assert.equal(percent(1 / 3), "33.3");
  assert.equal(percent(null), "");
  assert.equal(csvFileName("staff", "2026-10-01", "2026-10-30"), "reporte-profesionales_2026-10-01_2026-10-30.csv");
});

test("csv de un reporte: encabezados con la moneda y una fila por ítem", () => {
  const report: ServicesReport = {
    range: { from: "2026-10-01", to: "2026-10-30", days: 30, timezone: "America/Costa_Rica", locationId: null, previous: { from: "2026-09-01", to: "2026-09-30" } },
    currency: "CRC",
    generatedAt: "2026-10-30T12:00:00.000Z",
    items: [
      { serviceId: null, name: "=Promo", scheduled: 3, completed: 2, completedValueCents: 1_000_000, collectedNetCents: 900_050 },
    ],
    totals: { scheduled: 3, completed: 2, completedValueCents: 1_000_000, collectedNetCents: 900_050 },
    looseCollectedNetCents: 0,
  };
  const lines = reportToCsv("services", report).replace(/^﻿/, "").trimEnd().split("\r\n");
  assert.deepEqual(lines, ["Servicio,Agendados,Realizados,Valor realizado (CRC),Cobrado neto (CRC)", "'=Promo,3,2,10000.00,9000.50"]);
});
