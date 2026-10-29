import assert from "node:assert/strict";
import { after, test } from "node:test";
import { and, eq, gte, lt, sql } from "drizzle-orm";
import { getBusinessContext } from "../../src/modules/business";
import { businesses } from "../../src/modules/business/schema";
import { clients } from "../../src/modules/clients/schema";
import { appointments } from "../../src/modules/scheduling/schema";
import { memberships, users } from "../../src/modules/team/schema";
import { verifyPassword } from "../../src/platform/auth/password";
import { withSystem, withTenant } from "../../src/platform/db/scope";
import { DEMO_FRONT_DESK_EMAIL, DEMO_OWNER_EMAIL, DEMO_PASSWORD, DEMO_SLUG, seedDev } from "../../scripts/seedDev";
import { createEphemeralDb } from "../helpers/pgliteDb";

// ─────────────────────────────────────────────────────────────────────────────
// El seed de desarrollo (scripts/seedDev.ts) corre contra el esquema real: si una
// migración cambia una tabla y el seed queda viejo, falla acá (y no el día que alguien
// lo necesita). Corre con el rol de la app: todo lo que inserta pasa el WITH CHECK de RLS.
// ─────────────────────────────────────────────────────────────────────────────

const base = await createEphemeralDb();
const { db } = base;
after(() => base.close());

test("seed:dev: crea el negocio demo completo con citas de esta semana, y es idempotente", async () => {
  await base.client.exec("SET ROLE app_runtime");
  const now = new Date("2026-10-21T18:00:00Z"); // miércoles 12:00 en Costa Rica
  const first = await seedDev(db, { now });
  assert.equal(first.replaced, false);
  assert.deepEqual(first.counts, { locations: 2, staff: 3, services: 6, clients: 11, appointments: 12, payments: 3 });

  const ctx = await getBusinessContext(db, first.businessId);
  assert.ok(ctx);
  assert.equal(ctx.locations.length, 2);
  assert.ok(ctx.locations.every((l) => l.hours.length > 0), "cada sucursal con su horario");
  assert.equal(ctx.terminology.staffMember, "especialista");

  // Semana del lunes 19 al domingo 25 de octubre, hora de Costa Rica.
  const week = await withTenant(db, first.businessId, (tx) =>
    tx
      .select({ status: appointments.status })
      .from(appointments)
      .where(and(gte(appointments.startsAt, new Date("2026-10-19T06:00:00Z")), lt(appointments.startsAt, new Date("2026-10-26T06:00:00Z")))),
  );
  assert.equal(week.length, 12);
  const statuses = new Set(week.map((a) => a.status));
  for (const s of ["completed", "confirmed", "cancelled", "no_show", "pending"]) assert.ok(statuses.has(s), `hay citas ${s}`);

  const [maria] = await withTenant(db, first.businessId, (tx) => tx.select().from(clients).where(eq(clients.name, "María Fernández")));
  assert.equal(maria.visitCount, 1, "la caché del cliente refleja la cita completada");

  // Los dos usuarios demo entran con la clave conocida de desarrollo.
  assert.equal(first.password, DEMO_PASSWORD);
  for (const email of [DEMO_OWNER_EMAIL, DEMO_FRONT_DESK_EMAIL]) {
    const [user] = await withSystem(db, (tx) => tx.select().from(users).where(eq(users.email, email)));
    assert.equal(await verifyPassword(DEMO_PASSWORD, user.passwordHash ?? undefined), true, email);
  }
  // La recepcionista queda fija a una sucursal; la dueña, sin filas (= todas).
  const access = await withTenant(db, first.businessId, (tx) =>
    tx
      .select({ role: memberships.role, locations: sql<number>`(SELECT count(*)::int FROM membership_locations ml WHERE ml.membership_id = ${memberships.id})` })
      .from(memberships),
  );
  assert.deepEqual(access.map((a) => [a.role, Number(a.locations)]).sort(), [["front_desk", 1], ["owner", 0]]);

  const second = await seedDev(db, { now });
  assert.equal(second.replaced, true);
  assert.notEqual(second.businessId, first.businessId);
  const demos = await withSystem(db, (tx) => tx.select({ id: businesses.id }).from(businesses).where(eq(businesses.slug, DEMO_SLUG)));
  assert.deepEqual(demos.map((b) => b.id), [second.businessId], "uno solo: el anterior se borró en cascada");
});
