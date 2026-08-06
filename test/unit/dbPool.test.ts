import assert from "node:assert/strict";
import { test } from "node:test";
import { _resetPoolParaTests, crearDb, obtenerDb } from "../../src/db/client";

// ROADMAP F7: `obtenerDb()` debe ser el ÚNICO pool de Postgres por proceso —
// si cada módulo abriera el suyo (como pasaba antes) el número de conexiones
// se multiplica por cada call site y, al separar web/worker (F6), por cada
// réplica, hasta reventar el límite del pooler de Supabase.
//
// No se abre conexión real: postgres.js es un driver "lazy" (conecta recién
// en el primer query), así que construir el pool con una URL falsa alcanza
// para probar la identidad de las instancias sin depender de una DB viva.
const URL_FALSA = "postgres://usuario:clave@localhost:5432/prueba";

test("obtenerDb(): dos llamadas devuelven la MISMA instancia (singleton por proceso)", () => {
  const original = process.env.DATABASE_URL;
  process.env.DATABASE_URL = URL_FALSA;
  _resetPoolParaTests();
  try {
    const a = obtenerDb();
    const b = obtenerDb();
    assert.equal(a, b);
  } finally {
    _resetPoolParaTests();
    process.env.DATABASE_URL = original;
  }
});

test("crearDb(url): cada llamada devuelve un pool NUEVO, distinto del singleton", () => {
  const original = process.env.DATABASE_URL;
  process.env.DATABASE_URL = URL_FALSA;
  _resetPoolParaTests();
  try {
    const singleton = obtenerDb();
    const nuevo1 = crearDb(URL_FALSA);
    const nuevo2 = crearDb(URL_FALSA);
    assert.notEqual(nuevo1, singleton);
    assert.notEqual(nuevo1, nuevo2); // dos llamadas a crearDb tampoco comparten instancia entre sí
  } finally {
    _resetPoolParaTests();
    process.env.DATABASE_URL = original;
  }
});

test("obtenerDb(): sin DATABASE_URL lanza el mismo error claro que crearDb()", () => {
  const original = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  _resetPoolParaTests();
  try {
    assert.throws(() => obtenerDb(), /Falta DATABASE_URL/);
  } finally {
    _resetPoolParaTests();
    process.env.DATABASE_URL = original;
  }
});

test("_resetPoolParaTests(): tras resetear, obtenerDb() abre un pool distinto al anterior", () => {
  const original = process.env.DATABASE_URL;
  process.env.DATABASE_URL = URL_FALSA;
  _resetPoolParaTests();
  try {
    const antes = obtenerDb();
    _resetPoolParaTests();
    const despues = obtenerDb();
    assert.notEqual(antes, despues);
  } finally {
    _resetPoolParaTests();
    process.env.DATABASE_URL = original;
  }
});
