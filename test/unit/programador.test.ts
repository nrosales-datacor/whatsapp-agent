import assert from "node:assert/strict";
import { test } from "node:test";
import { iniciarCicloSinSolape } from "../../src/red/programador";

/** Espera `ms` milisegundos sin bloquear el loop de eventos. */
function esperar(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("iniciarCicloSinSolape: nunca hay dos ticks corriendo al mismo tiempo, aunque el tick tarde más que el intervalo", async () => {
  let enVuelo = 0;
  let seSolaparon = false;
  let ejecuciones = 0;
  const marcasInicio: number[] = [];

  await new Promise<void>((resolve) => {
    const ciclo = iniciarCicloSinSolape({
      etiqueta: "test",
      // Intervalo bien corto y tick bien lento: si el guard fallara (p. ej. con
      // un `setInterval` de toda la vida), el próximo tick arrancaría mientras
      // el anterior sigue corriendo.
      intervaloMs: 5,
      sugerenciaEscalado: "",
      onError: () => {},
      tick: async () => {
        marcasInicio.push(Date.now());
        if (enVuelo > 0) seSolaparon = true;
        enVuelo++;
        await esperar(30); // MUCHO más que el intervalo (5 ms)
        enVuelo--;
        ejecuciones++;
        if (ejecuciones >= 4) {
          ciclo.detener(); // sin esto el ciclo seguiría agendando timers para siempre
          resolve();
        }
      },
    });
  });

  assert.equal(seSolaparon, false, "dos ticks corrieron al mismo tiempo");

  // Cada tick debe empezar DESPUÉS de que el anterior terminó (30 ms) más el
  // intervalo (5 ms) — nunca antes, como pasaría con un setInterval que dispara
  // por reloj sin importar si el anterior sigue en curso.
  for (let i = 1; i < marcasInicio.length; i++) {
    const gap = marcasInicio[i] - marcasInicio[i - 1];
    assert.ok(gap >= 30, `el tick ${i} arrancó a los ${gap} ms del anterior, esperado >= ~30 ms`);
  }
});

test("iniciarCicloSinSolape: un tick que rechaza no detiene el ciclo (sigue agendando el siguiente)", async () => {
  let intentos = 0;
  const errores: unknown[] = [];

  await new Promise<void>((resolve) => {
    const ciclo = iniciarCicloSinSolape({
      etiqueta: "test-error",
      intervaloMs: 5,
      sugerenciaEscalado: "",
      onError: (e) => errores.push(e),
      tick: async () => {
        intentos++;
        if (intentos <= 2) throw new Error(`falla del tick ${intentos}`);
        ciclo.detener();
        resolve();
      },
    });
  });

  assert.ok(intentos >= 3, "el ciclo debió reintentar después de los errores");
  assert.equal(errores.length, 2);
});
