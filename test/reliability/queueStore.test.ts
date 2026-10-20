import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, beforeEach, test } from "node:test";
import { sql } from "drizzle-orm";
import { rowsOf } from "../../src/platform/db/rows";
import { withSystem, withTenant } from "../../src/platform/db/scope";
import { countJobs, listDeadJobs, purgeFinishedJobs, retryJob } from "../../src/platform/queue/admin";
import { enqueue } from "../../src/platform/queue/enqueue";
import {
  claimJob,
  heartbeatJobs,
  markJobDead,
  markJobDone,
  markJobForRetry,
  recoverExpiredJobs,
  releaseJob,
} from "../../src/platform/queue/store";
import { createEphemeralDb } from "../helpers/pgliteDb";
import { allJobs, getJob } from "../helpers/queue";

// ─────────────────────────────────────────────────────────────────────────────
// Cola durable contra Postgres efímero (PGlite): encolado (outbox y dedupe), el SQL del
// ciclo de vida (claim, cierre con fencing, latido, recuperación) y la operación (DLQ,
// reencolar, purga). El worker completo se prueba en queueWorker.test.ts.
// ─────────────────────────────────────────────────────────────────────────────

const base = await createEphemeralDb();
const { db } = base;
after(() => base.close());
beforeEach(() => base.client.exec("TRUNCATE jobs"));

const W = "worker-test";

test("enqueue dentro de una transacción: el job existe si la transacción hace commit", async () => {
  const A = randomUUID();
  const result = await withTenant(db, A, async (tx) => {
    // … acá iría la escritura de dominio …
    return enqueue(tx, { type: "email.send", payload: { to: "id-1" }, businessId: A });
  });
  assert.equal(result.created, true);
  const job = await getJob(db, result.id);
  assert.equal(job.status, "pending");
  assert.equal(job.businessId, A);
  assert.deepEqual(job.payload, { to: "id-1" });
  assert.equal(job.attempts, 0);
  assert.equal(job.maxAttempts, 5);
});

test("enqueue dentro de una transacción: si la transacción hace rollback, el job no existe", async () => {
  const A = randomUUID();
  await assert.rejects(
    withTenant(db, A, async (tx) => {
      await enqueue(tx, { type: "email.send", payload: {}, businessId: A });
      throw new Error("falla la escritura de dominio");
    }),
    /falla la escritura de dominio/,
  );
  assert.equal((await allJobs(db)).length, 0, "el job se fue con el rollback (outbox)");
});

test("enqueue con el pool (sin transacción): abre la suya, de negocio o de sistema", async () => {
  const A = randomUUID();
  const ofA = await enqueue(db, { type: "test.pool", payload: { n: 1 }, businessId: A, maxAttempts: 2 });
  const system = await enqueue(db, { type: "test.pool", payload: { n: 2 } });
  assert.equal((await getJob(db, ofA.id)).businessId, A);
  assert.equal((await getJob(db, ofA.id)).maxAttempts, 2);
  assert.equal((await getJob(db, system.id)).businessId, null);
});

test("enqueue con runAfter: no se reclama antes de tiempo", async () => {
  await enqueue(db, { type: "test.later", payload: {}, runAfter: new Date(Date.now() + 60_000) });
  assert.equal(await claimJob(db, { types: ["test.later"], workerId: W, perBusiness: 1 }), null);
});

test("dedupe: la misma clave del mismo negocio no duplica (y devuelve el id existente)", async () => {
  const A = randomUUID();
  const B = randomUUID();
  const first = await enqueue(db, { type: "reminder.send", payload: { v: 1 }, businessId: A, dedupeKey: "appt-1:24h" });
  const again = await enqueue(db, { type: "reminder.send", payload: { v: 2 }, businessId: A, dedupeKey: "appt-1:24h" });
  assert.equal(first.created, true);
  assert.deepEqual(again, { id: first.id, created: false });

  // Dentro de una transacción también (y la transacción sigue viva después del conflicto).
  const inTx = await withTenant(db, A, async (tx) => {
    const r = await enqueue(tx, { type: "reminder.send", payload: {}, businessId: A, dedupeKey: "appt-1:24h" });
    await tx.execute(sql`SELECT 1`);
    return r;
  });
  assert.deepEqual(inTx, { id: first.id, created: false });

  // Otro negocio con la misma clave: es otro job (la clave es por negocio).
  const ofB = await enqueue(db, { type: "reminder.send", payload: {}, businessId: B, dedupeKey: "appt-1:24h" });
  assert.equal(ofB.created, true);

  // Jobs de sistema: también se deduplican entre sí.
  const s1 = await enqueue(db, { type: "system.report", payload: {}, dedupeKey: "daily:2026-10-20" });
  const s2 = await enqueue(db, { type: "system.report", payload: {}, dedupeKey: "daily:2026-10-20" });
  assert.deepEqual(s2, { id: s1.id, created: false });

  // Sin clave no hay dedupe.
  await enqueue(db, { type: "reminder.send", payload: {}, businessId: A });
  await enqueue(db, { type: "reminder.send", payload: {}, businessId: A });

  assert.equal((await allJobs(db)).length, 5);
  assert.deepEqual((await getJob(db, first.id)).payload, { v: 1 }, "el duplicado no pisa el payload");
});

test("dedupe: la clave sigue bloqueando cuando el job ya terminó (idempotencia hasta la purga)", async () => {
  const first = await enqueue(db, { type: "test.once", payload: {}, dedupeKey: "k" });
  const job = await claimJob(db, { types: ["test.once"], workerId: W, perBusiness: 1 });
  assert.ok(job && (await markJobDone(db, job, W)));
  assert.deepEqual(await enqueue(db, { type: "test.once", payload: {}, dedupeKey: "k" }), { id: first.id, created: false });

  // La purga libera la clave.
  await withSystem(db, (tx) => tx.execute(sql`UPDATE jobs SET finished_at = now() - interval '30 days'`));
  assert.equal(await purgeFinishedJobs(db, new Date(Date.now() - 7 * 86_400_000)), 1);
  assert.equal((await enqueue(db, { type: "test.once", payload: {}, dedupeKey: "k" })).created, true);
});

test("claim: reclama, marca running con locked_by y suma el intento; solo tipos pedidos", async () => {
  const A = randomUUID();
  const { id } = await enqueue(db, { type: "test.a", payload: { x: 1 }, businessId: A, groupKey: "conv-1" });
  await enqueue(db, { type: "test.other", payload: {} });

  assert.equal(await claimJob(db, { types: ["test.nope"], workerId: W, perBusiness: 1 }), null);
  assert.equal(await claimJob(db, { types: [], workerId: W, perBusiness: 1 }), null);

  const job = await claimJob(db, { types: ["test.a"], workerId: W, perBusiness: 1 });
  assert.ok(job);
  assert.deepEqual(job, { id, businessId: A, type: "test.a", payload: { x: 1 }, attempt: 1, maxAttempts: 5, groupKey: "conv-1" });
  const row = await getJob(db, id);
  assert.equal(row.status, "running");
  assert.equal(row.lockedBy, W);
  assert.ok(row.lockedAt);
  assert.equal(await claimJob(db, { types: ["test.a"], workerId: W, perBusiness: 1 }), null, "ya está running: no se reclama dos veces");
});

test("claim: un solo job running por (negocio, group_key); otro grupo u otro negocio sí", async () => {
  const A = randomUUID();
  const B = randomUUID();
  const g1 = await enqueue(db, { type: "test.g", payload: {}, businessId: A, groupKey: "conv-1" });
  await enqueue(db, { type: "test.g", payload: {}, businessId: A, groupKey: "conv-1" });
  const g2 = await enqueue(db, { type: "test.g", payload: {}, businessId: A, groupKey: "conv-2" });
  const gB = await enqueue(db, { type: "test.g", payload: {}, businessId: B, groupKey: "conv-1" });

  const claimed = [];
  for (let i = 0; i < 4; i++) {
    const job = await claimJob(db, { types: ["test.g"], workerId: W, perBusiness: 4 });
    if (job) claimed.push(job.id);
  }
  assert.deepEqual(new Set(claimed), new Set([g1.id, g2.id, gB.id]), "el segundo de conv-1 de A espera");
});

test("cierre con fencing: done / retry / dead solo si el job sigue siendo de este worker y este intento", async () => {
  await enqueue(db, { type: "test.f", payload: {}, maxAttempts: 3 });
  const job = await claimJob(db, { types: ["test.f"], workerId: W, perBusiness: 1 });
  assert.ok(job);
  assert.equal(await markJobDone(db, job, "otro-worker"), false, "otro worker no lo cierra");

  assert.equal(await markJobForRetry(db, job, W, "Error: boom", 60_000), true);
  let row = await getJob(db, job.id);
  assert.equal(row.status, "failed");
  assert.equal(row.lastError, "Error: boom");
  assert.equal(row.lockedBy, null);
  assert.ok(row.runAfter.getTime() > Date.now() + 50_000, "backoff aplicado a run_after");
  assert.equal(await markJobDone(db, job, W), false, "un cierre tardío del mismo intento ya no pisa nada");

  // Reclamable de nuevo cuando vence el backoff.
  await withSystem(db, (tx) => tx.execute(sql`UPDATE jobs SET run_after = now()`));
  const second = await claimJob(db, { types: ["test.f"], workerId: W, perBusiness: 1 });
  assert.equal(second?.attempt, 2);
  assert.equal(await markJobDead(db, second!, W, "PermanentJobError: no existe"), true);
  row = await getJob(db, job.id);
  assert.equal(row.status, "dead");
  assert.ok(row.finishedAt);
});

test("releaseJob: devuelve el job sin correrlo y descuenta el intento", async () => {
  await enqueue(db, { type: "test.r", payload: {} });
  const job = await claimJob(db, { types: ["test.r"], workerId: W, perBusiness: 1 });
  assert.ok(job && (await releaseJob(db, job, W)));
  const row = await getJob(db, job.id);
  assert.equal(row.status, "pending");
  assert.equal(row.attempts, 0);
  assert.equal(row.lockedBy, null);
});

test("latido y recuperación: un lock vencido vuelve a la cola; uno con latido no", async () => {
  await enqueue(db, { type: "test.h", payload: {}, maxAttempts: 3 });
  await enqueue(db, { type: "test.h", payload: {}, maxAttempts: 1 });
  await enqueue(db, { type: "test.h", payload: {}, maxAttempts: 3 });
  const a = await claimJob(db, { types: ["test.h"], workerId: W, perBusiness: 3 });
  const b = await claimJob(db, { types: ["test.h"], workerId: W, perBusiness: 3 });
  const alive = await claimJob(db, { types: ["test.h"], workerId: W, perBusiness: 3 });
  assert.ok(a && b && alive);

  // Los tres llevan 10 min sin latido…
  await withSystem(db, (tx) => tx.execute(sql`UPDATE jobs SET locked_at = now() - interval '10 minutes'`));
  // …pero `alive` late justo antes de la recuperación.
  assert.equal(await heartbeatJobs(db, W, [alive.id]), 1);
  assert.equal(await heartbeatJobs(db, "otro-worker", [a.id]), 0, "solo late el dueño");

  const recovered = await recoverExpiredJobs(db, 60_000);
  const byId = new Map(recovered.map((r) => [r.id, r.status]));
  assert.equal(byId.size, 2);
  // El de maxAttempts 1 ya no tiene intentos: dead (poison pill); el otro, failed y reclamable.
  const dead = a.maxAttempts === 1 ? a : b;
  const retried = a.maxAttempts === 1 ? b : a;
  assert.equal(byId.get(dead.id), "dead");
  assert.equal(byId.get(retried.id), "failed");
  assert.equal((await getJob(db, alive.id)).status, "running");
  assert.match((await getJob(db, retried.id)).lastError ?? "", /lock vencido/);
  assert.ok((await getJob(db, dead.id)).finishedAt);
  assert.equal(await markJobDone(db, retried, W), false, "el worker viejo ya no puede cerrarlo");

  const again = await claimJob(db, { types: ["test.h"], workerId: "otro-worker", perBusiness: 3 });
  assert.equal(again?.id, retried.id);
  assert.equal(again?.attempt, 2);
});

test("operación: listDeadJobs (sin payload), retryJob y countJobs", async () => {
  const A = randomUUID();
  const B = randomUUID();
  for (const businessId of [A, B]) {
    await enqueue(db, { type: "test.dlq", payload: { secret: "no se lista" }, businessId, maxAttempts: 1 });
    const job = await claimJob(db, { types: ["test.dlq"], workerId: W, perBusiness: 1 });
    assert.ok(job && (await markJobDead(db, job, W, "Error: sin arreglo")));
  }
  await enqueue(db, { type: "test.pending", payload: {} });

  const all = await listDeadJobs(db);
  assert.equal(all.length, 2);
  assert.ok(all.every((j) => j.lastError === "Error: sin arreglo" && j.attempts === 1 && j.finishedAt instanceof Date));
  assert.ok(!("payload" in all[0]), "el DLQ no trae el payload");
  const ofA = await listDeadJobs(db, { businessId: A });
  assert.deepEqual(ofA.map((j) => j.businessId), [A]);
  assert.equal((await listDeadJobs(db, { type: "test.otro" })).length, 0);

  assert.equal(await retryJob(db, ofA[0].id), true);
  assert.equal(await retryJob(db, ofA[0].id), false, "ya no está en dead: no-op");
  assert.equal(await retryJob(db, "no-es-un-uuid"), false);
  const row = await getJob(db, ofA[0].id);
  assert.equal(row.status, "pending");
  assert.equal(row.attempts, 0);
  assert.equal(row.finishedAt, null);

  const counts = await countJobs(db);
  assert.deepEqual(
    counts.map((c) => [c.type, c.status, c.count]),
    [
      ["test.dlq", "dead", 1],
      ["test.dlq", "pending", 1],
      ["test.pending", "pending", 1],
    ],
  );
});

test("purgeFinishedJobs: borra en lotes los done viejos; dead solo con includeDead; nunca los vivos", async () => {
  await withSystem(db, (tx) =>
    tx.execute(sql`
      INSERT INTO jobs (type, status, finished_at)
      SELECT 'test.p', 'done', now() - interval '10 days' FROM generate_series(1, 7)
      UNION ALL SELECT 'test.p', 'done', now() - interval '1 day'
      UNION ALL SELECT 'test.p', 'dead', now() - interval '10 days'
      UNION ALL SELECT 'test.p', 'pending', NULL
      UNION ALL SELECT 'test.p', 'failed', NULL
    `),
  );
  const cutoff = new Date(Date.now() - 7 * 86_400_000);
  assert.equal(await purgeFinishedJobs(db, cutoff, { batchSize: 3 }), 7, "varios lotes (3+3+1)");
  assert.equal(await purgeFinishedJobs(db, cutoff, { includeDead: true }), 1);
  const left = rowsOf<{ status: string; n: number }>(
    await withSystem(db, (tx) => tx.execute(sql`SELECT status, count(*)::int AS n FROM jobs GROUP BY status ORDER BY status`)),
  );
  assert.deepEqual(left.map((r) => [r.status, r.n]), [
    ["done", 1],
    ["failed", 1],
    ["pending", 1],
  ]);
});

test("la tabla rechaza un estado inválido (CHECK)", async () => {
  await assert.rejects(withSystem(db, (tx) => tx.execute(sql`INSERT INTO jobs (type, status) VALUES ('test.x', 'weird')`)));
});
