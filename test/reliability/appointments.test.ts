import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { and, eq } from "drizzle-orm";
import { getClient } from "../../src/modules/clients";
import {
  bookAppointment,
  cancelAppointment,
  completeAppointment,
  confirmAppointment,
  findSlots,
  listUpcomingAppointmentsForClient,
  markNoShow,
  reassignStaff,
  rescheduleAppointment,
} from "../../src/modules/scheduling";
import { reminders } from "../../src/modules/scheduling/schema";
import { localDayBounds } from "../../src/modules/scheduling/time";
import { timeOff } from "../../src/modules/team/schema";
import { withTenant } from "../../src/platform/db/scope";
import { HttpError, ValidationError } from "../../src/platform/http/errors";
import { createEphemeralDb } from "../helpers/pgliteDb";
import { createSchedulingWorld, CR, crAt, crDay, type SchedulingWorld } from "../helpers/schedulingFixtures";

// ─────────────────────────────────────────────────────────────────────────────
// Servicio de citas sobre Postgres real (PGlite) con el rol de la app (RLS): reservar con
// copia de las líneas, reservas simultáneas (una gana, las otras 409 por el EXCLUDE),
// "cualquiera", transiciones válidas e inválidas, completar refresca la caché del cliente,
// reprogramar y reasignar, y los recordatorios que se programan y se invalidan.
// ─────────────────────────────────────────────────────────────────────────────

const base = await createEphemeralDb();
const { db } = base;
after(() => base.close());

let w: SchedulingWorld;
before(async () => {
  await base.client.exec("SET ROLE app_runtime");
  w = await createSchedulingWorld(db);
});

/** Día de prueba: dentro de 3 días (los recordatorios quedan en el futuro). */
const DAY = crDay(3);

const isHttp = (status: number, code: string) => (e: unknown) => e instanceof HttpError && e.status === status && e.code === code;
const isField = (field: string) => (e: unknown) => e instanceof ValidationError && field in e.fields;

function book(overrides: Partial<Parameters<typeof bookAppointment>[2]> = {}) {
  return bookAppointment(db, w.businessId, {
    locationId: w.escazu,
    clientId: w.maria,
    serviceIds: [w.limpieza],
    staffId: w.ana,
    startsAt: crAt(DAY, "09:00"),
    channel: "panel",
    ...overrides,
  });
}

function remindersOf(appointmentId: string) {
  return withTenant(db, w.businessId, (tx) =>
    tx.select().from(reminders).where(and(eq(reminders.businessId, w.businessId), eq(reminders.appointmentId, appointmentId))),
  );
}

test("reservar: líneas con copia, total y fin con el buffer; queda pendiente con sus recordatorios", async () => {
  const appt = await book({ serviceIds: [w.manicura, w.pedicura], startsAt: crAt(DAY, "08:00"), notes: "  Primera vez  " });
  assert.equal(appt.status, "pending");
  assert.equal(appt.channel, "panel");
  assert.equal(appt.staffId, w.ana);
  assert.equal(appt.notes, "Primera vez");
  // 40 + 5 + 60 de trabajo y 10 de buffer final.
  assert.equal(appt.endsAt, crAt(DAY, "09:55").toISOString());
  assert.equal(appt.totalCents, 2_000_000);
  assert.deepEqual(
    appt.services.map((l) => [l.name, l.durationMin, l.priceCents, l.position]),
    [
      ["Manicura", 40, 800_000, 0],
      ["Pedicura", 60, 1_200_000, 1],
    ],
  );
  assert.equal(appt.client?.name, "María Fernández");
  assert.equal(appt.location?.timezone, CR);
  const rows = await remindersOf(appt.id);
  assert.deepEqual(rows.map((r) => r.kind).sort(), ["day_before", "same_day"]);
  assert.ok(rows.every((r) => r.status === "pending" && r.channel === "whatsapp"));
  await cancelAppointment(db, w.businessId, appt.id, "limpieza del test");
});

test("reservas simultáneas al mismo horario: una gana y las demás reciben 409 slot_taken", async () => {
  const startsAt = crAt(DAY, "10:00");
  const results = await Promise.allSettled([book({ startsAt }), book({ startsAt }), book({ startsAt, clientId: w.sofia })]);
  const ok = results.filter((r) => r.status === "fulfilled");
  const failed = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
  assert.equal(ok.length, 1);
  assert.equal(failed.length, 2);
  for (const f of failed) assert.ok(isHttp(409, "slot_taken")(f.reason), String(f.reason));
  // Otra hora que pisa el buffer (10:00–11:10) tampoco entra.
  await assert.rejects(book({ startsAt: crAt(DAY, "11:00") }), isHttp(409, "slot_taken"));
  await cancelAppointment(db, w.businessId, (ok[0] as PromiseFulfilledResult<{ id: string }>).value.id, null);
});

test('"cualquiera": toma al primero libre, con las condiciones de esa persona', async () => {
  const startsAt = crAt(DAY, "14:00");
  const first = await book({ staffId: "any", startsAt });
  assert.equal(first.staffId, w.ana, "en el orden de la agenda");
  const second = await book({ staffId: "any", startsAt, clientId: w.sofia });
  assert.equal(second.staffId, w.beto);
  assert.equal(second.totalCents, 3_000_000, "precio propio de Beto");
  assert.equal(second.endsAt, crAt(DAY, "14:55").toISOString(), "45 min propios + 10 de buffer");
  await assert.rejects(book({ staffId: "any", startsAt }), isHttp(409, "slot_taken"));
  // Manicura: Beto no la hace → con Ana ocupada no hay nadie.
  await assert.rejects(book({ staffId: "any", startsAt, serviceIds: [w.manicura] }), isHttp(409, "slot_taken"));
  for (const a of [first, second]) await cancelAppointment(db, w.businessId, a.id, null);
});

test("horario, ausencias, servicios y margen: 400 por campo", async () => {
  await assert.rejects(book({ startsAt: crAt(DAY, "12:30") }), isField("startsAt"));
  await assert.rejects(book({ staffId: w.beto, startsAt: crAt(DAY, "09:00") }), isField("startsAt"));
  await assert.rejects(book({ staffId: w.beto, serviceIds: [w.manicura], startsAt: crAt(DAY, "15:00") }), isField("staffId"));
  await assert.rejects(book({ serviceIds: [w.limpieza, w.limpieza] }), isField("serviceIds"));
  await assert.rejects(book({ clientId: "00000000-0000-4000-8000-000000000000" }), isField("clientId"));
  // El agente no agenda servicios "solo panel" ni dentro del margen mínimo.
  await assert.rejects(book({ channel: "whatsapp_ai", serviceIds: [w.masaje], startsAt: crAt(DAY, "15:00") }), isField("serviceIds"));
  await assert.rejects(book({ channel: "whatsapp_ai", startsAt: new Date(Date.now() + 10 * 60_000) }), isField("startsAt"));
  // Ausencia de Ana ese día de 15 a 17.
  await withTenant(db, w.businessId, (tx) =>
    tx.insert(timeOff).values({ businessId: w.businessId, staffId: w.ana, startsAt: crAt(DAY, "15:00"), endsAt: crAt(DAY, "17:00"), reason: "Médico" }),
  );
  await assert.rejects(book({ startsAt: crAt(DAY, "15:30") }), isField("startsAt"));
  // Fuera de horario a propósito (el equipo, nunca el agente): entra.
  const late = await book({ startsAt: crAt(DAY, "20:00"), allowOutsideHours: true });
  assert.equal(late.startsAt, crAt(DAY, "20:00").toISOString());
  await assert.rejects(book({ startsAt: crAt(DAY, "20:00"), allowOutsideHours: true, channel: "whatsapp_ai" }), isField("startsAt"));
  await cancelAppointment(db, w.businessId, late.id, null);
});

test("findSlots: la cita reservada deja de ofrecerse y se puede excluir al reprogramar", async () => {
  const day = crDay(4);
  const { start, end } = localDayBounds(day, CR);
  const appt = await book({ startsAt: crAt(day, "09:00") });
  const slots = await findSlots(db, w.businessId, { locationId: w.escazu, serviceIds: [w.limpieza], staffId: w.ana, from: start, to: end });
  const times = slots.map((s) => s.startsAt.toISOString());
  assert.ok(!times.includes(crAt(day, "09:00").toISOString()));
  assert.ok(times.includes(crAt(day, "10:15").toISOString()));
  const again = await findSlots(db, w.businessId, {
    locationId: w.escazu,
    serviceIds: [w.limpieza],
    staffId: w.ana,
    from: start,
    to: end,
    excludeAppointmentId: appt.id,
  });
  assert.ok(again.some((s) => s.startsAt.getTime() === crAt(day, "09:00").getTime()));
  await assert.rejects(
    findSlots(db, w.businessId, { locationId: w.escazu, serviceIds: [w.limpieza], from: start, to: new Date(start.getTime() + 40 * 86_400_000) }),
    isField("to"),
  );
  await cancelAppointment(db, w.businessId, appt.id, null);
});

test("transiciones: válidas e inválidas (409), y no-show/completar antes de empezar", async () => {
  const day = crDay(7);
  const appt = await book({ startsAt: crAt(day, "16:00") });
  await assert.rejects(completeAppointment(db, w.businessId, appt.id), isHttp(409, "too_early"));
  await assert.rejects(markNoShow(db, w.businessId, appt.id), isHttp(409, "too_early"));
  const confirmed = await confirmAppointment(db, w.businessId, appt.id);
  assert.equal(confirmed.status, "confirmed");
  assert.ok(confirmed.confirmedAt);
  await assert.rejects(confirmAppointment(db, w.businessId, appt.id), isHttp(409, "invalid_transition"));
  const cancelled = await cancelAppointment(db, w.businessId, appt.id, "La clienta avisó");
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.cancellationReason, "La clienta avisó");
  for (const op of [
    () => confirmAppointment(db, w.businessId, appt.id),
    () => cancelAppointment(db, w.businessId, appt.id, null),
    () => completeAppointment(db, w.businessId, appt.id, { now: new Date(Date.now() + 10 * 86_400_000) }),
    () => rescheduleAppointment(db, w.businessId, appt.id, { startsAt: crAt(day, "17:00") }),
  ]) {
    await assert.rejects(op(), isHttp(409, "invalid_transition"));
  }
  // Cancelar invalida los recordatorios pendientes y libera el horario.
  assert.ok((await remindersOf(appt.id)).every((r) => r.status === "cancelled"));
  const again = await book({ startsAt: crAt(day, "16:00") });
  await cancelAppointment(db, w.businessId, again.id, null);
});

test("completar refresca visitas del cliente (valores absolutos) en la misma transacción", async () => {
  const past1 = await book({ clientId: w.sofia, startsAt: crAt(crDay(-10), "09:00"), allowOutsideHours: true });
  const past2 = await book({ clientId: w.sofia, startsAt: crAt(crDay(-2), "09:00"), allowOutsideHours: true });
  await completeAppointment(db, w.businessId, past2.id);
  let client = await getClient(db, w.businessId, w.sofia);
  assert.equal(client?.visitCount, 1);
  assert.equal(client?.firstVisitAt, past2.startsAt);
  await completeAppointment(db, w.businessId, past1.id);
  client = await getClient(db, w.businessId, w.sofia);
  assert.equal(client?.visitCount, 2);
  assert.equal(client?.firstVisitAt, past1.startsAt);
  assert.equal(client?.lastVisitAt, past2.startsAt);
  await assert.rejects(completeAppointment(db, w.businessId, past1.id), isHttp(409, "invalid_transition"));
  // No-show de una que ya pasó: no suma visitas.
  const missed = await book({ clientId: w.sofia, startsAt: crAt(crDay(-1), "09:00"), allowOutsideHours: true });
  assert.equal((await markNoShow(db, w.businessId, missed.id)).status, "no_show");
  assert.equal((await getClient(db, w.businessId, w.sofia))?.visitCount, 2);
});

test("reprogramar mueve la cita y sus recordatorios; reasignar usa las condiciones del otro profesional", async () => {
  const day = crDay(5);
  const appt = await book({ startsAt: crAt(day, "09:00") });
  const before = await remindersOf(appt.id);
  const moved = await rescheduleAppointment(db, w.businessId, appt.id, { startsAt: crAt(day, "15:00") });
  assert.equal(moved.startsAt, crAt(day, "15:00").toISOString());
  assert.equal(moved.endsAt, crAt(day, "16:10").toISOString());
  const after = await remindersOf(appt.id);
  const sameDay = (rows: typeof before) => rows.find((r) => r.kind === "same_day");
  assert.notEqual(sameDay(after)?.scheduledFor.getTime(), sameDay(before)?.scheduledFor.getTime());
  assert.equal(sameDay(after)?.scheduledFor.toISOString(), crAt(day, "13:00").toISOString());
  assert.equal(sameDay(after)?.status, "pending");

  // Pisar otra cita: 409; fuera de horario: 400.
  const other = await book({ startsAt: crAt(day, "17:00"), clientId: w.sofia });
  await assert.rejects(rescheduleAppointment(db, w.businessId, appt.id, { startsAt: crAt(day, "16:30") }), isHttp(409, "slot_taken"));
  await assert.rejects(rescheduleAppointment(db, w.businessId, appt.id, { startsAt: crAt(day, "12:15") }), isField("startsAt"));

  const reassigned = await reassignStaff(db, w.businessId, appt.id, w.beto);
  assert.equal(reassigned.staffId, w.beto);
  assert.equal(reassigned.totalCents, 3_000_000);
  assert.equal(reassigned.endsAt, crAt(day, "15:55").toISOString());
  assert.deepEqual(reassigned.services.map((l) => [l.durationMin, l.priceCents]), [[45, 3_000_000]]);
  // Beto no trabaja de mañana ni hace manicura.
  await assert.rejects(rescheduleAppointment(db, w.businessId, appt.id, { startsAt: crAt(day, "09:00") }), isField("startsAt"));
  const mani = await book({ serviceIds: [w.manicura], startsAt: crAt(day, "10:00") });
  await assert.rejects(reassignStaff(db, w.businessId, mani.id, w.beto), isField("staffId"));
  for (const a of [appt, other, mani]) await cancelAppointment(db, w.businessId, a.id, null);
});

test("próximas citas de un cliente (agente): solo vivas y futuras, en orden", async () => {
  const day = crDay(6);
  const a = await book({ startsAt: crAt(day, "15:00") });
  const b = await book({ startsAt: crAt(day, "09:00") });
  const c = await book({ startsAt: crAt(day, "17:00") });
  await cancelAppointment(db, w.businessId, c.id, null);
  const upcoming = await listUpcomingAppointmentsForClient(db, w.businessId, w.maria);
  const ids = upcoming.map((x) => x.id);
  assert.ok(ids.indexOf(b.id) < ids.indexOf(a.id));
  assert.ok(!ids.includes(c.id));
  for (const x of [a, b]) await cancelAppointment(db, w.businessId, x.id, null);
});
