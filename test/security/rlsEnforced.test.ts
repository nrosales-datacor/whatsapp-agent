import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { eq, sql } from "drizzle-orm";
import { businesses } from "../../src/modules/business/schema";
import { clients } from "../../src/modules/clients/schema";
import { paymentMethods, payments } from "../../src/modules/sales/schema";
import { appointments } from "../../src/modules/scheduling/schema";
import { memberships, users } from "../../src/modules/team/schema";
import { listPlatformAudit, listTenantAudit, recordAudit, superadminActor, userActor } from "../../src/platform/audit/auditLog";
import { auditLog } from "../../src/platform/db/schema";
import { rowsOf } from "../../src/platform/db/rows";
import { withSystem, withTenant } from "../../src/platform/db/scope";
import { checkHealth } from "../../src/platform/http/health";
import { tryAcquireLease } from "../../src/platform/net/leaderLease";
import { appointmentValues, createBusinessFixture, type BusinessFixture } from "../helpers/domainFixtures";
import { createEphemeralDb } from "../helpers/pgliteDb";

// ─────────────────────────────────────────────────────────────────────────────
// RLS de punta a punta: la base corre con el rol de la app (`app_runtime`, SIN
// BYPASSRLS) y cada función de la plataforma que toca Postgres se ejerce al menos una
// vez. Si alguna se olvida de `withTenant`/`withSystem` (src/platform/db/scope.ts), acá
// falla: no ve sus filas o la política rechaza la escritura. Y lo que un negocio escribe
// no lo ve otro. Los módulos que sumen tablas suman acá sus funciones.
// ─────────────────────────────────────────────────────────────────────────────

const base = await createEphemeralDb();
const { db } = base;
after(() => base.close());

const A = randomUUID();
const B = randomUUID();

/** ¿El error (o alguno de su cadena de `cause`) es el rechazo de una política RLS? Drizzle envuelve el de Postgres. */
function isRlsViolation(e: unknown): boolean {
  for (let cur: unknown = e, i = 0; cur && i < 5; i++) {
    if (/row-level security/i.test((cur as Error).message ?? "")) return true;
    cur = (cur as { cause?: unknown }).cause;
  }
  return false;
}

before(async () => {
  // Desde acá, TODO corre como el rol de la app: sin BYPASSRLS.
  await base.client.exec("SET ROLE app_runtime");
});

test("RLS aplicado: el rol de la app no tiene BYPASSRLS y sin contexto no ve nada", async () => {
  const r = await base.client.query<{ current: string; bypass: boolean }>(
    "SELECT current_user AS current, (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user) AS bypass",
  );
  assert.equal(r.rows[0].current, "app_runtime");
  assert.equal(r.rows[0].bypass, false);
  await recordAudit(db, A, "test_seed", userActor("u-a"));
  for (const table of ["audit_log", "leader_leases"]) {
    const noContext = await base.client.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`);
    assert.equal(noContext.rows[0].n, 0, `${table}: sin withTenant/withSystem no se ve ni una fila`);
  }
});

test("RLS aplicado: audit_log — cada negocio ve solo su rastro; el de plataforma solo el sistema", async () => {
  await recordAudit(db, A, "business_paused", userActor("u-a"), { reason: "prueba" });
  await recordAudit(db, B, "password_reset", userActor("u-b"));
  await recordAudit(db, null, "admin_login", superadminActor("admin"), { origin: "abc123" });

  const ofA = await listTenantAudit(db, A);
  assert.ok(ofA.length >= 1);
  assert.ok(ofA.every((e) => e.tenantId === A), "A no ve filas de B ni de plataforma");
  assert.ok(ofA.some((e) => e.action === "business_paused" && e.details.reason === "prueba"));

  const ofB = await listTenantAudit(db, B);
  assert.deepEqual(ofB.map((e) => e.action), ["password_reset"]);

  const platform = await listPlatformAudit(db);
  assert.deepEqual(platform.map((e) => [e.action, e.actor, e.tenantId]), [["admin_login", "superadmin:admin", null]]);

  // Con el contexto de A, ni filtrando a mano se ven las de B o las de plataforma.
  const fromA = await withTenant(db, A, (tx) => tx.select().from(auditLog));
  assert.ok(fromA.every((r) => r.businessId === A));
});

test("RLS aplicado: con el contexto de un negocio no se puede escribir a nombre de otro", async () => {
  await assert.rejects(
    withTenant(db, A, (tx) => tx.insert(auditLog).values({ businessId: B, action: "forged", actor: "x" })),
    isRlsViolation,
  );
  await assert.rejects(
    withTenant(db, A, (tx) => tx.insert(auditLog).values({ businessId: null, action: "forged", actor: "x" })),
    isRlsViolation,
    "tampoco una entrada de plataforma",
  );
  const forged = await withSystem(db, (tx) => tx.execute(sql`SELECT count(*)::int AS n FROM audit_log WHERE action = 'forged'`));
  assert.equal(rowsOf<{ n: number }>(forged)[0].n, 0);
});

test("RLS aplicado: el contexto no queda pegado a la conexión después de la transacción", async () => {
  await withTenant(db, A, async (tx) => tx.execute(sql`SELECT 1`));
  // Mismo cliente (PGlite tiene una sola conexión): fuera de la transacción ya no hay contexto.
  const after = await base.client.query<{ n: number }>("SELECT count(*)::int AS n FROM audit_log");
  assert.equal(after.rows[0].n, 0, "set_config(..., true) es local a la transacción");
});

test("RLS aplicado: withTenant rechaza un id de negocio que no es uuid (antes de tocar la base)", async () => {
  await assert.rejects(withTenant(db, "negocio-a", async () => 1), /uuid/);
  await assert.rejects(withTenant(db, "", async () => 1), /uuid/);
});

test("RLS aplicado: lease de liderazgo (contexto de sistema)", async () => {
  assert.equal(await tryAcquireLease(db, "rls-test", "holder-1", 60_000), true);
  assert.equal(await tryAcquireLease(db, "rls-test", "holder-2", 60_000), false);
  await assert.rejects(
    withTenant(db, A, (tx) => tx.execute(sql`INSERT INTO leader_leases (name, holder, expires_at) VALUES ('x', 'y', now())`)),
    isRlsViolation,
    "un negocio no puede tocar una tabla solo-sistema",
  );
});

test("RLS aplicado: el health check funciona con el rol de la app", async () => {
  const report = await checkHealth(db);
  assert.equal(report.ok, true);
});

// ─────────────────────────────────────────────────────────────────────────────
// Tablas del dominio (I0.5). Dos negocios reales (con FKs), cada uno con su cliente, una
// cita y un pago; con el contexto de uno, el otro no existe.
// ─────────────────────────────────────────────────────────────────────────────

async function seedSales(f: BusinessFixture): Promise<{ appointmentId: string; paymentId: string }> {
  return withTenant(db, f.businessId, async (tx) => {
    const [appt] = await tx
      .insert(appointments)
      .values(appointmentValues(f, "2026-11-02T15:00:00Z", 60, { totalCents: 2_500_000 }))
      .returning({ id: appointments.id });
    const [pay] = await tx
      .insert(payments)
      .values({
        businessId: f.businessId,
        locationId: f.locationId,
        clientId: f.clientId,
        appointmentId: appt.id,
        amountCents: 2_500_000,
        paymentMethodId: f.paymentMethodId,
      })
      .returning({ id: payments.id });
    return { appointmentId: appt.id, paymentId: pay.id };
  });
}

test("RLS aplicado: clients, appointments y payments — un negocio no ve las filas de otro", async () => {
  const fa = await createBusinessFixture(db);
  const fb = await createBusinessFixture(db);
  const sa = await seedSales(fa);
  const sb = await seedSales(fb);

  const seenByA = await withTenant(db, fa.businessId, async (tx) => ({
    clients: await tx.select().from(clients),
    appointments: await tx.select().from(appointments),
    payments: await tx.select().from(payments),
    businesses: await tx.select().from(businesses),
  }));
  assert.deepEqual(seenByA.clients.map((r) => r.id), [fa.clientId]);
  assert.deepEqual(seenByA.appointments.map((r) => r.id), [sa.appointmentId]);
  assert.deepEqual(seenByA.payments.map((r) => r.id), [sa.paymentId]);
  assert.deepEqual(seenByA.businesses.map((r) => r.id), [fa.businessId], "ni siquiera la fila del otro negocio");

  // Ni pidiendo el id exacto de B.
  const direct = await withTenant(db, fa.businessId, async (tx) => ({
    client: await tx.select().from(clients).where(eq(clients.id, fb.clientId)),
    appointment: await tx.select().from(appointments).where(eq(appointments.id, sb.appointmentId)),
    payment: await tx.select().from(payments).where(eq(payments.id, sb.paymentId)),
  }));
  assert.deepEqual([direct.client.length, direct.appointment.length, direct.payment.length], [0, 0, 0]);

  // Sin contexto, nada.
  for (const table of ["clients", "appointments", "payments", "businesses", "locations", "staff"]) {
    const r = await base.client.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`);
    assert.equal(r.rows[0].n, 0, `${table}: sin withTenant/withSystem no se ve ni una fila`);
  }

  // El sistema ve los dos.
  const all = await withSystem(db, (tx) => tx.select({ id: clients.id }).from(clients));
  assert.ok([fa.clientId, fb.clientId].every((id) => all.some((r) => r.id === id)));
});

test("RLS aplicado: con el contexto de un negocio no se escribe ni se modifica nada de otro", async () => {
  const fa = await createBusinessFixture(db);
  const fb = await createBusinessFixture(db);
  await assert.rejects(
    withTenant(db, fa.businessId, (tx) => tx.insert(clients).values({ businessId: fb.businessId, name: "Intruso" })),
    isRlsViolation,
  );
  await assert.rejects(
    withTenant(db, fa.businessId, (tx) => tx.insert(appointments).values(appointmentValues(fb, "2026-11-03T15:00:00Z", 30))),
    isRlsViolation,
  );
  // UPDATE/DELETE sobre filas ajenas: no las ve, no las toca.
  const updated = await withTenant(db, fa.businessId, (tx) =>
    tx.update(clients).set({ name: "Pisado" }).where(eq(clients.id, fb.clientId)).returning({ id: clients.id }),
  );
  assert.equal(updated.length, 0);
  const deleted = await withTenant(db, fa.businessId, (tx) =>
    tx.delete(paymentMethods).where(eq(paymentMethods.id, fb.paymentMethodId)).returning({ id: paymentMethods.id }),
  );
  assert.equal(deleted.length, 0);
  // Mover una fila propia a otro negocio tampoco (WITH CHECK).
  await assert.rejects(
    withTenant(db, fa.businessId, (tx) => tx.update(clients).set({ businessId: fb.businessId }).where(eq(clients.id, fa.clientId))),
    isRlsViolation,
  );
  const [still] = await withTenant(db, fb.businessId, (tx) => tx.select().from(clients).where(eq(clients.id, fb.clientId)));
  assert.equal(still.name, "Cliente de prueba");
});

test("RLS aplicado: users — un negocio ve solo a los usuarios con membresía en él; crear usuarios es de sistema", async () => {
  const fa = await createBusinessFixture(db);
  const fb = await createBusinessFixture(db);
  const [ua, ub] = await withSystem(db, async (tx) => {
    const rows = await tx
      .insert(users)
      .values([
        { email: `a-${fa.businessId.slice(0, 8)}@example.com`, name: "Usuaria A" },
        { email: `b-${fb.businessId.slice(0, 8)}@example.com`, name: "Usuario B" },
      ])
      .returning({ id: users.id });
    return rows;
  });
  // La membresía la crea el negocio con su propio contexto.
  await withTenant(db, fa.businessId, (tx) => tx.insert(memberships).values({ businessId: fa.businessId, userId: ua.id, role: "owner" }));
  await withTenant(db, fb.businessId, (tx) => tx.insert(memberships).values({ businessId: fb.businessId, userId: ub.id, role: "owner" }));

  const seenByA = await withTenant(db, fa.businessId, (tx) => tx.select({ id: users.id }).from(users));
  assert.deepEqual(seenByA.map((r) => r.id), [ua.id]);
  const seenByB = await withTenant(db, fb.businessId, (tx) => tx.select({ id: users.id }).from(users));
  assert.deepEqual(seenByB.map((r) => r.id), [ub.id]);

  await assert.rejects(
    withTenant(db, fa.businessId, (tx) => tx.insert(users).values({ email: "nuevo@example.com", name: "Nuevo" })),
    isRlsViolation,
    "un usuario sin membresía no es visible para el negocio: su alta va por withSystem",
  );
});
