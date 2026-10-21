import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, test } from "node:test";
import { eq, sql } from "drizzle-orm";
import { createJobGate } from "../../src/jobs";
import { invalidateBusinessContext } from "../../src/modules/business";
import { businesses } from "../../src/modules/business/schema";
import { withSystem } from "../../src/platform/db/scope";
import { _resetShutdownForTests } from "../../src/platform/net/shutdown";
import { enqueue } from "../../src/platform/queue/enqueue";
import { _resetJobHandlersForTests, registerJobHandler } from "../../src/platform/queue/handlers";
import { _resetQueueStatsForTests, getQueueStats } from "../../src/platform/queue/stats";
import { startQueueWorker, type QueueWorker } from "../../src/platform/queue/worker";
import { createTestBusiness } from "../helpers/identityFixtures";
import { createEphemeralDb, type EphemeralDb } from "../helpers/pgliteDb";
import { getJob, silenceConsole, sleep, waitFor } from "../helpers/queue";

// ─────────────────────────────────────────────────────────────────────────────
// Negocio pausado (cobro manual) y la cola: el worker real con el chequeo de la
// composición (`createJobGate`, de modules/billing) no corre trabajo nuevo del negocio
// pausado: lo posterga sin gastar el intento, y corre cuando se reactiva. El trabajo de
// otros negocios y el de sistema siguen normal.
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
beforeEach(() => {
  _resetJobHandlersForTests();
  _resetQueueStatsForTests();
  _resetShutdownForTests();
});
afterEach(async () => {
  await Promise.all(workers.splice(0).map((w) => w.stop()));
  _resetShutdownForTests();
});

async function setStatus(businessId: string, status: "active" | "paused"): Promise<void> {
  await withSystem(base.db, (tx) => tx.update(businesses).set({ status }).where(eq(businesses.id, businessId)));
  invalidateBusinessContext(businessId);
}

test("cola: el job de un negocio pausado se posterga (sin gastar el intento) y corre al reactivarlo; el resto sigue", async () => {
  const ran: string[] = [];
  registerJobHandler<{ tag: string }>("test.work", async (payload) => {
    ran.push(payload.tag);
  });
  const active = await createTestBusiness(base.db);
  const paused = await createTestBusiness(base.db, { status: "paused" });

  const pausedJob = await enqueue(base.db, { type: "test.work", payload: { tag: "pausado" }, businessId: paused.businessId });
  const activeJob = await enqueue(base.db, { type: "test.work", payload: { tag: "activo" }, businessId: active.businessId });
  const systemJob = await enqueue(base.db, { type: "test.work", payload: { tag: "sistema" } });

  workers.push(
    startQueueWorker({ db: base.db, concurrency: 1, pollMs: 10, retentionDays: 0, canRunJob: createJobGate(base.db), deferredDelayMs: 60_000 }),
  );
  await waitFor(async () => (await getJob(base.db, activeJob.id)).status === "done" && (await getJob(base.db, systemJob.id)).status === "done", "activo y sistema done");
  await waitFor(() => (getQueueStats()["test.work"]?.deferred ?? 0) >= 1, "postergado");

  const deferred = await getJob(base.db, pausedJob.id);
  assert.equal(deferred.status, "pending");
  assert.equal(deferred.attempts, 0, "postergar no gasta el intento");
  assert.equal(deferred.lockedBy, null);
  assert.ok(deferred.runAfter.getTime() > Date.now() + 30_000, "vuelve a la cola recién en un rato");
  assert.deepEqual(ran.sort(), ["activo", "sistema"]);

  // Reactivado (y vencida la espera): corre.
  await setStatus(paused.businessId, "active");
  await withSystem(base.db, (tx) => tx.execute(sql`UPDATE jobs SET run_after = now() WHERE id = ${pausedJob.id}`));
  await waitFor(async () => (await getJob(base.db, pausedJob.id)).status === "done", "pausado done tras reactivar");
  assert.equal((await getJob(base.db, pausedJob.id)).attempts, 1);
  assert.ok(ran.includes("pausado"));
});

test("cola: sin chequeo inyectado (tests, scripts) corre todo como antes", async () => {
  const ran: string[] = [];
  registerJobHandler<{ tag: string }>("test.plain", async (payload) => {
    ran.push(payload.tag);
  });
  const paused = await createTestBusiness(base.db, { status: "paused" });
  const job = await enqueue(base.db, { type: "test.plain", payload: { tag: "x" }, businessId: paused.businessId });
  workers.push(startQueueWorker({ db: base.db, concurrency: 1, pollMs: 10, retentionDays: 0 }));
  await waitFor(async () => (await getJob(base.db, job.id)).status === "done", "done");
  await sleep(10);
  assert.deepEqual(ran, ["x"]);
});
