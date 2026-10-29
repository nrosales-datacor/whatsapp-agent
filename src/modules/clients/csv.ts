// ─────────────────────────────────────────────────────────────────────────────
// CSV propio (sin dependencias, CLAUDE.md "Política de dependencias") para importar y
// exportar clientes. RFC 4180 con lo que traen los archivos de verdad:
//
//   • BOM de UTF-8 al inicio (Excel lo agrega) → se ignora.
//   • Separador `,`, `;` (Excel en español) o tabulador: se detecta en la primera línea,
//     contando solo lo que está fuera de comillas.
//   • Campos entre comillas con el separador, saltos de línea o comillas dobladas (`""`).
//   • Fin de línea CRLF, LF o CR.
//
// Al exportar: UTF-8 con BOM (Excel abre bien las tildes), coma, CRLF, comillas solo donde
// hacen falta, y las celdas que una planilla interpretaría como fórmula (`=`, `@`, `+`/`-`
// que no son un número o teléfono) van con un apóstrofo adelante (inyección CSV).
// ─────────────────────────────────────────────────────────────────────────────

export type CsvDelimiter = "," | ";" | "\t";
const DELIMITERS: readonly CsvDelimiter[] = [",", ";", "\t"];

export interface ParsedCsv {
  delimiter: CsvDelimiter;
  rows: string[][];
  /** Línea del archivo en la que empieza cada fila (1 = la primera): lo que ve quien lo abre en una planilla. */
  lines: number[];
}

export class CsvError extends Error {}

/** Separador más probable: el que más aparece fuera de comillas en la primera línea (coma si empatan). */
export function detectDelimiter(text: string): CsvDelimiter {
  const counts = new Map<CsvDelimiter, number>(DELIMITERS.map((d) => [d, 0]));
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      if (inQuotes && text[i + 1] === '"') i++;
      else inQuotes = !inQuotes;
    } else if (!inQuotes && (ch === "\n" || ch === "\r")) break;
    else if (!inQuotes && counts.has(ch as CsvDelimiter)) counts.set(ch as CsvDelimiter, (counts.get(ch as CsvDelimiter) ?? 0) + 1);
  }
  let best: CsvDelimiter = ",";
  for (const d of DELIMITERS) if ((counts.get(d) ?? 0) > (counts.get(best) ?? 0)) best = d;
  return best;
}

/**
 * Parsea el texto completo. Las filas totalmente vacías se descartan. Lanza `CsvError`
 * si una comilla queda sin cerrar o si se pasa de los topes.
 */
export function parseCsv(input: string, options: { delimiter?: CsvDelimiter; maxRows?: number; maxColumns?: number; maxCellLength?: number } = {}): ParsedCsv {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const delimiter = options.delimiter ?? detectDelimiter(text);
  const maxRows = options.maxRows ?? Infinity;
  const maxColumns = options.maxColumns ?? 200;
  const maxCellLength = options.maxCellLength ?? 10_000;
  const rows: string[][] = [];
  const lines: number[] = [];
  let row: string[] = [];
  let rowLine = 1;
  let cell = "";
  let inQuotes = false;
  let quotedCell = false;
  let line = 1;

  const endCell = () => {
    if (cell.length > maxCellLength) throw new CsvError(`La fila ${line} tiene un valor demasiado largo (máximo ${maxCellLength} caracteres).`);
    row.push(cell);
    if (row.length > maxColumns) throw new CsvError(`El archivo tiene demasiadas columnas (máximo ${maxColumns}).`);
    cell = "";
    quotedCell = false;
  };
  const endRow = () => {
    endCell();
    if (row.some((c) => c.trim() !== "")) {
      rows.push(row);
      lines.push(rowLine);
      if (rows.length > maxRows) throw new CsvError(`El archivo tiene demasiadas filas (máximo ${maxRows - 1} sin contar los encabezados).`);
    }
    row = [];
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else inQuotes = false;
      } else {
        if (ch === "\n") line++;
        cell += ch;
      }
      continue;
    }
    if (ch === '"' && cell.trim() === "" && !quotedCell) {
      // Comilla al inicio del campo (se toleran espacios antes): campo entre comillas.
      cell = "";
      inQuotes = true;
      quotedCell = true;
    } else if (ch === delimiter) endCell();
    else if (ch === "\r" || ch === "\n") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      endRow();
      line++;
      rowLine = line;
    } else cell += ch;
  }
  if (inQuotes) throw new CsvError(`Hay una comilla sin cerrar (desde la fila ${line}).`);
  if (cell !== "" || row.length > 0) endRow();
  return { delimiter, rows, lines };
}

// ── Escritura ───────────────────────────────────────────────────────────────

export const CSV_BOM = "﻿";
const NUMBER_LIKE = /^[+-]?[\d\s().,-]+$/;

/** Una celda lista para el CSV (con comillas si hace falta y sin riesgo de fórmula). */
export function csvCell(value: unknown): string {
  let text = value === null || value === undefined ? "" : String(value);
  const first = text.charAt(0);
  if (first === "=" || first === "@" || first === "\t" || first === "\r" || ((first === "+" || first === "-") && !NUMBER_LIKE.test(text))) {
    text = `'${text}`;
  }
  return /[",;\r\n\t]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** Una línea del CSV (con CRLF). */
export function csvLine(values: readonly unknown[]): string {
  return `${values.map(csvCell).join(",")}\r\n`;
}
