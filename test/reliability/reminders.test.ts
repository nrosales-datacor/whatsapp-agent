import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, test } from "node:test";
import { and, eq } from "drizzle-orm";
import { registerJobHandlers } from "../../src/jobs";
import {
  bookAppointment,
  cancelAppointment,
  handleReminderJob,
  REMINDER_SEND_JOB,
  rescheduleAppointment,
  sweepDueReminders,
} from "../../src/modules/scheduling";
import { reminders } from "../../src/modules/scheduling/schema";
import { withSystem, withTenant } from "../../src/platform/db/scope";
import { clearTestOutbox, getTestOutbox } from "../../src/platform/email/email";
import { _resetShutdownForTests } from "../../src/platform/net/shutdown";
import { _resetJobHandlersForTests } from "../../src/platform/queue/handlers";
import { jobs } from "../../src/platform/queue/schema";
import { startQueueWorker, type QueueWorker } from "../../src/platform/queue/worker";
import { createEphemeralDb } from "../helpers/pgliteDb";
import { silenceConsole, sleep, waitFor } from "../helpers/queue";
import { createSchedulingWorld, crAt, crDay, type SchedulingWorld } from "../helpers/schedulingFixtures";

// ─────────────────────────────────────────────────────────────────────────────
// Recordatorios de punta a punta: reservar programa las filas → el barrido (lo que corre
// el loop con lease) encola `reminder.send` → el worker real elige el canal y encola el
// correo en la MISMA transacción (outbox) → el job `email.send` lo deja en el outbox de
// pruebas. Idempotencia (barrer y correr dos veces no duplica), reprogramar deja sin
// efecto el job viejo, cancelar invalida y lo de una cita que ya empezó vence.
// ─────────────────────────────────────────────────────────────────────────────

const base = await createEphemeralDb();
const { db } = base;
let w: SchedulingWorld;
let worker: QueueWorker | null = null;
let restoreConsole: () => void;

before(async () => {
  restoreConsole = silenceConsole();
  await base.client.exec("SET ROLE app_runtime");
  w = await createSchedulingWorld(db);
});
after(async () => {
  restoreConsole();
  await base.close();
});
beforeEach(() => {
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

function startWorker() {
  worker = startQueueWorker({ db, concurrency: 1, pollMs: 10, retentionDays: 0 });
}

const book = (clientId: string, date: string, hm: string) =>
  bookAppointment(db, w.businessId, {
    locationId: w.escazu,
    clientId,
    serviceIds: [w.limpieza],
    staffId: w.ana,
    startsAt: crAt(date, hm),
    channel: "panel",
  });

async function reminderOf(appointmentId: string, kind: "day_before" | "same_day") {
  const [row] = await withTenant(db, w.businessId, (tx) =>
    tx
      .select()
      .from(reminders)
      .where(and(eq(reminders.businessId, w.businessId), eq(reminders.appointmentId, appointmentId), eq(reminders.kind, kind))),
  );
  assert.ok(row, `no hay recordatorio ${kind}`);
  return row;
}

const reminderJobs = () => withSystem(db, (tx) => tx.select().from(jobs).where(eq(jobs.type, REMINDER_SEND_JOB)));
const allDone = async () => (await reminderJobs()).every((j) => j.status === "done");
const plusMinute = (d: Date) => new Date(d.getTime() + 60_000);

test("el del día anterior sale por correo (sin WhatsApp conectado) una sola vez", async () => {
  const appt = await book(w.maria, crDay(3), "10:00");
  const dayBefore = await reminderOf(appt.id, "day_before");
  const sameDay = await reminderOf(appt.id, "same_day");
  assert.equal(dayBefore.status, "pending");

  const first = await sweepDueReminders(db, { now: plusMinute(dayBefore.scheduledFor) });
  assert.ok(first.enqueued >= 1);
  startWorker();
  await waitFor(() => getTestOutbox().some((m) => m.to === "maria@example.com"), "recordatorio en el outbox");
  const mail = getTestOutbox().find((m) => m.to === "maria@example.com");
  assert.match(mail!.subject, /Recordatorio de su cita en Estética Agenda/);
  assert.match(mail!.text, /Limpieza/);
  assert.match(mail!.text, /Ana/);
  assert.match(mail!.text, /Escazú/);

  const sent = await reminderOf(appt.id, "day_before");
  assert.equal(sent.status, "sent");
  assert.equal(sent.channel, "email");
  assert.ok(sent.sentAt);
  assert.equal((await reminderOf(appt.id, "same_day")).status, "pending", "el del mismo día todavía no toca");

  // Idempotencia: barrer otra vez no encola nada y correr el job de nuevo no hace nada.
  const again = await sweepDueReminders(db, { now: plusMinute(dayBefore.scheduledFor) });
  assert.equal(again.enqueued, 0);
  const outcome = await handleReminderJob(
    { reminderId: dayBefore.id, scheduledFor: dayBefore.scheduledFor.toISOString() },
    { db, businessId: w.businessId },
  );
  assert.equal(outcome, "noop");
  await sleep(150);
  assert.equal(getTestOutbox().filter((m) => m.to === "maria@example.com").length, 1);
  await cancelAppointment(db, w.businessId, appt.id, null);
  assert.equal((await reminderOf(appt.id, "same_day")).status, "cancelled");
  assert.ok(sameDay);
});

test("sin correo y sin WhatsApp conectado: queda pendiente (I2) y el barrido no lo repite", async () => {
  const appt = await book(w.sofia, crDay(3), "15:00");
  const dayBefore = await reminderOf(appt.id, "day_before");
  await sweepDueReminders(db, { now: plusMinute(dayBefore.scheduledFor) });
  startWorker();
  await waitFor(allDone, "jobs de recordatorio terminados");
  const row = await reminderOf(appt.id, "day_before");
  assert.equal(row.status, "pending");
  assert.equal(row.channel, "whatsapp");
  assert.equal(row.error, "whatsapp_pending");
  assert.equal(getTestOutbox().length, 0);
  const again = await sweepDueReminders(db, { now: plusMinute(dayBefore.scheduledFor) });
  assert.equal(again.enqueued, 0);
  // Cuando la cita ya empezó, vence.
  const expired = await sweepDueReminders(db, { now: plusMinute(new Date(appt.startsAt)) });
  assert.ok(expired.expired >= 1);
  assert.equal((await reminderOf(appt.id, "day_before")).status, "skipped");
});

test("reprogramar deja sin efecto el job ya encolado y programa el nuevo", async () => {
  const day = crDay(4);
  const appt = await book(w.maria, day, "09:00");
  const old = await reminderOf(appt.id, "same_day");
  await sweepDueReminders(db, { now: plusMinute(old.scheduledFor) });
  // Antes de que el worker lo corra, la cita pasa a la tarde.
  await rescheduleAppointment(db, w.businessId, appt.id, { startsAt: crAt(day, "16:00") });
  const fresh = await reminderOf(appt.id, "same_day");
  assert.equal(fresh.scheduledFor.toISOString(), crAt(day, "14:00").toISOString());
  assert.equal(fresh.status, "pending");
  startWorker();
  await waitFor(allDone, "jobs de recordatorio terminados");
  await sleep(150);
  // Sale solo el del día anterior (su hora no cambió: el día anterior a las 17:00); el del
  // mismo día con la hora vieja no hace nada y el nuevo sigue pendiente.
  assert.equal(getTestOutbox().length, 1);
  assert.equal((await reminderOf(appt.id, "day_before")).status, "sent");
  assert.equal((await reminderOf(appt.id, "same_day")).status, "pending");
  await cancelAppointment(db, w.businessId, appt.id, null);
});

test("cancelar invalida los pendientes: el barrido no los toma", async () => {
  const appt = await book(w.maria, crDay(5), "11:00");
  const dayBefore = await reminderOf(appt.id, "day_before");
  await cancelAppointment(db, w.businessId, appt.id, "No puede venir");
  assert.equal((await reminderOf(appt.id, "day_before")).status, "cancelled");
  const before = (await reminderJobs()).length;
  await sweepDueReminders(db, { now: plusMinute(dayBefore.scheduledFor) });
  assert.equal((await reminderJobs()).filter((j) => (j.payload as { reminderId?: string }).reminderId === dayBefore.id).length, 0);
  assert.ok((await reminderJobs()).length >= before);
});

test("un negocio sin canales activos no programa recordatorios", async () => {
  const quiet = await createSchedulingWorld(db, { reminderChannels: [] });
  const appt = await bookAppointment(db, quiet.businessId, {
    locationId: quiet.escazu,
    clientId: quiet.maria,
    serviceIds: [quiet.limpieza],
    staffId: quiet.ana,
    startsAt: crAt(crDay(3), "10:00"),
    channel: "panel",
  });
  const rows = await withTenant(db, quiet.businessId, (tx) => tx.select().from(reminders).where(eq(reminders.appointmentId, appt.id)));
  assert.equal(rows.length, 0);
});
