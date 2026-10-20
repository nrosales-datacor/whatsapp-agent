import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { eq } from "drizzle-orm";
import { appointments, type NewAppointment } from "../../src/modules/scheduling/schema";
import { withTenant } from "../../src/platform/db/scope";
import { appointmentValues, createBusinessFixture, hasPgCode, type BusinessFixture } from "../helpers/domainFixtures";
import { createEphemeralDb } from "../helpers/pgliteDb";

// ─────────────────────────────────────────────────────────────────────────────
// Anti-solape de citas EN LA BASE (drizzle/0002_domain_constraints.sql):
//   EXCLUDE USING gist (staff_id WITH =, tstzrange(starts_at, ends_at, '[)') WITH &&)
//   WHERE (status IN ('pending', 'confirmed'))
// más CHECK (ends_at > starts_at). Es la red contra la doble reserva aunque dos procesos
// pasen el chequeo de disponibilidad a la vez. Corre con el rol de la app (sin BYPASSRLS).
// ─────────────────────────────────────────────────────────────────────────────

const base = await createEphemeralDb();
const { db } = base;
after(() => base.close());

const EXCLUSION_VIOLATION = "23P01";
const CHECK_VIOLATION = "23514";

let f: BusinessFixture;

before(async () => {
  await base.client.exec("SET ROLE app_runtime");
  f = await createBusinessFixture(db, { staffCount: 2 });
});

function insert(...values: NewAppointment[]): Promise<{ id: string }[]> {
  return withTenant(db, f.businessId, (tx) => tx.insert(appointments).values(values).returning({ id: appointments.id }));
}

const isOverlap = (e: unknown) => hasPgCode(e, EXCLUSION_VIOLATION);

test("EXCLUDE: dos citas solapadas del mismo profesional → error (también solape parcial y pendiente contra confirmada)", async () => {
  await insert(appointmentValues(f, "2026-11-02T15:00:00Z", 60));
  await assert.rejects(insert(appointmentValues(f, "2026-11-02T15:00:00Z", 60)), isOverlap, "mismo horario exacto");
  await assert.rejects(insert(appointmentValues(f, "2026-11-02T15:30:00Z", 60)), isOverlap, "solape parcial");
  await assert.rejects(insert(appointmentValues(f, "2026-11-02T14:00:00Z", 180)), isOverlap, "una que envuelve a la otra");
  await assert.rejects(
    insert(appointmentValues(f, "2026-11-02T15:45:00Z", 30, { status: "pending" })),
    isOverlap,
    "una pendiente también ocupa la agenda",
  );
});

test("EXCLUDE: rango semiabierto — una que termina 10:00 y otra que empieza 10:00 no chocan", async () => {
  await insert(appointmentValues(f, "2026-11-03T15:00:00Z", 60), appointmentValues(f, "2026-11-03T16:00:00Z", 60));
});

test("EXCLUDE: profesionales distintos al mismo horario → OK", async () => {
  await insert(
    appointmentValues(f, "2026-11-04T15:00:00Z", 60, { staffIndex: 0 }),
    appointmentValues(f, "2026-11-04T15:00:00Z", 60, { staffIndex: 1 }),
  );
});

test("EXCLUDE: cancelada, completada o no-show no bloquean el horario", async () => {
  await insert(appointmentValues(f, "2026-11-05T15:00:00Z", 60, { status: "cancelled" }));
  await insert(appointmentValues(f, "2026-11-05T15:00:00Z", 60, { status: "no_show" }));
  await insert(appointmentValues(f, "2026-11-05T15:00:00Z", 60, { status: "completed" }));
  await insert(appointmentValues(f, "2026-11-05T15:00:00Z", 60, { status: "confirmed" }));
});

test("EXCLUDE: reactivar una cancelada o mover una cita encima de otra viva → error", async () => {
  await insert(appointmentValues(f, "2026-11-06T15:00:00Z", 60));
  const [cancelled] = await insert(appointmentValues(f, "2026-11-06T15:30:00Z", 60, { status: "cancelled" }));
  await assert.rejects(
    withTenant(db, f.businessId, (tx) => tx.update(appointments).set({ status: "confirmed" }).where(eq(appointments.id, cancelled.id))),
    isOverlap,
  );
  const [later] = await insert(appointmentValues(f, "2026-11-06T18:00:00Z", 60));
  await assert.rejects(
    withTenant(db, f.businessId, (tx) =>
      tx
        .update(appointments)
        .set({ startsAt: new Date("2026-11-06T15:30:00Z"), endsAt: new Date("2026-11-06T16:30:00Z") })
        .where(eq(appointments.id, later.id)),
    ),
    isOverlap,
  );
});

test("CHECK: la cita termina después de empezar", async () => {
  await assert.rejects(insert(appointmentValues(f, "2026-11-07T15:00:00Z", 0)), (e) => hasPgCode(e, CHECK_VIOLATION));
  await assert.rejects(insert(appointmentValues(f, "2026-11-07T15:00:00Z", -30)), (e) => hasPgCode(e, CHECK_VIOLATION));
});
