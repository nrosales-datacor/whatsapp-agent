import assert from "node:assert/strict";
import { test } from "node:test";
import { mapConLimite } from "../../src/red/concurrencia";

/** Espera `ms` milisegundos sin bloquear el loop de eventos. */
function esperar(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("mapConLimite: nunca supera el límite de ejecuciones simultáneas", async () => {
  const items = Array.from({ length: 12 }, (_, i) => i);
  let enVuelo = 0;
  let maxEnVuelo = 0;

  await mapConLimite(items, 3, async (item) => {
    enVuelo++;
    maxEnVuelo = Math.max(maxEnVuelo, enVuelo);
    // Duración variable: si el helper no respetara el límite, ítems más rápidos
    // dejarían pasar de más antes de que los lentos terminen.
    await esperar(5 + (item % 3) * 3);
    enVuelo--;
    return item;
  });

  assert.ok(maxEnVuelo <= 3, `maxEnVuelo fue ${maxEnVuelo}, esperado <= 3`);
});

test("mapConLimite: preserva el orden de los resultados aunque terminen en otro orden", async () => {
  const items = [1, 2, 3, 4, 5];
  // Los ítems más grandes tardan MENOS: si no se preservara el orden, el
  // resultado saldría con los rápidos primero.
  const resultados = await mapConLimite(items, 2, async (item) => {
    await esperar((6 - item) * 5);
    return item * 10;
  });

  assert.deepEqual(resultados, [10, 20, 30, 40, 50]);
});

test("mapConLimite: un ítem que falla no frena a los demás (se procesan todos)", async () => {
  const items = [1, 2, 3, 4, 5];
  const procesados: number[] = [];

  await assert.rejects(
    mapConLimite(items, 2, async (item) => {
      await esperar(1);
      procesados.push(item);
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
  assert.deepEqual([...procesados].sort((a, b) => a - b), [1, 2, 3, 4, 5]);
});

test("mapConLimite: con límite mayor que la cantidad de ítems, igual funciona", async () => {
  const resultados = await mapConLimite([1, 2], 10, async (item) => item * 2);
  assert.deepEqual(resultados, [2, 4]);
});

test("mapConLimite: lista vacía no revienta y devuelve []", async () => {
  const resultados = await mapConLimite([], 5, async (item) => item);
  assert.deepEqual(resultados, []);
});
