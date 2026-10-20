import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, afterEach, before, beforeEach, test } from "node:test";
import { sql } from "drizzle-orm";
import { withSystem } from "../../src/platform/db/scope";
import { _resetShutdownForTests, drainTasks } from "../../src/platform/net/shutdown";
import { _resetAlertsForTests } from "../../src/platform/observability/alerts";
import { listDeadJobs, retryJob } from "../../src/platform/queue/admin";
import { enqueue } from "../../src/platform/queue/enqueue";
import { PermanentJobError } from "../../src/platform/queue/errors";
import { _resetJobHandlersForTests, registerJobHandler } from "../../src/platform/queue/handlers";
import { _resetQueueStatsForTests, getQueueStats } from "../../src/platform/queue/stats";
import { startQueueWorker, type QueueWorker, type QueueWorkerOptions } from "../../src/platform/queue/worker";
import { createEphemeralDb, type EphemeralDb } from "../helpers/pgliteDb";
import { allJobs, getJob, silenceConsole, sleep, waitFor } from "../helpers/queue";

// ─────────────────────────────────────────────────────────────────────────────
// Worker de la cola de punta a punta contra Postgres efímero (PGlite): dos workers sin
// doble proceso, reparto entre negocios, exclusión por grupo, reintentos con backoff,
// error permanente → dead, recuperación de locks vencidos (y que el latido la evite),
// timeout, cupo por tipo y apagado ordenado.
//
// PGlite tiene UNA conexión: las transacciones de los dos workers se serializan. Los
// invariantes que importan (nadie corre un job que otro ya reclamó) los garantiza el SQL
// del claim, no el orden de llegada; contra Postgres real los cubre FOR UPDATE SKIP LOCKED.
// ─────────────────────────────────────────────────────────────────────────────

let base: EphemeralDb;
let restoreConsole: () => void;
const workers: QueueWorker[] = [];

before(async () => {
  base = await createEphemeralDb();
  restoreConsole = silenceConsole();
});
after(async () => {
  restoreConsole();
  await base.close();
});

beforeEach(async () => {
  await base.client.exec("TRUNCATE jobs, leader_leases");
  _resetJobHandlersForTests();
  _resetQueueStatsForTests();
  _resetShutdownForTests();
  _resetAlertsForTests();
});

afterEach(async () => {
  await Promise.all(workers.splice(0).map((w) => w.stop()));
  _resetShutdownForTests();
});

/** Worker rápido para tests (sin purga). */
function start(options: Partial<QueueWorkerOptions> = {}): QueueWorker {
  const worker = startQueueWorker({ db: base.db, concurrency: 1, pollMs: 10, retentionDays: 0, ...options });
  workers.push(worker);
  return worker;
}

async function statusOf(id: string): Promise<string> {
  return (await getJob(base.db, id)).status;
}

async function allIn(status: string): Promise<boolean> {
  return (await allJobs(base.db)).every((j) => j.status === status);
}

test("sin handlers registrados el worker arranca, no reclama nada y para limpio", async () => {
  const { id } = await enqueue(base.db, { type: "unknown.type", payload: {} });
  const worker = start({ concurrency: 2 });
  await sleep(100);
  assert.equal(await statusOf(id), "pending", "un tipo sin handler no se toca (ni se manda a dead)");
  await worker.stop();
  await worker.stop(); // idempotente
});

test("solo reclama los tipos que tiene registrados", async () => {
  registerJobHandler("test.known", async () => {});
  const known = await enqueue(base.db, { type: "test.known", payload: {} });
  const other = await enqueue(base.db, { type: "test.not_here", payload: {} });
  start();
  await waitFor(async () => (await statusOf(known.id)) === "done", "known done");
  assert.equal(await statusOf(other.id), "pending");
});

test("dos workers concurrentes: cada job se procesa exactamente una vez", async () => {
  const seen = new Map<string, number>();
  registerJobHandler<{ n: number }>("test.count", async (payload, ctx) => {
    seen.set(ctx.jobId, (seen.get(ctx.jobId) ?? 0) + 1);
    await sleep(payload.n % 3);
  });
  const ids: string[] = [];
  const businesses = [randomUUID(), randomUUID(), randomUUID()];
  for (let n = 0; n < 30; n++) {
    ids.push((await enqueue(base.db, { type: "test.count", payload: { n }, businessId: businesses[n % 3] })).id);
  }
  start({ concurrency: 3, workerId: "w1" });
  start({ concurrency: 3, workerId: "w2" });
  await waitFor(() => allIn("done"), "todos done");
  assert.equal(seen.size, 30);
  assert.ok([...seen.values()].every((n) => n === 1), "ningún job corrió dos veces");
  const rows = await allJobs(base.db);
  assert.ok(rows.every((r) => r.attempts === 1 && r.lockedBy === null && r.finishedAt));
  assert.equal(getQueueStats()["test.count"].done, 30);
});

test("reparto entre negocios: un negocio con muchos jobs no hace esperar al resto (round-robin con un slot)", async () => {
  const A = randomUUID();
  const B = randomUUID();
  const order: string[] = [];
  registerJobHandler("test.fair", async (_p, ctx) => {
    order.push(ctx.businessId === A ? "A" : "B");
  });
  // A encola 10 primero (son los más viejos); B encola 3 después.
  for (let i = 0; i < 10; i++) await enqueue(base.db, { type: "test.fair", payload: {}, businessId: A });
  for (let i = 0; i < 3; i++) await enqueue(base.db, { type: "test.fair", payload: {}, businessId: B });
  start({ concurrency: 1 });
  await waitFor(() => order.length === 13, "13 procesados");
  assert.deepEqual(order.join(""), "ABABABAAAAAAA", "FIFO puro habría sido AAAAAAAAAABBB");
});

test("reparto entre negocios: con varios slots, primero el negocio con menos jobs en vuelo", async () => {
  const A = randomUUID();
  const B = randomUUID();
  const started: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  registerJobHandler("test.inflight", async (_p, ctx) => {
    started.push(ctx.businessId === A ? "A" : "B");
    await gate;
  });
  for (let i = 0; i < 5; i++) await enqueue(base.db, { type: "test.inflight", payload: {}, businessId: A });
  for (let i = 0; i < 5; i++) await enqueue(base.db, { type: "test.inflight", payload: {}, businessId: B });
  start({ concurrency: 4 });
  await waitFor(() => started.length === 4, "4 en vuelo");
  assert.deepEqual([...started].sort(), ["A", "A", "B", "B"], "2 y 2, no los 4 de A (que son más viejos)");
  release();
  await waitFor(() => allIn("done"), "todos done");
});

test("group_key: un solo job en vuelo por grupo y en orden; los otros grupos siguen en paralelo", async () => {
  const A = randomUUID();
  const running = new Map<string, number>();
  let maxConv1 = 0;
  const conv1Order: number[] = [];
  registerJobHandler<{ group: string; n: number }>("test.group", async (payload) => {
    const now = (running.get(payload.group) ?? 0) + 1;
    running.set(payload.group, now);
    if (payload.group === "conv-1") {
      maxConv1 = Math.max(maxConv1, now);
      conv1Order.push(payload.n);
    }
    await sleep(15);
    running.set(payload.group, (running.get(payload.group) ?? 1) - 1);
  });
  for (let n = 0; n < 5; n++) {
    await enqueue(base.db, { type: "test.group", payload: { group: "conv-1", n }, businessId: A, groupKey: "conv-1" });
  }
  for (let n = 0; n < 3; n++) {
    await enqueue(base.db, { type: "test.group", payload: { group: `other-${n}`, n }, businessId: A, groupKey: `other-${n}` });
  }
  start({ concurrency: 4, workerId: "w1" });
  start({ concurrency: 4, workerId: "w2" });
  await waitFor(() => allIn("done"), "todos done");
  assert.equal(maxConv1, 1, "nunca dos jobs de conv-1 a la vez");
  assert.deepEqual(conv1Order, [0, 1, 2, 3, 4], "y en el orden en que se encolaron");
});

test("reintentos con backoff: un error transitorio reintenta respetando la espera, y después sale bien", async () => {
  const attemptsAt: number[] = [];
  registerJobHandler(
    "test.flaky",
    async (_p, ctx) => {
      attemptsAt.push(Date.now());
      if (ctx.attempt < 3) throw Object.assign(new Error("proveedor caído"), { transient: true });
    },
    { backoff: { baseMs: 60, maxMs: 1_000 } },
  );
  const { id } = await enqueue(base.db, { type: "test.flaky", payload: {}, maxAttempts: 5 });
  start();
  await waitFor(async () => (await statusOf(id)) === "done", "done");
  const row = await getJob(base.db, id);
  assert.equal(row.attempts, 3);
  assert.match(row.lastError ?? "", /proveedor caído/);
  // Backoff con jitter "mitad fija": tras el intento 1 espera ≥ 30 ms (60/2); tras el 2, ≥ 60 ms (120/2).
  assert.ok(attemptsAt[1] - attemptsAt[0] >= 28, `espera 1 = ${attemptsAt[1] - attemptsAt[0]} ms`);
  assert.ok(attemptsAt[2] - attemptsAt[1] >= 58, `espera 2 = ${attemptsAt[2] - attemptsAt[1]} ms`);
  const stats = getQueueStats()["test.flaky"];
  assert.equal(stats.retried, 2);
  assert.equal(stats.done, 1);
});

test("agotar los intentos manda a dead (DLQ); reencolado a mano vuelve a correr", async () => {
  let fail = true;
  const contexts: { attempt: number; isLastAttempt: boolean }[] = [];
  registerJobHandler(
    "test.broken",
    async (_p, ctx) => {
      contexts.push({ attempt: ctx.attempt, isLastAttempt: ctx.isLastAttempt });
      if (fail) throw new Error("bug sin clasificar");
    },
    { backoff: { baseMs: 1, maxMs: 1 } },
  );
  const A = randomUUID();
  const { id } = await enqueue(base.db, { type: "test.broken", payload: {}, businessId: A, maxAttempts: 2 });
  start();
  await waitFor(async () => (await statusOf(id)) === "dead", "dead");
  assert.deepEqual(contexts, [
    { attempt: 1, isLastAttempt: false },
    { attempt: 2, isLastAttempt: true },
  ]);
  const [dead] = await listDeadJobs(base.db, { businessId: A });
  assert.equal(dead.id, id);
  assert.match(dead.lastError ?? "", /bug sin clasificar/);

  fail = false;
  assert.equal(await retryJob(base.db, id), true);
  await waitFor(async () => (await statusOf(id)) === "done", "done tras reencolar");
  assert.equal((await getJob(base.db, id)).attempts, 1, "reencolar reinicia los intentos");
});

test("error permanente: pasa directo a dead sin gastar los intentos que quedan", async () => {
  registerJobHandler<{ how: string }>("test.permanent", async (payload) => {
    if (payload.how === "class") throw new PermanentJobError("el destinatario no existe");
    if (payload.how === "flag") throw Object.assign(new Error("dato inválido"), { permanent: true });
    throw Object.assign(new Error("400 del proveedor"), { transient: false });
  });
  const ids = [];
  for (const how of ["class", "flag", "transient-false"]) {
    ids.push((await enqueue(base.db, { type: "test.permanent", payload: { how }, maxAttempts: 5 })).id);
  }
  start();
  await waitFor(() => allIn("dead"), "todos dead");
  for (const id of ids) assert.equal((await getJob(base.db, id)).attempts, 1);
  assert.match((await getJob(base.db, ids[0])).lastError ?? "", /^PermanentJobError: el destinatario no existe/);
});

test("recuperación: un job running cuyo worker murió vuelve a correr (o a dead si no le quedan intentos)", async () => {
  const ran: string[] = [];
  registerJobHandler("test.orphan", async (_p, ctx) => {
    ran.push(ctx.jobId);
  });
  const orphan = await enqueue(base.db, { type: "test.orphan", payload: {}, maxAttempts: 3 });
  const poison = await enqueue(base.db, { type: "test.orphan", payload: {}, maxAttempts: 1 });
  // Simula un worker que los reclamó hace 10 min y murió sin latir más.
  await withSystem(base.db, (tx) =>
    tx.execute(sql`
      UPDATE jobs SET status = 'running', attempts = 1, locked_by = 'dead-worker', locked_at = now() - interval '10 minutes'
    `),
  );
  start({ lockTimeoutMs: 1_000, recoveryIntervalMs: 20 });
  await waitFor(async () => (await statusOf(orphan.id)) === "done", "orphan done");
  assert.equal(await statusOf(poison.id), "dead", "sin intentos: no se repite para siempre");
  assert.deepEqual(ran, [orphan.id]);
  assert.equal((await getJob(base.db, orphan.id)).attempts, 2);
  assert.equal(getQueueStats()["test.orphan"].recovered, 2);
});

test("latido: un job más lento que el lock NO se recupera mientras su worker vive", async () => {
  let runs = 0;
  registerJobHandler("test.slow", async () => {
    runs++;
    await sleep(2_500);
  });
  const { id } = await enqueue(base.db, { type: "test.slow", payload: {} });
  // Lock de 1 s, latido cada 50 ms, recuperación cada 20 ms: sin latido, el job (2,5 s) se
  // recuperaría y el otro worker lo correría de nuevo. El margen (20 latidos por lock) es
  // para que una suite cargada no lo vuelva intermitente.
  start({ lockTimeoutMs: 1_000, heartbeatMs: 50, recoveryIntervalMs: 20, workerId: "w1" });
  start({ lockTimeoutMs: 1_000, heartbeatMs: 50, recoveryIntervalMs: 20, workerId: "w2" });
  await waitFor(async () => (await statusOf(id)) === "done", "done");
  assert.equal(runs, 1, "corrió una sola vez");
  assert.equal((await getJob(base.db, id)).attempts, 1);
});

test("timeout: el intento que se pasa aborta la señal y se reintenta", async () => {
  let aborted = false;
  registerJobHandler(
    "test.timeout",
    async (_p, ctx) => {
      if (ctx.attempt === 1) {
        await new Promise<void>((resolve) =>
          ctx.signal.addEventListener("abort", () => {
            aborted = true;
            resolve();
          }),
        );
      }
    },
    { timeoutMs: 50, backoff: { baseMs: 1, maxMs: 1 } },
  );
  const { id } = await enqueue(base.db, { type: "test.timeout", payload: {} });
  start();
  await waitFor(async () => (await statusOf(id)) === "done", "done");
  assert.equal(aborted, true);
  const row = await getJob(base.db, id);
  assert.equal(row.attempts, 2);
  assert.match(row.lastError ?? "", /JobTimeoutError/);
  assert.equal(getQueueStats()["test.timeout"].timedOut, 1);
});

test("cupo por tipo: concurrency del handler limita los jobs de ese tipo en vuelo en el proceso", async () => {
  let current = 0;
  let max = 0;
  registerJobHandler(
    "test.limited",
    async () => {
      current++;
      max = Math.max(max, current);
      await sleep(20);
      current--;
    },
    { concurrency: 2 },
  );
  for (let i = 0; i < 8; i++) await enqueue(base.db, { type: "test.limited", payload: {}, businessId: randomUUID() });
  start({ concurrency: 6 });
  await waitFor(() => allIn("done"), "todos done");
  assert.equal(max, 2);
});

test("apagado ordenado (stop): deja de reclamar y espera al job en curso", async () => {
  let started = 0;
  let finished = 0;
  registerJobHandler("test.drain", async () => {
    started++;
    await sleep(200);
    finished++;
  });
  const first = await enqueue(base.db, { type: "test.drain", payload: {} });
  const second = await enqueue(base.db, { type: "test.drain", payload: {} });
  const worker = start({ concurrency: 1 });
  await waitFor(() => started === 1, "primer job empezado");
  await worker.stop();
  assert.equal(finished, 1, "stop() esperó al job en curso");
  assert.equal(await statusOf(first.id), "done");
  assert.equal(await statusOf(second.id), "pending", "no tomó jobs nuevos");
  assert.equal(started, 1);
});

test("apagado ordenado (señal del proceso): drainTasks espera al job en curso y el worker no toma más", async () => {
  let started = 0;
  registerJobHandler("test.signal", async () => {
    started++;
    await sleep(150);
  });
  const first = await enqueue(base.db, { type: "test.signal", payload: {} });
  const second = await enqueue(base.db, { type: "test.signal", payload: {} });
  start({ concurrency: 1 });
  await waitFor(() => started === 1, "primer job empezado");
  assert.equal(await drainTasks(5_000), true, "el job en curso terminó dentro del tope");
  assert.equal(await statusOf(first.id), "done");
  await sleep(100);
  assert.equal(await statusOf(second.id), "pending");
  assert.equal(started, 1);
});
