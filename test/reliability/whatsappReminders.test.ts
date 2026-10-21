import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, test } from "node:test";
import { and, eq } from "drizzle-orm";

// ─────────────────────────────────────────────────────────────────────────────
// Recordatorios de cita por WhatsApp de punta a punta: reservar → el barrido encola
// `reminder.send` → scheduling elige WhatsApp (número conectado, inyectado desde la
// composición) y encola `whatsapp.reminder` en la misma transacción → el job manda texto
// con botones (ventana de 24 h abierta) o la plantilla aprobada (cerrada); sin plantilla
// fuera de la ventana queda registrada la falla. El "Confirmo" del cliente confirma la
// cita. Con el token vencido, el recordatorio cae al correo.
// ─────────────────────────────────────────────────────────────────────────────

process.env.TOKENS_ENCRYPTION_KEY = "d".repeat(64);

const { registerJobHandlers } = await import("../../src/jobs");
const { bookAppointment, getAppointment, sweepDueReminders } = await import("../../src/modules/scheduling");
const { appointments, reminders } = await import("../../src/modules/scheduling/schema");
const { whatsappChannels } = await import("../../src/modules/whatsapp/schema");
const { processWebhookBody } = await import("../../src/modules/whatsapp/webhook");
const { getAiUsage } = await import("../../src/modules/whatsapp/usage");
const { _resetChannelStateForTests } = await import("../../src/modules/whatsapp/channels");
const { withTenant } = await import("../../src/platform/db/scope");
const { clearTestOutbox, getTestOutbox } = await import("../../src/platform/email/email");
const { _resetShutdownForTests } = await import("../../src/platform/net/shutdown");
const { _resetJobHandlersForTests } = await import("../../src/platform/queue/handlers");
const { startQueueWorker } = await import("../../src/platform/queue/worker");
const { createEphemeralDb } = await import("../helpers/pgliteDb");
const { allJobs, silenceConsole, waitFor } = await import("../helpers/queue");
const { createSchedulingWorld, crAt, crDay } = await import("../helpers/schedulingFixtures");
const { createChannel, fakeWhatsApp, inboundBody } = await import("../helpers/whatsappFixtures");

const base = await createEphemeralDb();
const { db } = base;
let restoreConsole: () => void;
let fake: ReturnType<typeof fakeWhatsApp>;

before(async () => {
  restoreConsole = silenceConsole();
  await base.client.exec("SET ROLE app_runtime");
});
after(async () => {
  restoreConsole();
  await base.close();
});
beforeEach(() => {
  _resetJobHandlersForTests();
  _resetShutdownForTests();
  _resetChannelStateForTests();
  clearTestOutbox();
  fake = fakeWhatsApp(db);
  registerJobHandlers({ whatsapp: fake.deps });
});
afterEach(() => _resetShutdownForTests());

async function drain(): Promise<void> {
  const worker = startQueueWorker({ db, concurrency: 1, pollMs: 10, retentionDays: 0 });
  try {
    await waitFor(async () => (await allJobs(db)).every((j) => j.status === "done" || j.status === "dead"), "cola vacía", 30_000);
  } finally {
    await worker.stop();
  }
  const dead = (await allJobs(db)).filter((j) => j.status === "dead");
  assert.equal(dead.length, 0, `jobs en dead: ${dead.map((d) => d.lastError).join(" | ")}`);
}

async function setup(templates: Record<string, { name: string; language: string }> = {}) {
  const w = await createSchedulingWorld(db);
  const channel = await createChannel(db, w.businessId, { templates });
  return { ...w, ...channel };
}
type World = Awaited<ReturnType<typeof setup>>;

async function bookAndSend(w: World, clientId: string) {
  const appt = await bookAppointment(db, w.businessId, {
    locationId: w.escazu,
    clientId,
    serviceIds: [w.limpieza],
    staffId: w.ana,
    startsAt: crAt(crDay(3), "10:00"),
    channel: "panel",
  });
  const [dayBefore] = await withTenant(db, w.businessId, (tx) =>
    tx.select().from(reminders).where(and(eq(reminders.appointmentId, appt.id), eq(reminders.kind, "day_before"))),
  );
  await sweepDueReminders(db, { now: new Date(dayBefore.scheduledFor.getTime() + 60_000) });
  await drain();
  const [after] = await withTenant(db, w.businessId, (tx) => tx.select().from(reminders).where(eq(reminders.id, dayBefore.id)));
  return { appt, reminder: after };
}

test("ventana abierta: texto con botones Confirmo/Cancelar, y el «Confirmo» confirma la cita", async () => {
  const w = await setup();
  // Sofía escribió hace un rato: la ventana de 24 h está abierta.
  await processWebhookBody(db, inboundBody({ phoneNumberId: w.phoneNumberId, from: "50688880002", text: "hola" }));
  await drain();
  fake.sent.length = 0;

  const { appt, reminder } = await bookAndSend(w, w.sofia);
  assert.equal(reminder.status, "sent");
  assert.equal(reminder.channel, "whatsapp");
  const [msg] = fake.sent;
  assert.equal(msg.kind, "buttons");
  assert.equal(msg.to, "+50688880002");
  assert.match(msg.text!, /Te recordamos tu cita en Estética Agenda mañana .* a las 10:00: Limpieza/);
  assert.deepEqual(msg.buttons?.map((b) => b.id), [`confirm|${appt.id}`, `cancel|${appt.id}`]);

  await withTenant(db, w.businessId, (tx) => tx.update(appointments).set({ status: "pending" }).where(eq(appointments.id, appt.id)));
  await processWebhookBody(
    db,
    inboundBody({
      phoneNumberId: w.phoneNumberId,
      from: "50688880002",
      type: "interactive",
      message: { interactive: { type: "button_reply", button_reply: { id: `confirm|${appt.id}`, title: "Confirmo ✅" } } },
    }),
  );
  await drain();
  assert.equal((await getAppointment(db, w.businessId, appt.id))?.status, "confirmed");
  assert.match(fake.sent.at(-1)!.text!, /Gracias por confirmar tu cita/);
});

test("ventana cerrada: plantilla aprobada con variables y payloads; el botón de la plantilla confirma", async () => {
  const w = await setup({ reminder: { name: "recordatorio_cita", language: "es" } });
  const { appt, reminder } = await bookAndSend(w, w.maria);
  assert.equal(reminder.status, "sent");
  const [msg] = fake.sent;
  assert.equal(msg.kind, "template");
  assert.equal(msg.template?.name, "recordatorio_cita");
  assert.deepEqual(msg.template?.bodyParams?.slice(0, 2), ["María Fernández", "Limpieza"]);
  assert.match(msg.template!.bodyParams![2], /^mañana .* a las 10:00$/);
  assert.deepEqual(msg.template?.quickReplyPayloads, [`confirm|${appt.id}`, `cancel|${appt.id}`]);
  assert.equal(getTestOutbox().length, 0, "no salió además por correo");
  assert.equal((await getAiUsage(db, w.businessId)).utilityTemplates, 1);

  await withTenant(db, w.businessId, (tx) => tx.update(appointments).set({ status: "pending" }).where(eq(appointments.id, appt.id)));
  await processWebhookBody(
    db,
    inboundBody({ phoneNumberId: w.phoneNumberId, from: "50688880001", type: "button", message: { button: { payload: `confirm|${appt.id}`, text: "Confirmo" } } }),
  );
  await drain();
  assert.equal((await getAppointment(db, w.businessId, appt.id))?.status, "confirmed");
});

test("ventana cerrada sin plantilla: el recordatorio queda como fallido (sin enviar nada)", async () => {
  const w = await setup();
  const { reminder } = await bookAndSend(w, w.sofia);
  assert.equal(reminder.status, "failed");
  assert.equal(reminder.error, "whatsapp_no_template");
  assert.equal(fake.sent.length, 0);
});

test("token vencido (canal desconectado): el recordatorio cae al correo del cliente", async () => {
  const w = await setup();
  await withTenant(db, w.businessId, (tx) => tx.update(whatsappChannels).set({ status: "disconnected" }).where(eq(whatsappChannels.id, w.channelId)));
  const { reminder } = await bookAndSend(w, w.maria);
  assert.equal(reminder.status, "sent");
  assert.equal(reminder.channel, "email");
  assert.equal(fake.sent.length, 0);
  await waitFor(() => getTestOutbox().some((m) => m.to === "maria@example.com"), "recordatorio por correo");
});
