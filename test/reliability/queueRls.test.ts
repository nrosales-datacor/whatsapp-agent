import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { sql } from "drizzle-orm";
import { rowsOf } from "../../src/platform/db/rows";
import { withSystem, withTenant } from "../../src/platform/db/scope";
import { countJobs, listDeadJobs, purgeFinishedJobs, retryJob } from "../../src/platform/queue/admin";
import { enqueue } from "../../src/platform/queue/enqueue";
import { PermanentJobError } from "../../src/platform/queue/errors";
import { registerJobHandler } from "../../src/platform/queue/handlers";
import { jobs } from "../../src/platform/queue/schema";
import { startQueueWorker } from "../../src/platform/queue/worker";
import { createEphemeralDb } from "../helpers/pgliteDb";
import { silenceConsole, waitFor } from "../helpers/queue";

// ─────────────────────────────────────────────────────────────────────────────
// RLS de la cola de punta a punta: la base corre con el rol de la app (`app_runtime`, SIN
// BYPASSRLS). El negocio encola dentro de su `withTenant` (outbox), el worker reclama y
// cierra con `withSystem`, y lo de un negocio no lo ve ni lo escribe otro. Si alguna
// función de la cola se olvida del contexto, acá falla: no ve sus filas o la política
// rechaza la escritura.
// ─────────────────────────────────────────────────────────────────────────────

const base = await createEphemeralDb();
const { db } = base;
const restoreConsole = silenceConsole();
after(async () => {
  restoreConsole();
  await base.close();
});

const A = randomUUID();
const B = randomUUID();

function isRlsViolation(e: unknown): boolean {
  for (let cur: unknown = e, i = 0; cur && i < 5; i++) {
    if (/row-level security/i.test((cur as Error).message ?? "")) return true;
    cur = (cur as { cause?: unknown }).cause;
  }
  return false;
}

before(async () => {
  await base.client.exec("SET ROLE app_runtime");
});

test("RLS cola: el rol de la app no ve jobs sin contexto", async () => {
  await enqueue(db, { type: "rls.seed", payload: {}, businessId: A });
  const r = await base.client.query<{ n: number }>("SELECT count(*)::int AS n FROM jobs");
  assert.equal(r.rows[0].n, 0);
});

test("RLS cola: un negocio encola en su transacción y no ve los jobs de otro", async () => {
  await withTenant(db, A, (tx) => enqueue(tx, { type: "rls.mine", payload: { n: 1 }, businessId: A }));
  await withTenant(db, B, (tx) => enqueue(tx, { type: "rls.mine", payload: { n: 2 }, businessId: B }));
  await enqueue(db, { type: "rls.system", payload: {} });

  const fromA = await withTenant(db, A, (tx) => tx.select().from(jobs));
  assert.ok(fromA.length >= 1);
  assert.ok(fromA.every((j) => j.businessId === A), "A no ve los de B ni los de sistema");
  const fromB = await withTenant(db, B, (tx) => tx.select().from(jobs));
  assert.ok(fromB.every((j) => j.businessId === B));

  // Dedupe por negocio: la clave de A no choca (ni se filtra) en B.
  const keyA = await withTenant(db, A, (tx) => enqueue(tx, { type: "rls.key", payload: {}, businessId: A, dedupeKey: "k" }));
  const keyB = await withTenant(db, B, (tx) => enqueue(tx, { type: "rls.key", payload: {}, businessId: B, dedupeKey: "k" }));
  assert.equal(keyA.created && keyB.created, true);
});

test("RLS cola: con el contexto de un negocio no se encola a nombre de otro ni un job de sistema", async () => {
  await assert.rejects(
    withTenant(db, A, (tx) => enqueue(tx, { type: "rls.forged", payload: {}, businessId: B })),
    isRlsViolation,
  );
  await assert.rejects(
    withTenant(db, A, (tx) => enqueue(tx, { type: "rls.forged", payload: {} })),
    isRlsViolation,
    "tampoco uno de sistema",
  );
  const forged = rowsOf<{ n: number }>(
    await withSystem(db, (tx) => tx.execute(sql`SELECT count(*)::int AS n FROM jobs WHERE type = 'rls.forged'`)),
  );
  assert.equal(forged[0].n, 0);
});

test("RLS cola: el worker (contexto de sistema) procesa jobs de todos los negocios y los cierra", async () => {
  const seen: (string | null)[] = [];
  registerJobHandler("rls.work", async (_p, ctx) => {
    seen.push(ctx.businessId);
  });
  registerJobHandler("rls.dead", async () => {
    throw new PermanentJobError("no se puede");
  });
  await withTenant(db, A, (tx) => enqueue(tx, { type: "rls.work", payload: {}, businessId: A, groupKey: "conv" }));
  await withTenant(db, B, (tx) => enqueue(tx, { type: "rls.work", payload: {}, businessId: B }));
  await enqueue(db, { type: "rls.work", payload: {} });
  const deadA = await enqueue(db, { type: "rls.dead", payload: {}, businessId: A });

  const worker = startQueueWorker({ db, concurrency: 2, pollMs: 10, retentionDays: 1, lockTimeoutMs: 60_000 });
  try {
    await waitFor(async () => {
      const rows = rowsOf<{ n: number }>(
        await withSystem(db, (tx) =>
          tx.execute(sql`SELECT count(*)::int AS n FROM jobs WHERE type IN ('rls.work', 'rls.dead') AND status IN ('done', 'dead')`),
        ),
      );
      return rows[0].n === 4;
    }, "4 jobs cerrados");
  } finally {
    await worker.stop();
  }
  assert.deepEqual(new Set(seen), new Set([A, B, null]));

  // Operación: el DLQ de B no muestra el job muerto de A; el de sistema sí.
  assert.deepEqual(await listDeadJobs(db, { businessId: B }), []);
  assert.deepEqual((await listDeadJobs(db, { businessId: A })).map((j) => j.id), [deadA.id]);
  assert.ok((await listDeadJobs(db)).some((j) => j.id === deadA.id));
  assert.equal(await retryJob(db, deadA.id), true);
  assert.ok((await countJobs(db)).length > 0);
  assert.equal(await purgeFinishedJobs(db, new Date(Date.now() + 60_000)), 3, "purga los 3 done (contexto de sistema)");
});
