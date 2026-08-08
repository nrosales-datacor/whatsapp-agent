import { test } from "node:test";
import assert from "node:assert/strict";
import { crearDbEfimera } from "../helpers/pgliteDb";
import { intentarLiderazgo } from "../../src/red/liderazgo";

// ─────────────────────────────────────────────────────────────────────────────
// Ángulo 5 (TESTING.md) — lease de liderazgo (ROADMAP F6) contra Postgres
// efímero (PGlite). Prueba el SQL real de `intentarLiderazgo`
// (INSERT ... ON CONFLICT ... WHERE ... RETURNING), no una reimplementación en
// memoria: dos titulares "compitiendo" al mismo tiempo, renovación del titular
// vigente, y toma del lease tras vencer.
// ─────────────────────────────────────────────────────────────────────────────

const NOMBRE = "scheduler-test";

/** Espera `ms` milisegundos sin bloquear el loop de eventos. */
function esperar(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("dos titulares intentando adquirir el mismo lease a la vez: solo uno gana", async () => {
  const { db, cerrar } = await crearDbEfimera();
  try {
    const [a, b] = await Promise.all([
      intentarLiderazgo(db, NOMBRE, "titular-a", 60_000),
      intentarLiderazgo(db, NOMBRE, "titular-b", 60_000),
    ]);
    // Exactamente uno de los dos debe haber ganado (PGlite es de una sola
    // conexión: en la práctica se serializan, pero el invariante que importa —
    // que nunca gane más de uno— lo garantiza el WHERE de la sentencia, no el
    // orden de llegada).
    assert.equal([a, b].filter(Boolean).length, 1, "exactamente un titular debe ganar el lease");
  } finally {
    await cerrar();
  }
});

test("el titular vigente puede renovar su propio lease (no lo pierde por reintentar)", async () => {
  const { db, cerrar } = await crearDbEfimera();
  try {
    assert.equal(await intentarLiderazgo(db, NOMBRE, "titular-a", 60_000), true, "primer intento: adquiere");
    assert.equal(await intentarLiderazgo(db, NOMBRE, "titular-a", 60_000), true, "mismo titular: renueva");
    // Mientras el lease de "titular-a" sigue vigente, otro titular no puede tomarlo.
    assert.equal(await intentarLiderazgo(db, NOMBRE, "titular-b", 60_000), false, "otro titular no puede robar un lease vigente");
  } finally {
    await cerrar();
  }
});

test("si el lease vence, otro titular puede tomarlo", async () => {
  const { db, cerrar } = await crearDbEfimera();
  try {
    assert.equal(await intentarLiderazgo(db, NOMBRE, "titular-a", 20), true, "titular-a adquiere con un lease bien corto");
    assert.equal(await intentarLiderazgo(db, NOMBRE, "titular-b", 60_000), false, "todavía no venció: titular-b no puede tomarlo");

    await esperar(40); // más que el lease de 20 ms de titular-a: ya venció

    assert.equal(await intentarLiderazgo(db, NOMBRE, "titular-b", 60_000), true, "venció: titular-b lo toma");
    assert.equal(await intentarLiderazgo(db, NOMBRE, "titular-a", 60_000), false, "titular-a ya no es el titular");
  } finally {
    await cerrar();
  }
});

test("leases de nombres distintos no interfieren entre sí (keyed por nombre)", async () => {
  const { db, cerrar } = await crearDbEfimera();
  try {
    const [recordatorios, reputacion] = await Promise.all([
      intentarLiderazgo(db, "recordatorios", "titular-a", 60_000),
      intentarLiderazgo(db, "reputacion", "titular-b", 60_000),
    ]);
    assert.equal(recordatorios, true, "cada scheduler tiene su propio lease");
    assert.equal(reputacion, true);
  } finally {
    await cerrar();
  }
});

test("sin DB (modo memoria): siempre gana, no hay nada que coordinar", async () => {
  assert.equal(await intentarLiderazgo(null, NOMBRE, "el-unico-proceso", 60_000), true);
  assert.equal(await intentarLiderazgo(null, NOMBRE, "otro-proceso", 60_000), true, "sin DB no hay tabla ni conflicto posible");
});
