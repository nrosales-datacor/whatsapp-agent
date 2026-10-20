import assert from "node:assert/strict";
import { test } from "node:test";
import { _resetPoolForTests, createDb, getDb } from "../../src/platform/db/client";

// `getDb()` debe ser el ÚNICO pool de Postgres por proceso — si cada módulo abriera el
// suyo, el número de conexiones se multiplica por cada call site y, con varias réplicas
// web/worker, por cada réplica, hasta reventar el límite del pooler de Supabase.
//
// No se abre conexión real: postgres.js es un driver "lazy" (conecta recién en la primera
// query), así que construir el pool con una URL falsa alcanza para probar la identidad de
// las instancias sin depender de una base viva.
const FAKE_URL = "postgres://usuario:clave@localhost:5432/prueba";

function withDatabaseUrl(url: string | undefined, fn: () => void): void {
  const original = process.env.DATABASE_URL;
  if (url === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = url;
  _resetPoolForTests();
  try {
    fn();
  } finally {
    _resetPoolForTests();
    if (original === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = original;
  }
}

test("getDb(): dos llamadas devuelven la MISMA instancia (singleton por proceso)", () => {
  withDatabaseUrl(FAKE_URL, () => {
    assert.equal(getDb(), getDb());
  });
});

test("createDb(url): cada llamada devuelve un pool NUEVO, distinto del singleton", () => {
  withDatabaseUrl(FAKE_URL, () => {
    const singleton = getDb();
    const first = createDb(FAKE_URL);
    const second = createDb(FAKE_URL);
    assert.notEqual(first, singleton);
    assert.notEqual(first, second); // dos llamadas a createDb tampoco comparten instancia entre sí
  });
});

test("getDb(): sin DATABASE_URL lanza el mismo error claro que createDb()", () => {
  withDatabaseUrl(undefined, () => {
    assert.throws(() => getDb(), /Falta DATABASE_URL/);
  });
});

test("_resetPoolForTests(): tras resetear, getDb() abre un pool distinto al anterior", () => {
  withDatabaseUrl(FAKE_URL, () => {
    const before = getDb();
    _resetPoolForTests();
    assert.notEqual(before, getDb());
  });
});
