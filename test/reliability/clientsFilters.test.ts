import assert from "node:assert/strict";
import { after, before, test } from "node:test";

// ─────────────────────────────────────────────────────────────────────────────
// Lista de clientes con los filtros del CRM (I3) por HTTP: estado, etiquetas, rango de
// última visita (en la zona del negocio), profesional y sucursal preferidos, VIP; orden por
// gasto y por visitas con paginación por cursor sin repetir ni saltear; conteo por estado
// (chips) que respeta los demás filtros; etiquetas en uso. Y la misma API pública que
// reusará Campañas (listClients / countClientsByStatus).
// ─────────────────────────────────────────────────────────────────────────────

process.env.TRUST_PROXY = "loopback";
process.env.PANEL_SESSION_SECRET = "test-clients-filters-session-secret-0123456789";
process.env.TOKENS_ENCRYPTION_KEY = "f".repeat(64);
process.env.PANEL_LOGIN_RATE_LIMIT_MAX_IP = "500";

const { createAppHandler } = await import("../../src/app");
const { countClientsByStatus, listClients } = await import("../../src/modules/clients");
const { createEphemeralDb } = await import("../helpers/pgliteDb");
const { startTestServer } = await import("../helpers/panelClient");
const { createCrmTeam, insertClient } = await import("../helpers/crmFixtures");

type TestServer = Awaited<ReturnType<typeof startTestServer>>;
type Team = Awaited<ReturnType<typeof createCrmTeam>>;

const base = await createEphemeralDb();
const { db } = base;
let app: TestServer;

before(async () => {
  await base.client.exec("SET ROLE app_runtime");
  app = await startTestServer(createAppHandler({ db, role: "all" }));
});

after(async () => {
  await app?.close();
  await base.close();
});

const DAY = 86_400_000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY);

/**
 * Un negocio con clientes en cada estado (reglas default: nuevo 30 días, VIP 10 visitas,
 * en riesgo 60, inactivo 120).
 */
async function seed(t: Team) {
  const [central, norte] = t.locationIds;
  const [ana, beto] = t.staffIds;
  const c = async (name: string, values: Record<string, unknown>) => insertClient(db, t.businessId, { name, ...values });
  return {
    nueva: await c("Nadia Nueva", { createdAt: daysAgo(3), tags: ["Referida"], preferredLocationId: norte }),
    activa: await c("Alicia Activa", { visitCount: 4, firstVisitAt: daysAgo(200), lastVisitAt: daysAgo(10), totalSpentCents: 8_000_000, tags: ["Frecuente"], preferredStaffId: ana, createdAt: daysAgo(300) }),
    vip: await c("Valeria Vip", { visitCount: 15, firstVisitAt: daysAgo(400), lastVisitAt: daysAgo(2), totalSpentCents: 30_000_000, tags: ["Frecuente", "VIP"], preferredStaffId: ana, preferredLocationId: central, createdAt: daysAgo(500) }),
    manual: await c("Mónica Manual", { vip: true, visitCount: 2, firstVisitAt: daysAgo(100), lastVisitAt: daysAgo(20), totalSpentCents: 2_000_000, preferredStaffId: beto, createdAt: daysAgo(150) }),
    riesgo: await c("Rita Riesgo", { visitCount: 12, firstVisitAt: daysAgo(500), lastVisitAt: daysAgo(70), totalSpentCents: 30_000_000, tags: ["frecuente"], createdAt: daysAgo(600) }),
    inactiva: await c("Inés Inactiva", { visitCount: 1, firstVisitAt: daysAgo(300), lastVisitAt: daysAgo(300), totalSpentCents: 500_000, createdAt: daysAgo(300) }),
  };
}

const namesOf = (res: { body: any }) => (res.body.data.items as { name: string }[]).map((c) => c.name);

test("filtros: estado, etiquetas (cualquiera, tal como están escritas), preferidos y VIP, combinables", async () => {
  const t = await createCrmTeam(db, app.baseUrl);
  await seed(t);
  const list = (q: string) => t.frontDesk.get(`/api/panel/clients?${q}`);

  const all = await list("");
  assert.equal(all.status, 200);
  const statusByName = Object.fromEntries((all.body.data.items as { name: string; status: string }[]).map((c) => [c.name, c.status]));
  assert.deepEqual(statusByName, {
    "Alicia Activa": "active",
    "Inés Inactiva": "inactive",
    "Mónica Manual": "vip",
    "Nadia Nueva": "new",
    "Rita Riesgo": "at_risk",
    "Valeria Vip": "vip",
  });

  assert.deepEqual(namesOf(await list("status=vip")), ["Mónica Manual", "Valeria Vip"]);
  assert.deepEqual(namesOf(await list("status=at_risk,inactive")), ["Inés Inactiva", "Rita Riesgo"]);
  assert.deepEqual(namesOf(await list("status=new&status=active")), ["Alicia Activa", "Nadia Nueva"], "repetido o con comas");
  assert.deepEqual(namesOf(await list("tag=Frecuente")), ["Alicia Activa", "Valeria Vip"], "exacta: «frecuente» en minúscula es otra etiqueta");
  assert.deepEqual(namesOf(await list("tag=Referida&tag=VIP")), ["Nadia Nueva", "Valeria Vip"], "cualquiera de las elegidas");
  assert.deepEqual(namesOf(await list(`preferredStaffId=${t.staffIds[0]}`)), ["Alicia Activa", "Valeria Vip"]);
  assert.deepEqual(namesOf(await list(`preferredLocationId=${t.locationIds[1]}`)), ["Nadia Nueva"]);
  // VIP = manual o por reglas, aunque el estado sea otro (Rita: 12 visitas, en riesgo).
  assert.deepEqual(namesOf(await list("vip=true")), ["Mónica Manual", "Rita Riesgo", "Valeria Vip"]);
  assert.deepEqual(namesOf(await list("vip=false")), ["Alicia Activa", "Inés Inactiva", "Nadia Nueva"]);
  assert.deepEqual(namesOf(await list(`vip=true&preferredStaffId=${t.staffIds[0]}&tag=VIP&q=vale`)), ["Valeria Vip"], "todo junto (Y)");

  const invalid = await list("status=dormido&vip=quizas&preferredStaffId=x");
  assert.equal(invalid.status, 400);
  assert.ok(invalid.body.fields["query.status.0"] ?? invalid.body.fields["query.status"]);
  assert.ok(invalid.body.fields["query.vip"]);
  assert.ok(invalid.body.fields["query.preferredStaffId"]);
});

test("filtros: rango de última visita en la zona del negocio (inclusive); el rango al revés es 400", async () => {
  const t = await createCrmTeam(db, app.baseUrl);
  // 23:30 hora de Costa Rica (UTC-6) del 10 de octubre = 05:30 UTC del 11.
  await insertClient(db, t.businessId, { name: "Noche del 10", visitCount: 1, firstVisitAt: new Date("2026-10-11T05:30:00Z"), lastVisitAt: new Date("2026-10-11T05:30:00Z") });
  await insertClient(db, t.businessId, { name: "Mañana del 11", visitCount: 1, firstVisitAt: new Date("2026-10-11T14:00:00Z"), lastVisitAt: new Date("2026-10-11T14:00:00Z") });
  await insertClient(db, t.businessId, { name: "Nunca vino" });
  const list = (q: string) => t.owner.get(`/api/panel/clients?${q}`);
  assert.deepEqual(namesOf(await list("lastVisitFrom=2026-10-10&lastVisitTo=2026-10-10")), ["Noche del 10"]);
  assert.deepEqual(namesOf(await list("lastVisitFrom=2026-10-11")), ["Mañana del 11"]);
  assert.deepEqual(namesOf(await list("lastVisitTo=2026-10-11")), ["Mañana del 11", "Noche del 10"]);
  const reversed = await list("lastVisitFrom=2026-10-12&lastVisitTo=2026-10-01");
  assert.equal(reversed.status, 400);
  assert.ok(reversed.body.fields["query.lastVisitTo"]);
});

test("orden por gasto y por visitas: de mayor a menor, empates por nombre, cursor sin repetir ni saltear", async () => {
  const t = await createCrmTeam(db, app.baseUrl);
  await seed(t);
  async function allPages(sort: string, limit: number): Promise<string[]> {
    const names: string[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 20; i++) {
      const res: { status: number; body: any } = await t.owner.get(`/api/panel/clients?sort=${sort}&limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
      assert.equal(res.status, 200, JSON.stringify(res.body));
      names.push(...namesOf(res));
      cursor = res.body.data.nextCursor;
      if (!cursor) return names;
    }
    throw new Error("no terminó");
  }
  // Rita y Valeria empatan en gasto (300 000): las ordena el nombre.
  assert.deepEqual(await allPages("total_spent", 2), ["Rita Riesgo", "Valeria Vip", "Alicia Activa", "Mónica Manual", "Inés Inactiva", "Nadia Nueva"]);
  assert.deepEqual(await allPages("visit_count", 4), ["Valeria Vip", "Rita Riesgo", "Alicia Activa", "Mónica Manual", "Inés Inactiva", "Nadia Nueva"]);
  const first = await t.owner.get("/api/panel/clients?sort=total_spent&limit=1");
  assert.equal(first.body.data.items[0].totalSpentCents, 30_000_000);
  const mixed = await t.owner.get(`/api/panel/clients?sort=visit_count&cursor=${encodeURIComponent(first.body.data.nextCursor)}`);
  assert.equal(mixed.status, 400, "un cursor de otro orden no sirve");
});

test("chips: conteo por estado con los demás filtros (el de estado se ignora); etiquetas en uso", async () => {
  const t = await createCrmTeam(db, app.baseUrl);
  await seed(t);
  const counts = await t.owner.get("/api/panel/clients/status-counts?status=vip");
  assert.equal(counts.status, 200);
  assert.deepEqual(counts.body.data, { new: 1, active: 1, vip: 2, at_risk: 1, inactive: 1, total: 6 });
  const tagged = await t.owner.get("/api/panel/clients/status-counts?tag=Frecuente");
  assert.deepEqual(tagged.body.data, { new: 0, active: 1, vip: 1, at_risk: 0, inactive: 0, total: 2 });

  const tags = await t.owner.get("/api/panel/clients/tags");
  assert.deepEqual(tags.body.data, [
    { tag: "Frecuente", count: 2 },
    { tag: "frecuente", count: 1 },
    { tag: "Referida", count: 1 },
    { tag: "VIP", count: 1 },
  ]);
});

test("API pública (para los segmentos de Campañas): listClients y countClientsByStatus con los mismos filtros", async () => {
  const t = await createCrmTeam(db, app.baseUrl);
  const ids = await seed(t);
  const page = await listClients(db, t.businessId, { statuses: ["at_risk", "inactive"], sort: "total_spent" }, { withStatus: true });
  assert.deepEqual(
    page.items.map((c) => [c.id, c.status]),
    [
      [ids.riesgo, "at_risk"],
      [ids.inactiva, "inactive"],
    ],
  );
  const counts = await countClientsByStatus(db, t.businessId, { vip: true });
  assert.equal(counts.total, 3);
  // Sin `withStatus` (el Básico) no se calcula.
  assert.equal((await listClients(db, t.businessId, { limit: 1 })).items[0].status, null);
});
