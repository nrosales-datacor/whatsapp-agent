import assert from "node:assert/strict";
import { test } from "node:test";
import { log } from "../../src/platform/observability/log";

/** Captura lo que se le pasa a `console.<método>`. */
function spyConsole(method: "log" | "warn" | "error") {
  const original = console[method];
  const calls: string[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (console as any)[method] = (line: string) => calls.push(line);
  return {
    calls,
    restore: () => {
      console[method] = original;
    },
  };
}

test("log.info: imprime UNA línea JSON válida con ts/level/event + los campos dados", () => {
  const spy = spyConsole("log");
  try {
    log.info("message_received", { correlationId: "abc-123", tenantId: "t1", conversationId: "c1" });
  } finally {
    spy.restore();
  }

  assert.equal(spy.calls.length, 1, "debe emitir exactamente una línea");
  const obj = JSON.parse(spy.calls[0]);
  assert.equal(obj.level, "info");
  assert.equal(obj.event, "message_received");
  assert.equal(obj.correlationId, "abc-123");
  assert.equal(obj.tenantId, "t1");
  assert.equal(obj.conversationId, "c1");
  assert.equal(typeof obj.ts, "string");
  assert.ok(!Number.isNaN(Date.parse(obj.ts)), "ts debe ser una fecha ISO parseable");
});

test("log.warn y log.error: usan console.warn/console.error (no console.log) y marcan el nivel correcto", () => {
  const spyWarn = spyConsole("warn");
  const spyError = spyConsole("error");
  try {
    log.warn("job_failed", { jobId: "j1" });
    log.error("job_failed_permanently", { jobId: "j2" });
  } finally {
    spyWarn.restore();
    spyError.restore();
  }

  assert.equal(spyWarn.calls.length, 1);
  assert.equal(JSON.parse(spyWarn.calls[0]).level, "warn");
  assert.equal(spyError.calls.length, 1);
  assert.equal(JSON.parse(spyError.calls[0]).level, "error");
});

test("log.info: sin campos, igual produce una línea válida con ts/level/event", () => {
  const spy = spyConsole("log");
  try {
    log.info("event_without_fields");
  } finally {
    spy.restore();
  }

  const obj = JSON.parse(spy.calls[0]);
  assert.equal(obj.event, "event_without_fields");
  assert.equal(obj.level, "info");
});

test("log.info: un campo no serializable (BigInt) no lanza — degrada a una línea de error legible", () => {
  const spy = spyConsole("log");
  try {
    assert.doesNotThrow(() => log.info("odd_event", { value: 10n as unknown as number }));
  } finally {
    spy.restore();
  }

  assert.equal(spy.calls.length, 1);
  const obj = JSON.parse(spy.calls[0]);
  assert.equal(obj.event, "log_serialization_failed");
  assert.equal(obj.originalEvent, "odd_event");
});
