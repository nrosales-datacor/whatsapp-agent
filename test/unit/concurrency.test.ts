import assert from "node:assert/strict";
import { test } from "node:test";
import { mapWithLimit } from "../../src/platform/net/concurrency";

/** Espera `ms` milisegundos sin bloquear el loop de eventos. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("mapWithLimit: nunca supera el límite de ejecuciones simultáneas", async () => {
  const items = Array.from({ length: 12 }, (_, i) => i);
  let inFlight = 0;
  let maxInFlight = 0;

  await mapWithLimit(items, 3, async (item) => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    // Duración variable: si el helper no respetara el límite, ítems más rápidos dejarían
    // pasar de más antes de que los lentos terminen.
    await sleep(5 + (item % 3) * 3);
    inFlight--;
    return item;
  });

  assert.ok(maxInFlight <= 3, `maxInFlight fue ${maxInFlight}, esperado <= 3`);
});

test("mapWithLimit: preserva el orden de los resultados aunque terminen en otro orden", async () => {
  const items = [1, 2, 3, 4, 5];
  // Los ítems más grandes tardan MENOS: si no se preservara el orden, el resultado
  // saldría con los rápidos primero.
  const results = await mapWithLimit(items, 2, async (item) => {
    await sleep((6 - item) * 5);
    return item * 10;
  });

  assert.deepEqual(results, [10, 20, 30, 40, 50]);
});

test("mapWithLimit: un ítem que falla no frena a los demás (se procesan todos)", async () => {
  const items = [1, 2, 3, 4, 5];
  const processed: number[] = [];

  await assert.rejects(
    mapWithLimit(items, 2, async (item) => {
      await sleep(1);
      processed.push(item);
      if (item === 3) throw new Error(`falló el ítem ${item}`);
      return item;
    }),
    (err: unknown) => {
      assert.ok(err instanceof AggregateError);
      assert.equal(err.errors.length, 1);
      assert.match(String(err.errors[0]), /falló el ítem 3/);
      return true;
    },
  );

  // Todos los ítems se intentaron, incluidos los que venían después del que falló.
  assert.deepEqual([...processed].sort((a, b) => a - b), [1, 2, 3, 4, 5]);
});

test("mapWithLimit: con límite mayor que la cantidad de ítems, igual funciona", async () => {
  const results = await mapWithLimit([1, 2], 10, async (item) => item * 2);
  assert.deepEqual(results, [2, 4]);
});

test("mapWithLimit: lista vacía no revienta y devuelve []", async () => {
  const results = await mapWithLimit([], 5, async (item) => item);
  assert.deepEqual(results, []);
});
