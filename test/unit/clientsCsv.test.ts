import assert from "node:assert/strict";
import { test } from "node:test";
import { formatCustomFieldValue, parseCustomFieldText, parseDateText } from "../../src/modules/business";
import { CSV_BOM, csvCell, csvLine, CsvError, detectDelimiter, parseCsv } from "../../src/modules/clients/csv";

// ─────────────────────────────────────────────────────────────────────────────
// CSV propio de clientes (src/modules/clients/csv.ts, sin dependencias): comillas, BOM,
// separadores, saltos de línea, topes y el escape de fórmulas al exportar; y el texto de
// los campos personalizados (importar y exportar).
// ─────────────────────────────────────────────────────────────────────────────

test("parser: comillas con separador, comillas dobladas y saltos de línea adentro", () => {
  const { rows, lines, delimiter } = parseCsv('Nombre,Notas\r\n"Fernández, María","Dijo ""hola""\ny se fue"\r\nLuis,sin comillas\r\n');
  assert.equal(delimiter, ",");
  assert.deepEqual(rows, [
    ["Nombre", "Notas"],
    ["Fernández, María", 'Dijo "hola"\ny se fue'],
    ["Luis", "sin comillas"],
  ]);
  assert.deepEqual(lines, [1, 2, 4], "la fila de Luis empieza en la línea 4 (la nota ocupa dos)");
});

test("parser: BOM, separador ; o tabulador detectado, CR suelto, filas vacías y última sin salto", () => {
  const semi = parseCsv(`${CSV_BOM}Nombre;Teléfono\n\nAna;8888 7777\r\n;\nBeto;"6000;0000"`);
  assert.equal(semi.delimiter, ";");
  assert.deepEqual(semi.rows, [
    ["Nombre", "Teléfono"],
    ["Ana", "8888 7777"],
    ["Beto", "6000;0000"],
  ]);
  assert.equal(semi.rows[0][0], "Nombre", "el BOM no queda pegado al primer encabezado");

  const tabs = parseCsv("a\tb\rc\td");
  assert.equal(tabs.delimiter, "\t");
  assert.deepEqual(tabs.rows, [
    ["a", "b"],
    ["c", "d"],
  ]);
  assert.equal(detectDelimiter('"x;y",z,w\n1;2;3;4;5'), ",", "solo cuenta la primera línea y fuera de comillas");
});

test("parser: comilla sin cerrar y topes de filas, columnas y largo → CsvError", () => {
  assert.throws(() => parseCsv('a,b\n"sin cerrar,1\n'), CsvError);
  assert.throws(() => parseCsv("a\n1\n2\n3", { maxRows: 3 }), /demasiadas filas/);
  assert.throws(() => parseCsv("a,b,c", { maxColumns: 2 }), /demasiadas columnas/);
  assert.throws(() => parseCsv(`a\n${"x".repeat(20)}`, { maxCellLength: 10 }), /demasiado largo/);
});

test("escritura: comillas solo donde hacen falta, CRLF, y sin fórmulas (inyección CSV)", () => {
  assert.equal(csvLine(["Ana", 'Dice "hola"', "a,b", null, 3]), 'Ana,"Dice ""hola""","a,b",,3\r\n');
  assert.equal(csvCell("=HYPERLINK(\"http://x\")"), `"'=HYPERLINK(""http://x"")"`);
  assert.equal(csvCell("@SUM(A1)"), "'@SUM(A1)");
  assert.equal(csvCell("+cmd|' /C calc'!A0"), "'+cmd|' /C calc'!A0");
  assert.equal(csvCell("-2+3"), "'-2+3");
  assert.equal(csvCell("+50688887777"), "+50688887777", "un teléfono E.164 queda como está");
  assert.equal(csvCell("-1500.50"), "-1500.50", "un número negativo también");
  // Ida y vuelta: lo que se escribe se vuelve a leer igual.
  const text = csvLine(["Nombre", "Notas"]) + csvLine(["Fernández, María", 'línea 1\nlínea "2"']);
  assert.deepEqual(parseCsv(text).rows[1], ["Fernández, María", 'línea 1\nlínea "2"']);
});

test("campos personalizados desde el texto de una celda (importación) y hacia el CSV", () => {
  const select = { type: "select" as const, options: ["Seca", "Grasa", "Mixta"] };
  const multi = { type: "multi_select" as const, options: ["Cuadrada", "Redonda", "Almendra"] };
  assert.deepEqual(parseCustomFieldText(select, " grasa "), { ok: true, value: "Grasa" }, "sin distinguir mayúsculas");
  assert.equal(parseCustomFieldText(select, "Normal").ok, false);
  assert.deepEqual(parseCustomFieldText(multi, "almendra; Cuadrada"), { ok: true, value: ["Cuadrada", "Almendra"] }, "en el orden de las opciones");
  assert.deepEqual(parseCustomFieldText({ type: "number", options: [] }, "1.234,5"), { ok: true, value: 1234.5 });
  assert.deepEqual(parseCustomFieldText({ type: "number", options: [] }, "1,234.5"), { ok: true, value: 1234.5 });
  assert.equal(parseCustomFieldText({ type: "number", options: [] }, "doce").ok, false);
  assert.deepEqual(parseCustomFieldText({ type: "boolean", options: [] }, "Sí"), { ok: true, value: true });
  assert.deepEqual(parseCustomFieldText({ type: "boolean", options: [] }, "no"), { ok: true, value: false });
  assert.equal(parseCustomFieldText({ type: "boolean", options: [] }, "tal vez").ok, false);
  assert.deepEqual(parseCustomFieldText({ type: "date", options: [] }, "17/05/1990"), { ok: true, value: "1990-05-17" });
  assert.equal(parseCustomFieldText({ type: "date", options: [] }, "31/02/2020").ok, false, "día inexistente");
  assert.deepEqual(parseCustomFieldText({ type: "text", options: [] }, "  "), { ok: true, value: undefined }, "vacío = sin dato");
  assert.equal(parseDateText("2026-10-22"), "2026-10-22");

  assert.equal(formatCustomFieldValue({ type: "boolean" }, true), "Sí");
  assert.equal(formatCustomFieldValue({ type: "multi_select" }, ["Cuadrada", "Almendra"]), "Cuadrada; Almendra");
  assert.equal(formatCustomFieldValue({ type: "number" }, "texto viejo"), "texto viejo", "un valor de una definición vieja sale tal cual");
  assert.equal(formatCustomFieldValue({ type: "text" }, undefined), "");
});
