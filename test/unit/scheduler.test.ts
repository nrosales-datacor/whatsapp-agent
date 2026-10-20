import assert from "node:assert/strict";
import { test } from "node:test";
import { startNonOverlappingLoop } from "../../src/platform/net/scheduler";

/** Espera `ms` milisegundos sin bloquear el loop de eventos. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("startNonOverlappingLoop: nunca hay dos ticks corriendo al mismo tiempo, aunque el tick tarde más que el intervalo", async () => {
  let inFlight = 0;
  let overlapped = false;
  let runs = 0;
  const startTimes: number[] = [];

  await new Promise<void>((resolve) => {
    const loop = startNonOverlappingLoop({
      label: "test",
      // Intervalo bien corto y tick bien lento: si el guard fallara (p. ej. con un
      // `setInterval` de toda la vida), el próximo tick arrancaría mientras el anterior
      // sigue corriendo.
      intervalMs: 5,
      scalingHint: "",
      onError: () => {},
      tick: async () => {
        startTimes.push(Date.now());
        if (inFlight > 0) overlapped = true;
        inFlight++;
        await sleep(30); // MUCHO más que el intervalo (5 ms)
        inFlight--;
        runs++;
        if (runs >= 4) {
          loop.stop(); // sin esto el ciclo seguiría agendando timers para siempre
          resolve();
        }
      },
    });
  });

  assert.equal(overlapped, false, "dos ticks corrieron al mismo tiempo");

  // Cada tick debe empezar DESPUÉS de que el anterior terminó (30 ms) más el intervalo
  // (5 ms) — nunca antes, como pasaría con un setInterval que dispara por reloj.
  for (let i = 1; i < startTimes.length; i++) {
    const gap = startTimes[i] - startTimes[i - 1];
    assert.ok(gap >= 30, `el tick ${i} arrancó a los ${gap} ms del anterior, esperado >= ~30 ms`);
  }
});

test("startNonOverlappingLoop: un tick que rechaza no detiene el ciclo (sigue agendando el siguiente)", async () => {
  let attempts = 0;
  const errors: unknown[] = [];

  await new Promise<void>((resolve) => {
    const loop = startNonOverlappingLoop({
      label: "test-error",
      intervalMs: 5,
      scalingHint: "",
      onError: (e) => errors.push(e),
      tick: async () => {
        attempts++;
        if (attempts <= 2) throw new Error(`falla del tick ${attempts}`);
        loop.stop();
        resolve();
      },
    });
  });

  assert.ok(attempts >= 3, "el ciclo debió reintentar después de los errores");
  assert.equal(errors.length, 2);
});
