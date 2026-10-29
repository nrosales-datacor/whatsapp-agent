import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { eq } from "drizzle-orm";
import {
  findClientByPhone,
  findOrCreateClientByPhone,
  getClient,
  getClientsByIds,
  refreshClientStats,
  UNNAMED_CLIENT,
} from "../../src/modules/clients";
import { clients } from "../../src/modules/clients/schema";
import { businesses } from "../../src/modules/business/schema";
import { withTenant } from "../../src/platform/db/scope";
import { ValidationError } from "../../src/platform/http/errors";
import { createTestBusiness } from "../helpers/identityFixtures";
import { createEphemeralDb } from "../helpers/pgliteDb";

// ─────────────────────────────────────────────────────────────────────────────
// API pública del módulo clients (la que usan la Agenda, Ventas y el agente de WhatsApp),
// con la base corriendo como el rol de la app (`app_runtime`, SIN BYPASSRLS):
//   • findOrCreateClientByPhone es idempotente y segura ante llamadas simultáneas.
//   • El teléfono se encuentra escrito de cualquier forma.
//   • refreshClientStats fija valores absolutos y solo las claves presentes.
//   • Nada cruza de un negocio a otro.
// ─────────────────────────────────────────────────────────────────────────────

const base = await createEphemeralDb();
const { db } = base;

before(async () => {
  await base.client.exec("SET ROLE app_runtime");
});
after(() => base.close());

async function countByPhone(businessId: string, phone: string): Promise<number> {
  const rows = await withTenant(db, businessId, (tx) => tx.select({ id: clients.id }).from(clients).where(eq(clients.phone, phone)));
  return rows.length;
}

test("findOrCreateClientByPhone: crea la primera vez y devuelve el MISMO cliente después (en cualquier formato)", async () => {
  const { businessId } = await createTestBusiness(db);
  const first = await findOrCreateClientByPhone(db, businessId, { phone: "50688887777", name: " María ", source: "WhatsApp" });
  assert.equal(first.created, true);
  assert.equal(first.client.phone, "+50688887777");
  assert.equal(first.client.name, "María");
  assert.equal(first.client.source, "WhatsApp");

  for (const phone of ["8888-7777", "+506 8888 7777", "0050688887777"]) {
    const again = await findOrCreateClientByPhone(db, businessId, { phone, name: "Otro nombre" });
    assert.equal(again.created, false, phone);
    assert.equal(again.client.id, first.client.id, phone);
    assert.equal(again.client.name, "María", "un cliente existente conserva su nombre");
  }

  const unnamed = await findOrCreateClientByPhone(db, businessId, { phone: "8888-0000" });
  assert.equal(unnamed.client.name, UNNAMED_CLIENT);
  assert.equal(unnamed.client.source, null);

  await assert.rejects(findOrCreateClientByPhone(db, businessId, { phone: "123" }), (e: unknown) => {
    assert.ok(e instanceof ValidationError);
    assert.ok(e.fields.phone);
    return true;
  });
});

test("findOrCreateClientByPhone: 20 llamadas simultáneas con el mismo teléfono → un solo cliente", async () => {
  const { businessId } = await createTestBusiness(db);
  const results = await Promise.all(
    Array.from({ length: 20 }, (_, i) =>
      findOrCreateClientByPhone(db, businessId, { phone: i % 2 === 0 ? "7000-1111" : "+50670001111", name: `Mensaje ${i}` }),
    ),
  );
  const ids = new Set(results.map((r) => r.client.id));
  assert.equal(ids.size, 1, "todas terminan en el mismo cliente");
  assert.equal(results.filter((r) => r.created).length, 1, "solo una lo creó");
  assert.equal(await countByPhone(businessId, "+50670001111"), 1);
});

test("findOrCreateClientByPhone: dentro de una transacción del llamador (p. ej. al agendar)", async () => {
  const { businessId } = await createTestBusiness(db);
  const id = await withTenant(db, businessId, async (tx) => {
    const { client } = await findOrCreateClientByPhone(tx, businessId, { phone: "6000-2222", name: "Desde la Agenda" });
    const again = await findOrCreateClientByPhone(tx, businessId, { phone: "60002222" });
    assert.equal(again.client.id, client.id);
    return client.id;
  });
  assert.equal((await getClient(db, businessId, id))?.name, "Desde la Agenda");

  // Si la transacción del llamador se revierte, el cliente tampoco queda.
  await assert.rejects(
    withTenant(db, businessId, async (tx) => {
      await findOrCreateClientByPhone(tx, businessId, { phone: "6000-3333", name: "Se revierte" });
      throw new Error("falla la cita");
    }),
    /falla la cita/,
  );
  assert.equal(await findClientByPhone(db, businessId, "6000-3333"), null);
});

test("findClientByPhone: con el país del negocio; null si no hay o no es un teléfono", async () => {
  const { businessId } = await createTestBusiness(db);
  await withTenant(db, businessId, (tx) => tx.update(businesses).set({ country: "MX" }).where(eq(businesses.id, businessId)));
  const { client } = await findOrCreateClientByPhone(db, businessId, { phone: "55 1234 5678", name: "Lupita" });
  assert.equal(client.phone, "+525512345678");
  assert.equal((await findClientByPhone(db, businessId, "+52 55 1234 5678"))?.id, client.id);
  assert.equal((await findClientByPhone(db, businessId, "5512345678"))?.id, client.id);
  assert.equal(await findClientByPhone(db, businessId, "5512340000"), null);
  assert.equal(await findClientByPhone(db, businessId, "no es un teléfono"), null);
});

test("aislamiento: el mismo teléfono en dos negocios son dos clientes; ninguna función cruza de negocio", async () => {
  const a = await createTestBusiness(db);
  const b = await createTestBusiness(db);
  const inA = await findOrCreateClientByPhone(db, a.businessId, { phone: "8888-9999", name: "En A" });
  const inB = await findOrCreateClientByPhone(db, b.businessId, { phone: "8888-9999", name: "En B" });
  assert.equal(inB.created, true);
  assert.notEqual(inA.client.id, inB.client.id);

  assert.equal(await getClient(db, b.businessId, inA.client.id), null, "B no lee el cliente de A por id");
  assert.deepEqual(
    (await getClientsByIds(db, b.businessId, [inA.client.id, inB.client.id, "no-es-uuid"])).map((c) => c.name),
    ["En B"],
  );
  assert.equal((await findClientByPhone(db, b.businessId, "8888-9999"))?.id, inB.client.id);
  assert.equal(await refreshClientStats(db, b.businessId, inA.client.id, { visitCount: 99 }), false, "B no toca la caché de A");
  assert.equal((await getClient(db, a.businessId, inA.client.id))?.visitCount, 0);
});

test("refreshClientStats: valores absolutos, solo las claves presentes, y validación de lo que llega", async () => {
  const { businessId } = await createTestBusiness(db);
  const { client } = await findOrCreateClientByPhone(db, businessId, { phone: "8000-1234", name: "Paula" });
  const first = new Date("2026-09-01T15:00:00.000Z");
  const last = new Date("2026-10-15T16:30:00.000Z");

  // Agenda: visitas.
  assert.equal(await refreshClientStats(db, businessId, client.id, { visitCount: 4, firstVisitAt: first, lastVisitAt: last }), true);
  // Ventas: gasto (no pisa lo de la Agenda). Repetir no desvía nada (no son incrementos).
  await refreshClientStats(db, businessId, client.id, { totalSpentCents: 12_345_600 });
  await refreshClientStats(db, businessId, client.id, { totalSpentCents: 12_345_600 });

  const view = await getClient(db, businessId, client.id);
  assert.equal(view?.visitCount, 4);
  assert.equal(view?.firstVisitAt, first.toISOString());
  assert.equal(view?.lastVisitAt, last.toISOString());
  assert.equal(view?.totalSpentCents, 12_345_600);

  // Una cita completada se cancela después: la Agenda recalcula y manda los valores nuevos.
  await refreshClientStats(db, businessId, client.id, { visitCount: 0, firstVisitAt: null, lastVisitAt: null });
  const reset = await getClient(db, businessId, client.id);
  assert.equal(reset?.visitCount, 0);
  assert.equal(reset?.lastVisitAt, null);
  assert.equal(reset?.totalSpentCents, 12_345_600);

  await assert.rejects(refreshClientStats(db, businessId, client.id, { visitCount: -1 }), /entero/);
  await assert.rejects(refreshClientStats(db, businessId, client.id, { totalSpentCents: 1.5 }), /entero/);
  await assert.rejects(refreshClientStats(db, businessId, client.id, { lastVisitAt: new Date("x") }), /fecha/);
  await assert.rejects(refreshClientStats(db, businessId, client.id, { firstVisitAt: last, lastVisitAt: first }), /posterior/);
  assert.equal(await refreshClientStats(db, businessId, client.id, {}), false, "sin claves no hace nada");
});

test("getClientsByIds: sin ids o con ids repetidos", async () => {
  const { businessId } = await createTestBusiness(db);
  assert.deepEqual(await getClientsByIds(db, businessId, []), []);
  const { client } = await findOrCreateClientByPhone(db, businessId, { phone: "8111-2222", name: "Natalia" });
  const found = await getClientsByIds(db, businessId, [client.id, client.id.toUpperCase(), client.id]);
  assert.equal(found.length, 1);
  assert.equal(found[0].id, client.id);
});
