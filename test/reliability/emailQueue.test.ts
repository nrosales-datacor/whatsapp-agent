import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, test } from "node:test";
import { registerJobHandlers } from "../../src/jobs";
import { withSystem } from "../../src/platform/db/scope";
import { clearTestOutbox, getTestOutbox } from "../../src/platform/email/email";
import { queueEmail } from "../../src/platform/email/enqueue";
import { _resetShutdownForTests } from "../../src/platform/net/shutdown";
import { _resetJobHandlersForTests } from "../../src/platform/queue/handlers";
import { startQueueWorker, type QueueWorker } from "../../src/platform/queue/worker";
import { createEphemeralDb, type EphemeralDb } from "../helpers/pgliteDb";
import { silenceConsole, waitFor } from "../helpers/queue";

// ─────────────────────────────────────────────────────────────────────────────
// Correo por la cola de punta a punta: queueEmail encola el job (atómico con la
// transacción que lo origina), el worker lo corre con el handler de src/jobs.ts y el
// proveedor `log` lo deja en el outbox de pruebas.
// ─────────────────────────────────────────────────────────────────────────────

let base: EphemeralDb;
let restoreConsole: () => void;
let worker: QueueWorker | null = null;

const message = { to: "dueno@ejemplo.com", subject: "Hola", html: "<p>Hola</p>", text: "Hola" };

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
  _resetShutdownForTests();
  clearTestOutbox();
  registerJobHandlers();
});

afterEach(async () => {
  await worker?.stop();
  worker = null;
  _resetShutdownForTests();
});

test("un correo encolado lo manda el worker", async () => {
  await queueEmail(base.db, message);
  worker = startQueueWorker({ db: base.db, concurrency: 1, pollMs: 10, retentionDays: 0 });
  await waitFor(() => getTestOutbox().length === 1, "correo en el outbox");
  assert.equal(getTestOutbox()[0].to, message.to);
});

test("si la transacción que lo encola se revierte, el correo no sale", async () => {
  await assert.rejects(
    withSystem(base.db, async (tx) => {
      await queueEmail(tx, message);
      throw new Error("rollback a propósito");
    }),
  );
  worker = startQueueWorker({ db: base.db, concurrency: 1, pollMs: 10, retentionDays: 0 });
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(getTestOutbox().length, 0);
});

test("la misma dedupeKey no encola dos veces", async () => {
  const first = await queueEmail(base.db, message, { dedupeKey: "bienvenida-1" });
  const second = await queueEmail(base.db, message, { dedupeKey: "bienvenida-1" });
  assert.equal(first.created, true);
  assert.equal(second.created, false);
});
