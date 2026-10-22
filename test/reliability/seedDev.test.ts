import assert from "node:assert/strict";
import { after, test } from "node:test";
import { and, eq, gte, lt, sql } from "drizzle-orm";
import { getBusinessContext } from "../../src/modules/business";
import { businesses, customFields } from "../../src/modules/business/schema";
import { getServices } from "../../src/modules/catalog";
import { clients } from "../../src/modules/clients/schema";
import { commissionEntries } from "../../src/modules/commissions/schema";
import { clientIdsWithStaffAppointments } from "../../src/modules/scheduling";
import { appointments } from "../../src/modules/scheduling/schema";
import { memberships, staff, users } from "../../src/modules/team/schema";
import { verifyPassword } from "../../src/platform/auth/password";
import { withSystem, withTenant } from "../../src/platform/db/scope";
import { DEMO_FRONT_DESK_EMAIL, DEMO_OWNER_EMAIL, DEMO_PASSWORD, DEMO_SLUG, DEMO_STAFF_EMAIL, seedDev } from "../../scripts/seedDev";
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
  // 9 servicios: el catálogo de la plantilla de estética (src/modules/business/templates/aesthetics.json).
  assert.deepEqual(first.counts, { locations: 2, staff: 3, services: 9, clients: 11, appointments: 12, payments: 3 });

  const ctx = await getBusinessContext(db, first.businessId);
  assert.ok(ctx);
  assert.equal(ctx.locations.length, 2);
  assert.ok(ctx.locations.every((l) => l.hours.length > 0), "cada sucursal con su horario");
  assert.equal(ctx.terminology.staffMember, "especialista", "terminología de la plantilla de estética");

  // Catálogo y campos personalizados de la plantilla, con precios de demo.
  const catalog = await getServices(db, first.businessId);
  assert.equal(catalog.length, 9);
  assert.ok(catalog.every((s) => s.priceCents > 0), "el seed les pone precio a todos los servicios");
  const fields = await withTenant(db, first.businessId, (tx) => tx.select({ key: customFields.key }).from(customFields));
  assert.deepEqual(fields.map((f) => f.key).sort(), ["allergies", "skin_type"]);

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
  // Comisiones de demo sobre lo cobrado: una por línea de las 3 citas cobradas (Carla hizo mani + pedi).
  const entries = await withTenant(db, first.businessId, (tx) => tx.select().from(commissionEntries));
  assert.equal(entries.length, 4);
  assert.ok(entries.some((e) => e.rule.value === 1500), "Ana en la limpieza facial: 15 %");

  // Ventas × CRM (I4 + I3): los clientes de "Mis comisiones" de Ana están en sus "Mis
  // clientes" (los que tienen citas suyas, sin las canceladas), que es lo que ve el rol staff.
  const [ana] = await withTenant(db, first.businessId, (tx) => tx.select({ id: staff.id }).from(staff).where(eq(staff.name, "Ana Rojas")));
  const anaClients = await withTenant(db, first.businessId, (tx) =>
    tx
      .select({ name: clients.name })
      .from(clients)
      .where(sql`${clients.id} IN (${clientIdsWithStaffAppointments(first.businessId, ana.id)})`),
  );
  assert.deepEqual(
    anaClients.map((c) => c.name).sort(),
    ["Andrea Quesada", "María Fernández", "Natalia Brenes", "Valeria Solís"],
    "sus citas (también el no-show) sin la cancelada de Gabriela",
  );
  const anaCommissionClients = await withTenant(db, first.businessId, (tx) =>
    tx
      .select({ name: clients.name })
      .from(commissionEntries)
      .innerJoin(appointments, eq(appointments.id, commissionEntries.appointmentId))
      .innerJoin(clients, eq(clients.id, appointments.clientId))
      .where(eq(commissionEntries.staffId, ana.id)),
  );
  assert.ok(anaCommissionClients.length > 0, "Ana tiene comisiones de demo");
  for (const c of anaCommissionClients) assert.ok(anaClients.some((a) => a.name === c.name), `${c.name} está en Mis clientes de Ana`);

  // Los usuarios demo entran con la clave conocida de desarrollo.
  assert.equal(first.password, DEMO_PASSWORD);
  for (const email of [DEMO_OWNER_EMAIL, DEMO_FRONT_DESK_EMAIL, DEMO_STAFF_EMAIL]) {
    const [user] = await withSystem(db, (tx) => tx.select().from(users).where(eq(users.email, email)));
    assert.equal(await verifyPassword(DEMO_PASSWORD, user.passwordHash ?? undefined), true, email);
  }
  // La recepcionista queda fija a una sucursal; la dueña, sin filas (= todas).
  const access = await withTenant(db, first.businessId, (tx) =>
    tx
      .select({ role: memberships.role, locations: sql<number>`(SELECT count(*)::int FROM membership_locations ml WHERE ml.membership_id = ${memberships.id})` })
      .from(memberships),
  );
  assert.deepEqual(access.map((a) => [a.role, Number(a.locations)]).sort(), [["front_desk", 1], ["owner", 0], ["staff", 0]]);
  // La especialista queda vinculada a su carril de la agenda.
  const linked = await withTenant(db, first.businessId, (tx) =>
    tx.select({ name: staff.name }).from(staff).innerJoin(memberships, eq(memberships.id, staff.membershipId)),
  );
  assert.deepEqual(linked.map((s) => s.name), ["Ana Rojas"]);

  const second = await seedDev(db, { now });
  assert.equal(second.replaced, true);
  assert.notEqual(second.businessId, first.businessId);
  const demos = await withSystem(db, (tx) => tx.select({ id: businesses.id }).from(businesses).where(eq(businesses.slug, DEMO_SLUG)));
  assert.deepEqual(demos.map((b) => b.id), [second.businessId], "uno solo: el anterior se borró en cascada");
});
