import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, afterEach, before, beforeEach, test } from "node:test";
import { eq } from "drizzle-orm";
import { withSystem } from "../../src/platform/db/scope";
import { _resetAlertsForTests, _setWebhookSenderForTests } from "../../src/platform/observability/alerts";
import { enqueue } from "../../src/platform/queue/enqueue";
import { _resetJobHandlersForTests, registerJobHandler } from "../../src/platform/queue/handlers";
import { checkQueueHealth, QUEUE_BACKLOG_ALERT, QUEUE_STUCK_ALERT } from "../../src/platform/queue/monitor";
import { jobs } from "../../src/platform/queue/schema";
import { createEphemeralDb } from "../helpers/pgliteDb";
import { silenceConsole } from "../helpers/queue";

// ─────────────────────────────────────────────────────────────────────────────
// Vigilante de la cola (src/platform/queue/monitor.ts) contra Postgres efímero, con reloj
// inyectado: jobs listos sin reclamar → `queue_backlog`; `running` sin latido →
// `queue_stuck`; al normalizarse, forgetAlert (una recaída vuelve a alertar en el acto).
// ─────────────────────────────────────────────────────────────────────────────

const base = await createEphemeralDb();
const { db } = base;
let restoreConsole: () => void;
let sent: string[] = [];
const previousUrl = process.env.ALERTS_WEBHOOK_URL;

before(() => {
  restoreConsole = silenceConsole();
});
after(async () => {
  restoreConsole();
  _setWebhookSenderForTests(null);
  if (previousUrl === undefined) delete process.env.ALERTS_WEBHOOK_URL;
  else process.env.ALERTS_WEBHOOK_URL = previousUrl;
  await base.close();
});
beforeEach(async () => {
  await base.client.exec("TRUNCATE jobs");
  _resetAlertsForTests();
  _resetJobHandlersForTests();
  sent = [];
  _setWebhookSenderForTests(async (_url, body) => {
    sent.push(body.text);
  });
  process.env.ALERTS_WEBHOOK_URL = "https://hooks.ejemplo.test/alertas";
});
afterEach(() => _resetJobHandlersForTests());

const MIN = 60_000;
const THRESHOLDS = { backlogMs: 15 * MIN, stuckMs: 10 * MIN };

/** Encola un job listo desde `runAfter` (contexto de sistema, como un job de un negocio). */
async function readyJob(type: string, runAfter: Date): Promise<string> {
  const result = await enqueue(db, { type, payload: {}, businessId: randomUUID(), runAfter });
  return result.id;
}

const ago = (now: Date, ms: number) => new Date(now.getTime() - ms);

test("cola: un job listo hace más de 15 min sin reclamar → queue_backlog (una vez); al vaciarse, forgetAlert", async () => {
  const now = new Date();
  const id = await readyJob("email.send", ago(now, 20 * MIN));
  await readyJob("email.send", ago(now, 2 * MIN)); // reciente: no cuenta
  await readyJob("email.send", new Date(now.getTime() + 60 * MIN)); // postergado (negocio pausado): no cuenta

  const first = await checkQueueHealth(db, { ...THRESHOLDS, types: ["email.send"] }, now);
  assert.equal(first.health.backlog, 1);
  assert.deepEqual(first.alerted, [QUEUE_BACKLOG_ALERT]);
  assert.match(sent[0], /🚨 .*queue_backlog: 1 job\(s\) listos sin reclamar hace más de 15 min \(el más viejo: 20 min, 1 negocio\(s\)\)/);

  const again = await checkQueueHealth(db, { ...THRESHOLDS, types: ["email.send"] }, new Date(now.getTime() + 5 * MIN));
  assert.deepEqual(again.alerted, [], "el cooldown absorbe el tick siguiente");

  // Se reclamó y terminó: la cola se normaliza y la alerta se olvida.
  await withSystem(db, (tx) => tx.update(jobs).set({ status: "done", finishedAt: now }).where(eq(jobs.id, id)));
  const ok = await checkQueueHealth(db, { ...THRESHOLDS, types: ["email.send"] }, new Date(now.getTime() + 6 * MIN));
  assert.equal(ok.health.backlog, 0);
  assert.deepEqual(ok.alerted, []);

  // Recaída: sale de nuevo en el acto, sin esperar el cooldown viejo.
  await readyJob("email.send", ago(now, 30 * MIN));
  const relapse = await checkQueueHealth(db, { ...THRESHOLDS, types: ["email.send"] }, new Date(now.getTime() + 7 * MIN));
  assert.deepEqual(relapse.alerted, [QUEUE_BACKLOG_ALERT]);
  assert.equal(sent.length, 2);
});

test("cola: el backlog solo cuenta los tipos con handler (un tipo sin registrar queda pending a propósito)", async () => {
  const now = new Date();
  await readyJob("nuevo.sin_handler", ago(now, 60 * MIN));
  registerJobHandler("email.send", async () => {});
  const result = await checkQueueHealth(db, THRESHOLDS, now); // tipos = los registrados
  assert.equal(result.health.backlog, 0);
  assert.deepEqual(result.alerted, []);

  await readyJob("email.send", ago(now, 16 * MIN));
  assert.deepEqual((await checkQueueHealth(db, THRESHOLDS, now)).alerted, [QUEUE_BACKLOG_ALERT]);
});

test("cola: job `running` sin latido hace más del umbral → queue_stuck; liberado, forgetAlert", async () => {
  const now = new Date();
  const id = await readyJob("email.send", ago(now, 30 * MIN));
  await withSystem(db, (tx) =>
    tx.update(jobs).set({ status: "running", lockedAt: ago(now, 12 * MIN), lockedBy: "worker-muerto", attempts: 1 }).where(eq(jobs.id, id)),
  );
  const result = await checkQueueHealth(db, { ...THRESHOLDS, types: ["email.send"] }, now);
  assert.equal(result.health.stuck, 1);
  assert.equal(result.health.backlog, 0, "running no es backlog");
  assert.deepEqual(result.alerted, [QUEUE_STUCK_ALERT]);
  assert.match(sent[0], /queue_stuck: 1 job\(s\) en running sin latido hace más de 10 min \(el más viejo: 12 min\)/);

  // Con latido reciente no cuenta.
  await withSystem(db, (tx) => tx.update(jobs).set({ lockedAt: ago(now, 1 * MIN) }).where(eq(jobs.id, id)));
  assert.equal((await checkQueueHealth(db, { ...THRESHOLDS, types: ["email.send"] }, now)).health.stuck, 0);
  // Recaída inmediata tras normalizarse: vuelve a salir.
  await withSystem(db, (tx) => tx.update(jobs).set({ lockedAt: ago(now, 20 * MIN) }).where(eq(jobs.id, id)));
  assert.deepEqual((await checkQueueHealth(db, { ...THRESHOLDS, types: ["email.send"] }, now)).alerted, [QUEUE_STUCK_ALERT]);
});

test("cola: el umbral de atascado nunca baja del lock + 1 min (la recuperación normal no alerta)", async () => {
  process.env.ALERTS_QUEUE_STUCK_MIN = "1";
  try {
    const { queueMonitorThresholdsFromEnv } = await import("../../src/platform/queue/monitor");
    assert.equal(queueMonitorThresholdsFromEnv().stuckMs, 5 * MIN + MIN, "default QUEUE_LOCK_TIMEOUT_MS = 5 min");
  } finally {
    delete process.env.ALERTS_QUEUE_STUCK_MIN;
  }
});
