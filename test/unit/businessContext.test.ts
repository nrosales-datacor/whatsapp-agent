import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { eq } from "drizzle-orm";
import { createBusinessContextCache, loadBusinessContext } from "../../src/modules/business/context";
import { businesses, locationHours, locations } from "../../src/modules/business/schema";
import { DEFAULT_CLIENT_STATUS_RULES, DEFAULT_TERMINOLOGY } from "../../src/modules/business/settings";
import { withTenant } from "../../src/platform/db/scope";
import { createBusinessFixture, type BusinessFixture } from "../helpers/domainFixtures";
import { createEphemeralDb } from "../helpers/pgliteDb";

// ─────────────────────────────────────────────────────────────────────────────
// Caché del contexto del negocio (src/modules/business/context.ts): qué trae, TTL, LRU,
// invalidación, una sola lectura en vuelo y que funcione con el rol de la app (RLS).
// ─────────────────────────────────────────────────────────────────────────────

const base = await createEphemeralDb();
const { db } = base;
after(() => base.close());

let a: BusinessFixture;
let b: BusinessFixture;

before(async () => {
  // Todo corre como el rol de la app: sin BYPASSRLS.
  await base.client.exec("SET ROLE app_runtime");
  a = await createBusinessFixture(db);
  b = await createBusinessFixture(db);
  await withTenant(db, a.businessId, async (tx) => {
    await tx
      .update(businesses)
      .set({ terminology: { client: "paciente", clients: "pacientes" }, clientStatusRules: { atRiskAfterDays: 45 }, reminderChannels: ["email", "whatsapp"] })
      .where(eq(businesses.id, a.businessId));
    const [second] = await tx
      .insert(locations)
      .values({ businessId: a.businessId, name: "Norte", timezone: "America/Costa_Rica", position: 1 })
      .returning({ id: locations.id });
    await tx.insert(locationHours).values([
      { businessId: a.businessId, locationId: a.locationId, weekday: 1, opensAt: "13:00", closesAt: "18:00" },
      { businessId: a.businessId, locationId: a.locationId, weekday: 1, opensAt: "09:00", closesAt: "12:00" },
      { businessId: a.businessId, locationId: second.id, weekday: 6, opensAt: "09:00", closesAt: "14:00" },
    ]);
  });
});

async function renameBusiness(id: string, name: string): Promise<void> {
  await withTenant(db, id, (tx) => tx.update(businesses).set({ name }).where(eq(businesses.id, id)));
}

test("contexto: negocio, sucursales en orden con su horario, y config completada con los defaults", async () => {
  const ctx = await loadBusinessContext(db, a.businessId);
  assert.ok(ctx);
  assert.equal(ctx.business.id, a.businessId);
  assert.deepEqual(
    ctx.locations.map((l) => l.name),
    ["Central", "Norte"],
  );
  assert.deepEqual(
    ctx.locations[0].hours.map((h) => [h.weekday, h.opensAt, h.closesAt]),
    [
      [1, "09:00:00", "12:00:00"],
      [1, "13:00:00", "18:00:00"],
    ],
    "turno partido: dos filas el mismo día, ordenadas por hora",
  );
  assert.deepEqual(
    ctx.locations[1].hours.map((h) => h.weekday),
    [6],
  );
  assert.deepEqual(ctx.terminology, { ...DEFAULT_TERMINOLOGY, client: "paciente", clients: "pacientes" });
  assert.deepEqual(ctx.clientStatusRules, { ...DEFAULT_CLIENT_STATUS_RULES, atRiskAfterDays: 45 });
  assert.deepEqual(ctx.reminderChannels, ["email", "whatsapp"]);
});

test("contexto: un negocio no ve las sucursales de otro; uno inexistente da null", async () => {
  const ctx = await loadBusinessContext(db, b.businessId);
  assert.ok(ctx);
  assert.deepEqual(
    ctx.locations.map((l) => l.id),
    [b.locationId],
  );
  assert.equal(await loadBusinessContext(db, randomUUID()), null);
});

test("caché: devuelve lo guardado hasta invalidar; lo devuelto está congelado", async () => {
  const cache = createBusinessContextCache({ ttlMs: 60_000 });
  const first = await cache.get(db, a.businessId);
  await renameBusiness(a.businessId, "Renombrado");
  const second = await cache.get(db, a.businessId);
  assert.equal(second, first, "dentro del TTL no vuelve a la base");
  assert.throws(() => {
    (second!.business as { name: string }).name = "x";
  }, TypeError);
  assert.throws(() => {
    (second!.locations as unknown[]).push({});
  }, TypeError);

  cache.invalidate(a.businessId);
  const third = await cache.get(db, a.businessId);
  assert.equal(third?.business.name, "Renombrado");
});

test("caché: vence con el TTL", async () => {
  let now = 1_000;
  const cache = createBusinessContextCache({ ttlMs: 30_000, now: () => now });
  const first = await cache.get(db, b.businessId);
  await renameBusiness(b.businessId, "Otro nombre");
  now += 29_999;
  assert.equal(await cache.get(db, b.businessId), first);
  now += 1;
  const fresh = await cache.get(db, b.businessId);
  assert.equal(fresh?.business.name, "Otro nombre");
});

test("caché: LRU — al pasarse del máximo descarta el usado hace más tiempo", async () => {
  const c = await createBusinessFixture(db);
  const cache = createBusinessContextCache({ ttlMs: 60_000, maxEntries: 2 });
  const ctxA = await cache.get(db, a.businessId);
  const ctxB = await cache.get(db, b.businessId);
  await cache.get(db, a.businessId); // A pasa a ser el más reciente
  await cache.get(db, c.businessId); // se descarta B
  assert.equal(cache.size, 2);
  assert.equal(await cache.get(db, a.businessId), ctxA, "A seguía guardado");
  assert.notEqual(await cache.get(db, b.businessId), ctxB, "B se volvió a leer");
});

test("caché: una ráfaga con el caché frío comparte una sola lectura", async () => {
  const cache = createBusinessContextCache({ ttlMs: 60_000 });
  const [x, y, z] = await Promise.all([
    cache.get(db, a.businessId),
    cache.get(db, a.businessId),
    cache.get(db, a.businessId),
  ]);
  assert.ok(x);
  assert.equal(x, y);
  assert.equal(y, z);
});

test("caché: ni un negocio inexistente ni un error quedan guardados", async () => {
  const cache = createBusinessContextCache({ ttlMs: 60_000 });
  assert.equal(await cache.get(db, randomUUID()), null);
  await assert.rejects(cache.get(db, "no-es-uuid"), /uuid/);
  assert.equal(cache.size, 0);
});
