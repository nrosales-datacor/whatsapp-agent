import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { APIConnectionError, APIError } from "openai";
import type { Executor } from "../../src/platform/db/scope";
import { _resetAlertsForTests } from "../../src/platform/observability/alerts";
import { enqueue } from "../../src/platform/queue/enqueue";
import {
  classifyJobError,
  computeBackoffMs,
  DEFAULT_BACKOFF,
  describeJobError,
  JobTimeoutError,
  PermanentJobError,
} from "../../src/platform/queue/errors";
import { _resetJobHandlersForTests, getJobHandler, registerJobHandler, registeredJobHandlers } from "../../src/platform/queue/handlers";
import { _resetQueueStatsForTests, getQueueStats, recordJobEvent, trackDeadJob } from "../../src/platform/queue/stats";
import { queueConfigFromEnv } from "../../src/platform/queue/worker";

// Piezas puras de la cola (src/platform/queue): backoff, clasificación de errores,
// registro de handlers, validación de enqueue y métricas por tipo. Lo que toca la base
// está en test/reliability/queue*.test.ts.

afterEach(() => {
  _resetJobHandlersForTests();
  _resetQueueStatsForTests();
  _resetAlertsForTests();
});

test("backoff: exponencial con tope y jitter entre la mitad y el total", () => {
  const opts = { baseMs: 1_000, maxMs: 30_000 };
  assert.equal(computeBackoffMs(1, opts, () => 0), 500, "intento 1, jitter mínimo: base/2");
  assert.equal(computeBackoffMs(1, opts, () => 1), 1_000, "intento 1, jitter máximo: base");
  assert.equal(computeBackoffMs(2, opts, () => 1), 2_000);
  assert.equal(computeBackoffMs(4, opts, () => 1), 8_000);
  assert.equal(computeBackoffMs(10, opts, () => 1), 30_000, "con tope");
  assert.equal(computeBackoffMs(10, opts, () => 0), 15_000, "el tope también lleva jitter");
  assert.equal(computeBackoffMs(500, opts, () => 1), 30_000, "intentos enormes no desbordan");
  assert.equal(computeBackoffMs(0, opts, () => 1), 1_000, "intento < 1 se trata como el primero");
  for (let i = 0; i < 50; i++) {
    const ms = computeBackoffMs(3, DEFAULT_BACKOFF);
    assert.ok(ms >= 4_000 && ms <= 8_000, `fuera de rango: ${ms}`);
  }
});

test("clasificación: transitorio, permanente o desconocido (siguiendo la cadena de cause)", () => {
  assert.equal(classifyJobError(Object.assign(new Error("x"), { transient: true })), "transient");
  assert.equal(classifyJobError(new APIConnectionError({ message: "sin red" })), "transient");
  assert.equal(classifyJobError(new JobTimeoutError(10)), "transient");
  assert.equal(classifyJobError(new PermanentJobError("no existe")), "permanent");
  assert.equal(classifyJobError(Object.assign(new Error("x"), { permanent: true })), "permanent");
  assert.equal(classifyJobError(Object.assign(new Error("400"), { transient: false })), "permanent");
  assert.equal(classifyJobError(new Error("envoltura", { cause: new PermanentJobError("adentro") })), "permanent");
  assert.equal(classifyJobError(new Error("envoltura", { cause: Object.assign(new Error("x"), { transient: true }) })), "transient");
  assert.equal(classifyJobError(new Error("bug")), "unknown");
  assert.equal(classifyJobError(new APIError(400, undefined, "bad request", undefined)), "unknown");
  assert.equal(classifyJobError("un string"), "unknown");
  assert.equal(classifyJobError(undefined), "unknown");
});

test("describeJobError: nombre + mensaje, recortado", () => {
  assert.equal(describeJobError(new PermanentJobError("no existe")), "PermanentJobError: no existe");
  assert.equal(describeJobError("texto suelto"), "texto suelto");
  const long = describeJobError(new Error("x".repeat(5_000)));
  assert.ok(long.length <= 2_001 && long.endsWith("…"));
});

test("registerJobHandler: registra con sus opciones; rechaza duplicados, tipos y opciones inválidas", () => {
  const handler = async () => {};
  registerJobHandler("email.send", handler, { concurrency: 2, timeoutMs: 5_000, backoff: { baseMs: 10 } });
  registerJobHandler("whatsapp.reply-inbound", handler);
  const email = getJobHandler("email.send");
  assert.equal(email?.concurrency, 2);
  assert.equal(email?.timeoutMs, 5_000);
  assert.deepEqual(email?.backoff, { baseMs: 10 });
  assert.equal(getJobHandler("whatsapp.reply-inbound")?.concurrency, Number.POSITIVE_INFINITY);
  assert.equal(getJobHandler("whatsapp.reply-inbound")?.timeoutMs, null);
  assert.deepEqual(registeredJobHandlers().map((h) => h.type), ["email.send", "whatsapp.reply-inbound"]);

  assert.throws(() => registerJobHandler("email.send", handler), /ya tiene handler/);
  for (const bad of ["", "Email.Send", "email..send", "email send", ".email", "1email"]) {
    assert.throws(() => registerJobHandler(bad, handler), /tipo inválido/, bad);
  }
  assert.throws(() => registerJobHandler("x.a", handler, { concurrency: 0 }), /concurrency/);
  assert.throws(() => registerJobHandler("x.b", handler, { timeoutMs: 1.5 }), /timeoutMs/);
});

test("enqueue: valida antes de tocar la base", async () => {
  const noDb = {} as Executor; // si llegara a usarse, reventaría con otro error
  await assert.rejects(enqueue(noDb, { type: "Bad Type", payload: {} }), /tipo de job inválido/);
  await assert.rejects(enqueue(noDb, { type: "x.y", payload: {}, businessId: "negocio-a" }), /businessId inválido/);
  await assert.rejects(enqueue(noDb, { type: "x.y", payload: {}, maxAttempts: 0 }), /maxAttempts/);
  await assert.rejects(enqueue(noDb, { type: "x.y", payload: {}, runAfter: new Date("no") }), /runAfter/);
  await assert.rejects(enqueue(noDb, { type: "x.y", payload: {}, dedupeKey: "" }), /vacíos/);
});

test("métricas por tipo: eventos, duración promedio y máxima", () => {
  recordJobEvent("email.send", "claimed");
  recordJobEvent("email.send", "done", 100);
  recordJobEvent("email.send", "claimed");
  recordJobEvent("email.send", "retried", 300);
  recordJobEvent("other.type", "dead", 10);
  const stats = getQueueStats();
  assert.equal(stats["email.send"].claimed, 2);
  assert.equal(stats["email.send"].done, 1);
  assert.equal(stats["email.send"].retried, 1);
  assert.equal(stats["email.send"].avgMs, 200);
  assert.equal(stats["email.send"].maxMs, 300);
  assert.equal(stats["other.type"].dead, 1);
});

test("alerta de DLQ por negocio: sale al cruzar el umbral en la ventana, no por cada job", () => {
  const t0 = 1_000_000;
  const results = [];
  for (let i = 0; i < 6; i++) results.push(trackDeadJob("b-1", "email.send", t0 + i));
  assert.deepEqual(results, [false, false, false, false, true, false], "una alerta al 5.º; el 6.º la absorbe el cooldown");
  assert.equal(trackDeadJob("b-2", "email.send", t0), false, "otro negocio lleva su propia cuenta");
  // Fuera de la ventana (10 min) la cuenta vuelve a empezar.
  assert.equal(trackDeadJob("b-3", "x.y", t0), false);
  for (let i = 1; i < 4; i++) trackDeadJob("b-3", "x.y", t0 + i);
  assert.equal(trackDeadJob("b-3", "x.y", t0 + 11 * 60_000), false, "los 4 viejos ya no cuentan");
});

test("queueConfigFromEnv: defaults y valores inválidos ignorados", () => {
  const saved = { ...process.env };
  try {
    delete process.env.QUEUE_CONCURRENCY;
    delete process.env.QUEUE_POLL_MS;
    delete process.env.QUEUE_LOCK_TIMEOUT_MS;
    delete process.env.QUEUE_RETENTION_DAYS;
    assert.deepEqual(queueConfigFromEnv(), { concurrency: 4, pollMs: 1_000, lockTimeoutMs: 300_000, retentionDays: 7 });
    process.env.QUEUE_CONCURRENCY = "8";
    process.env.QUEUE_POLL_MS = "abc";
    process.env.QUEUE_LOCK_TIMEOUT_MS = "-5";
    process.env.QUEUE_RETENTION_DAYS = "0";
    assert.deepEqual(queueConfigFromEnv(), { concurrency: 8, pollMs: 1_000, lockTimeoutMs: 300_000, retentionDays: 0 });
  } finally {
    process.env = saved;
  }
});
