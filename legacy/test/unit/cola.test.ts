import assert from "node:assert/strict";
import { test } from "node:test";
import { agotoIntentos, calcularBackoffSeg } from "../../src/queue/cola";

test("calcularBackoffSeg: crece exponencialmente (2^intentos) con tope de 60s", () => {
  assert.equal(calcularBackoffSeg(0), 1);
  assert.equal(calcularBackoffSeg(1), 2);
  assert.equal(calcularBackoffSeg(3), 8);
  assert.equal(calcularBackoffSeg(6), 60); // 2^6=64, tope en 60
  assert.equal(calcularBackoffSeg(10), 60); // sigue topado
});

test("agotoIntentos: true solo cuando ya no quedan reintentos", () => {
  assert.equal(agotoIntentos(1, 3), false);
  assert.equal(agotoIntentos(2, 3), false);
  assert.equal(agotoIntentos(3, 3), true);
  assert.equal(agotoIntentos(4, 3), true);
});
