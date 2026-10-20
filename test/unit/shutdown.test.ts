import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import {
  _resetShutdownForTests,
  drainTasks,
  isShuttingDown,
  pendingTaskCount,
  trackTask,
} from "../../src/platform/net/shutdown";

// Apagado ordenado (src/platform/net/shutdown.ts): al recibir la señal se dejan de tomar
// tareas nuevas y se esperan las que están en curso, con un tope.

afterEach(() => _resetShutdownForTests());

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

test("shutdown: espera a que terminen las tareas en curso y marca 'apagando'", async () => {
  let finished = false;
  trackTask(sleep(50).then(() => (finished = true)));
  assert.equal(pendingTaskCount(), 1);
  assert.equal(isShuttingDown(), false);
  assert.equal(await drainTasks(1000), true);
  assert.equal(finished, true, "la tarea terminó antes de devolver");
  assert.equal(isShuttingDown(), true);
  assert.equal(pendingTaskCount(), 0);
});

test("shutdown: con una tarea que no termina, corta en el tope y devuelve false", async () => {
  trackTask(new Promise(() => {}));
  const start = Date.now();
  assert.equal(await drainTasks(80), false);
  assert.ok(Date.now() - start < 1000);
});

test("shutdown: una tarea que falla también cuenta como terminada", async () => {
  trackTask(sleep(10).then(() => Promise.reject(new Error("x")))).catch(() => {});
  assert.equal(await drainTasks(1000), true);
});
