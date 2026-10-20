import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { sql } from "drizzle-orm";
import { listPlatformAudit, listTenantAudit, recordAudit, superadminActor, userActor } from "../../src/platform/audit/auditLog";
import { auditLog } from "../../src/platform/db/schema";
import { rowsOf } from "../../src/platform/db/rows";
import { withSystem, withTenant } from "../../src/platform/db/scope";
import { checkHealth } from "../../src/platform/http/health";
import { tryAcquireLease } from "../../src/platform/net/leaderLease";
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
