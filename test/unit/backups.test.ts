import assert from "node:assert/strict";
import { test } from "node:test";
import { isDumpComplete, selectBackupsToPrune } from "../../src/platform/db/backups";

// La poda nunca deja cero respaldos y un dump truncado no se da por bueno.

const DAY = 86_400_000;
const now = Date.UTC(2026, 9, 1);
const file = (daysAgo: number) => ({ name: `db_${daysAgo}.sql.gz`, mtimeMs: now - daysAgo * DAY });

test("selectBackupsToPrune: borra solo los más viejos que la retención", () => {
  const files = [0, 1, 2, 15, 20].map(file);
  assert.deepEqual(selectBackupsToPrune(files, now, 14, 3).sort(), ["db_15.sql.gz", "db_20.sql.gz"]);
});

test("selectBackupsToPrune: aunque todos sean viejos, conserva los N más recientes", () => {
  const files = [30, 31, 32, 40, 50].map(file);
  assert.deepEqual(selectBackupsToPrune(files, now, 14, 3).sort(), ["db_40.sql.gz", "db_50.sql.gz"]);
});

test("selectBackupsToPrune: con menos archivos que el mínimo no borra nada", () => {
  assert.deepEqual(selectBackupsToPrune([file(90), file(100)], now, 14, 3), []);
});

test("isDumpComplete: exige la marca de cierre de pg_dump", () => {
  assert.equal(isDumpComplete("...\n--\n-- PostgreSQL database dump complete\n--\n"), true);
  assert.equal(isDumpComplete("COPY public.audit_log (id, ...) FROM stdin;\n1\tho"), false);
});
