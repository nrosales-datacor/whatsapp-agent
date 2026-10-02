import assert from "node:assert/strict";
import { test } from "node:test";
import { dumpCompleto, elegirBackupsAPodar } from "../../src/db/backups";

// Revisión pre-venta 2026-10 (G8): la poda nunca deja cero respaldos y un dump
// truncado no se da por bueno.

const DIA = 86_400_000;
const ahora = Date.UTC(2026, 9, 1);
const archivo = (diasAtras: number) => ({ nombre: `wa_bot_${diasAtras}.sql.gz`, mtimeMs: ahora - diasAtras * DIA });

test("elegirBackupsAPodar: borra solo los más viejos que la retención", () => {
  const archivos = [0, 1, 2, 15, 20].map(archivo);
  assert.deepEqual(elegirBackupsAPodar(archivos, ahora, 14, 3).sort(), ["wa_bot_15.sql.gz", "wa_bot_20.sql.gz"]);
});

test("elegirBackupsAPodar: aunque todos sean viejos, conserva los N más recientes", () => {
  const archivos = [30, 31, 32, 40, 50].map(archivo);
  assert.deepEqual(elegirBackupsAPodar(archivos, ahora, 14, 3).sort(), ["wa_bot_40.sql.gz", "wa_bot_50.sql.gz"]);
});

test("elegirBackupsAPodar: con menos archivos que el mínimo no borra nada", () => {
  assert.deepEqual(elegirBackupsAPodar([archivo(90), archivo(100)], ahora, 14, 3), []);
});

test("dumpCompleto: exige la marca de cierre de pg_dump", () => {
  assert.equal(dumpCompleto("...\n--\n-- PostgreSQL database dump complete\n--\n"), true);
  assert.equal(dumpCompleto("COPY public.wa_mensajes (id, ...) FROM stdin;\n1\tho"), false);
});
