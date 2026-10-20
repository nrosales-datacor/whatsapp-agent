import { test } from "node:test";
import assert from "node:assert/strict";
import { createEphemeralDb } from "../helpers/pgliteDb";
import { startLeaderLoop, tryAcquireLease } from "../../src/platform/net/leaderLease";

// ─────────────────────────────────────────────────────────────────────────────
// Lease de liderazgo contra Postgres efímero (PGlite). Prueba el SQL real de
// `tryAcquireLease` (INSERT … ON CONFLICT … WHERE … RETURNING), no una reimplementación
// en memoria: dos titulares "compitiendo" al mismo tiempo, renovación del titular
// vigente, toma del lease tras vencer, y que `startLeaderLoop` solo corra el tick con el
// lease.
// ─────────────────────────────────────────────────────────────────────────────

const NAME = "scheduler-test";

/** Espera `ms` milisegundos sin bloquear el loop de eventos. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("dos titulares intentando adquirir el mismo lease a la vez: solo uno gana", async () => {
  const { db, close } = await createEphemeralDb();
  try {
    const [a, b] = await Promise.all([
      tryAcquireLease(db, NAME, "holder-a", 60_000),
      tryAcquireLease(db, NAME, "holder-b", 60_000),
    ]);
    // Exactamente uno de los dos gana (PGlite es de una sola conexión: en la práctica se
    // serializan, pero el invariante que importa —que nunca gane más de uno— lo garantiza
    // el WHERE de la sentencia, no el orden de llegada).
    assert.equal([a, b].filter(Boolean).length, 1, "exactamente un titular debe ganar el lease");
  } finally {
    await close();
  }
});

test("el titular vigente puede renovar su propio lease (no lo pierde por reintentar)", async () => {
  const { db, close } = await createEphemeralDb();
  try {
    assert.equal(await tryAcquireLease(db, NAME, "holder-a", 60_000), true, "primer intento: adquiere");
    assert.equal(await tryAcquireLease(db, NAME, "holder-a", 60_000), true, "mismo titular: renueva");
    // Mientras el lease de "holder-a" sigue vigente, otro titular no puede tomarlo.
    assert.equal(await tryAcquireLease(db, NAME, "holder-b", 60_000), false, "otro titular no puede robar un lease vigente");
  } finally {
    await close();
  }
});

test("si el lease vence, otro titular puede tomarlo", async () => {
  const { db, close } = await createEphemeralDb();
  try {
    // Lease de 500 ms (no 20 ms): bajo carga completa de la suite, un margen de
    // milisegundos entre dos awaits es demasiado angosto y el lease podría vencer ANTES
    // de la siguiente aserción.
    assert.equal(await tryAcquireLease(db, NAME, "holder-a", 500), true, "holder-a adquiere con un lease corto");
    assert.equal(await tryAcquireLease(db, NAME, "holder-b", 60_000), false, "todavía no venció: holder-b no puede tomarlo");

    await sleep(700); // más que el lease de 500 ms de holder-a: ya venció

    assert.equal(await tryAcquireLease(db, NAME, "holder-b", 60_000), true, "venció: holder-b lo toma");
    assert.equal(await tryAcquireLease(db, NAME, "holder-a", 60_000), false, "holder-a ya no es el titular");
  } finally {
    await close();
  }
});

test("leases de nombres distintos no interfieren entre sí (keyed por nombre)", async () => {
  const { db, close } = await createEphemeralDb();
  try {
    const [reminders, metrics] = await Promise.all([
      tryAcquireLease(db, "reminders", "holder-a", 60_000),
      tryAcquireLease(db, "metrics", "holder-b", 60_000),
    ]);
    assert.equal(reminders, true, "cada scheduler tiene su propio lease");
    assert.equal(metrics, true);
  } finally {
    await close();
  }
});

test("sin base: siempre gana, no hay nada que coordinar", async () => {
  assert.equal(await tryAcquireLease(null, NAME, "the-only-process", 60_000), true);
  assert.equal(await tryAcquireLease(null, NAME, "another-process", 60_000), true);
});

test("startLeaderLoop: si otro proceso tiene el lease, el tick no corre", async () => {
  const { db, close } = await createEphemeralDb();
  try {
    // Otro proceso tomó el lease "metrics-test" por un buen rato.
    assert.equal(await tryAcquireLease(db, "metrics-test", "otro-proceso", 60_000), true);
    let ticks = 0;
    let attempts = 0;
    await new Promise<void>((resolve) => {
      const loop = startLeaderLoop({
        db,
        label: "metrics-test",
        intervalMs: 5,
        scalingHint: "",
        onError: () => {},
        tick: async () => {
          ticks++;
        },
      });
      // Se deja correr varios ciclos y se corta.
      const check = setInterval(() => {
        if (++attempts >= 10) {
          clearInterval(check);
          loop.stop();
          resolve();
        }
      }, 20);
    });
    assert.equal(ticks, 0, "sin el lease, este proceso no hace el trabajo del tick");
  } finally {
    await close();
  }
});

test("startLeaderLoop: con el lease libre, este proceso lo toma y corre el tick", async () => {
  const { db, close } = await createEphemeralDb();
  try {
    await new Promise<void>((resolve) => {
      const loop = startLeaderLoop({
        db,
        label: "leader-free-test",
        intervalMs: 5,
        scalingHint: "",
        onError: () => {},
        tick: async () => {
          loop.stop();
          resolve();
        },
      });
    });
    // El lease quedó a nombre de este proceso: otro titular no lo puede tomar.
    assert.equal(await tryAcquireLease(db, "leader-free-test", "otro-proceso", 60_000), false);
  } finally {
    await close();
  }
});
