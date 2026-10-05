import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { _resetApagadoParaTests, apagando, enCurso, esperarTareas, tareasEnCurso } from "../../src/red/apagado";

// Apagado ordenado (src/red/apagado.ts): al recibir la señal se dejan de tomar tareas
// nuevas y se esperan las que están en curso, con un tope.

afterEach(() => _resetApagadoParaTests());

const dormir = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

test("apagado: espera a que terminen las tareas en curso y marca 'apagando'", async () => {
  let terminada = false;
  enCurso(dormir(50).then(() => (terminada = true)));
  assert.equal(tareasEnCurso(), 1);
  assert.equal(apagando(), false);
  assert.equal(await esperarTareas(1000), true);
  assert.equal(terminada, true, "la tarea terminó antes de devolver");
  assert.equal(apagando(), true);
  assert.equal(tareasEnCurso(), 0);
});

test("apagado: con una tarea que no termina, corta en el tope y devuelve false", async () => {
  enCurso(new Promise(() => {}));
  const inicio = Date.now();
  assert.equal(await esperarTareas(80), false);
  assert.ok(Date.now() - inicio < 1000);
});

test("apagado: una tarea que falla también cuenta como terminada", async () => {
  enCurso(dormir(10).then(() => Promise.reject(new Error("x")))).catch(() => {});
  assert.equal(await esperarTareas(1000), true);
});
