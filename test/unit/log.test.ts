import assert from "node:assert/strict";
import { test } from "node:test";
import { log } from "../../src/observabilidad/log";

/** Captura lo que se le pasa a `console.log` (mismo truco que otros tests del repo). */
function espiarConsole(metodo: "log" | "warn" | "error") {
  const original = console[metodo];
  const llamadas: string[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (console as any)[metodo] = (linea: string) => llamadas.push(linea);
  return {
    llamadas,
    restaurar: () => {
      console[metodo] = original;
    },
  };
}

test("log.info: imprime UNA línea JSON válida con ts/nivel/evento + los campos dados", () => {
  const espia = espiarConsole("log");
  try {
    log.info("mensaje_ingresado", { correlationId: "abc-123", tenantId: "t1", conversacionId: "c1" });
  } finally {
    espia.restaurar();
  }

  assert.equal(espia.llamadas.length, 1, "debe emitir exactamente una línea");
  const obj = JSON.parse(espia.llamadas[0]);
  assert.equal(obj.nivel, "info");
  assert.equal(obj.evento, "mensaje_ingresado");
  assert.equal(obj.correlationId, "abc-123");
  assert.equal(obj.tenantId, "t1");
  assert.equal(obj.conversacionId, "c1");
  assert.equal(typeof obj.ts, "string");
  assert.ok(!Number.isNaN(Date.parse(obj.ts)), "ts debe ser una fecha ISO parseable");
});

test("log.warn y log.error: usan console.warn/console.error (no console.log) y marcan el nivel correcto", () => {
  const espiaWarn = espiarConsole("warn");
  const espiaError = espiarConsole("error");
  try {
    log.warn("job_fallido", { jobId: "j1" });
    log.error("job_fallido_definitivo", { jobId: "j2" });
  } finally {
    espiaWarn.restaurar();
    espiaError.restaurar();
  }

  assert.equal(espiaWarn.llamadas.length, 1);
  assert.equal(JSON.parse(espiaWarn.llamadas[0]).nivel, "warn");
  assert.equal(espiaError.llamadas.length, 1);
  assert.equal(JSON.parse(espiaError.llamadas[0]).nivel, "error");
});

test("log.info: sin campos, igual produce una línea válida con ts/nivel/evento", () => {
  const espia = espiarConsole("log");
  try {
    log.info("evento_sin_campos");
  } finally {
    espia.restaurar();
  }

  const obj = JSON.parse(espia.llamadas[0]);
  assert.equal(obj.evento, "evento_sin_campos");
  assert.equal(obj.nivel, "info");
});

test("log.info: un campo no serializable (BigInt) no lanza — degrada a una línea de error legible", () => {
  const espia = espiarConsole("log");
  try {
    assert.doesNotThrow(() => log.info("evento_raro", { valor: 10n as unknown as number }));
  } finally {
    espia.restaurar();
  }

  assert.equal(espia.llamadas.length, 1);
  const obj = JSON.parse(espia.llamadas[0]);
  assert.equal(obj.evento, "log_serializacion_fallo");
  assert.equal(obj.eventoOriginal, "evento_raro");
});
