import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { eq } from "drizzle-orm";

// ─────────────────────────────────────────────────────────────────────────────
// Ventas y comisiones por HTTP (I4) con la app real (planes reales de la composición)
// sobre PGlite como el rol de la app (RLS):
//   • gating: un negocio Básico recibe 403 `module_not_in_plan` en ventas y comisiones;
//   • permisos: dueño, admin y recepción cobran; las devoluciones son de dueño y admin; el
//     profesional no cobra y solo ve el saldo de SUS citas; recepción no ve comisiones;
//   • sucursal: recepción limitada a Escazú no cobra, no lista ni resume Heredia;
//   • métodos de pago (Configuración) y reglas de comisión (validaciones, duplicado 409);
//   • el circuito completo: completar → cobrar → comisión → liquidar → pagar, y "Mis
//     comisiones" (el profesional solo ve lo suyo; pedir otro profesional → 403).
// ─────────────────────────────────────────────────────────────────────────────

process.env.TRUST_PROXY = "loopback";
process.env.PANEL_SESSION_SECRET = "test-sales-session-secret-0123456789abcd";
process.env.TOKENS_ENCRYPTION_KEY = "d".repeat(64);
process.env.PANEL_LOGIN_RATE_LIMIT_MAX_IP = "500";

const { createAppHandler } = await import("../../src/app");
const { invalidateBusinessContext } = await import("../../src/modules/business");
const { businesses } = await import("../../src/modules/business/schema");
const { getClient } = await import("../../src/modules/clients");
const { seedDefaultPaymentMethods } = await import("../../src/modules/sales");
const { bookAppointment } = await import("../../src/modules/scheduling");
const { staff } = await import("../../src/modules/team/schema");
const { withTenant } = await import("../../src/platform/db/scope");
const { createEphemeralDb } = await import("../helpers/pgliteDb");
const { Browser, startTestServer } = await import("../helpers/panelClient");
const { createTestBusiness, createTestMember, ROOMY_EXTRAS } = await import("../helpers/identityFixtures");
const { createSchedulingWorld, crAt, crDay } = await import("../helpers/schedulingFixtures");

type B = InstanceType<typeof Browser>;
type World = Awaited<ReturnType<typeof createSchedulingWorld>>;
const API = "/api/panel";

const base = await createEphemeralDb();
const { db } = base;
let app: Awaited<ReturnType<typeof startTestServer>>;
let w: World;
let owner: B;
let admin: B;
let frontDesk: B;
let ana: B;
let loneStaff: B;
let cash: string;
let card: string;

async function loggedIn(email: string, password: string | null): Promise<B> {
  const b = new Browser(app.baseUrl);
  const res = await b.post(`${API}/auth/login`, { email, password });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return b;
}

before(async () => {
  await base.client.exec("SET ROLE app_runtime");
  app = await startTestServer(createAppHandler({ db, role: "all" }));
  w = await createSchedulingWorld(db);
  // Pro con cupos holgados (el mundo de la agenda nace Básico).
  await withTenant(db, w.businessId, (tx) => tx.update(businesses).set({ plan: "pro", extraModules: ROOMY_EXTRAS }).where(eq(businesses.id, w.businessId)));
  invalidateBusinessContext(w.businessId);
  const methods = await seedDefaultPaymentMethods(db, { businessId: w.businessId });
  cash = methods[0].id;
  card = methods[2].id;
  const member = async (role: "owner" | "admin" | "front_desk" | "staff", locationIds?: string[]) => {
    const m = await createTestMember(db, { businessId: w.businessId, role, locationIds });
    return { browser: await loggedIn(m.email, m.password), membershipId: m.membershipId };
  };
  owner = (await member("owner")).browser;
  admin = (await member("admin")).browser;
  frontDesk = (await member("front_desk", [w.escazu])).browser;
  const anaMember = await member("staff");
  ana = anaMember.browser;
  loneStaff = (await member("staff")).browser;
  await withTenant(db, w.businessId, (tx) => tx.update(staff).set({ membershipId: anaMember.membershipId }).where(eq(staff.id, w.ana)));
});

after(async () => {
  await app?.close();
  await base.close();
});

let daysAgo = 2;
/** Cita pasada (se puede completar) en `locationId`, con su profesional. */
async function pastAppointment(locationId = w.escazu, staffId = w.ana, serviceIds = [w.limpieza]) {
  daysAgo += 1;
  return bookAppointment(db, w.businessId, {
    locationId,
    clientId: w.maria,
    serviceIds,
    staffId,
    startsAt: crAt(crDay(-daysAgo), "09:00"),
    channel: "panel",
    allowOutsideHours: true,
  });
}

test("gating: un negocio Básico recibe 403 module_not_in_plan en ventas y comisiones", async () => {
  const basic = await createTestBusiness(db, { plan: "basic", locations: ["Central"] });
  const m = await createTestMember(db, { businessId: basic.businessId, role: "owner" });
  const b = await loggedIn(m.email, m.password);
  const id = "00000000-0000-4000-8000-000000000001";
  for (const [method, path] of [
    ["GET", "/settings/payment-methods"],
    ["GET", "/sales/payments"],
    ["GET", "/sales/pending"],
    ["GET", "/sales/summary"],
    ["GET", `/appointments/${id}/balance`],
    ["GET", "/settings/commission-rules"],
    ["GET", "/commissions/entries"],
    ["GET", "/commissions/summary"],
    ["GET", "/commissions/payouts"],
  ] as const) {
    const res = await b.request(method, `${API}${path}`);
    assert.equal(res.status, 403, `${path}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.code, "module_not_in_plan", path);
  }
  const charge = await b.post(`${API}/appointments/${id}/payments`, { amountCents: 100, methodId: id });
  assert.equal(charge.body.code, "module_not_in_plan");
  const rule = await b.post(`${API}/settings/commission-rules`, { kind: "percent", value: 1000 });
  assert.equal(rule.body.code, "module_not_in_plan");
  // En el Pro, el mismo dueño entraría: el plan del negocio de prueba sí incluye ventas.
  assert.equal((await owner.get(`${API}/sales/summary`)).status, 200);
});

test("métodos de pago: todos leen; dueño y admin crean, ordenan, editan y borran (con pagos se desactiva)", async () => {
  const list = await frontDesk.get(`${API}/settings/payment-methods`);
  assert.equal(list.status, 200);
  assert.deepEqual(list.body.data.map((m: { name: string }) => m.name), ["Efectivo", "SINPE Móvil", "Tarjeta", "Transferencia"]);
  assert.equal((await frontDesk.post(`${API}/settings/payment-methods`, { name: "Cripto" })).body.code, "forbidden_role");

  const created = await admin.post(`${API}/settings/payment-methods`, { name: "Vale de regalo" });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.data.position, 4);
  const dup = await admin.post(`${API}/settings/payment-methods`, { name: "vale de REGALO" });
  assert.equal(dup.status, 400);
  assert.ok(dup.body.fields["body.name"]);

  const ids = list.body.data.map((m: { id: string }) => m.id);
  const reordered = await owner.request("PUT", `${API}/settings/payment-methods/order`, { ids: [created.body.data.id, ...ids] });
  assert.equal(reordered.status, 200, JSON.stringify(reordered.body));
  assert.equal(reordered.body.data[0].name, "Vale de regalo");
  const bad = await owner.request("PUT", `${API}/settings/payment-methods/order`, { ids });
  assert.equal(bad.status, 400, "la lista tiene que traer todos");

  const renamed = await owner.patch(`${API}/settings/payment-methods/${created.body.data.id}`, { name: "Gift card", active: false });
  assert.deepEqual([renamed.body.data.name, renamed.body.data.active], ["Gift card", false]);
  // Un método inactivo no sirve para cobrar.
  const appt = await pastAppointment();
  const inactive = await owner.post(`${API}/appointments/${appt.id}/payments`, { amountCents: 100, methodId: created.body.data.id });
  assert.equal(inactive.status, 400);
  assert.ok(inactive.body.fields["body.methodId"]);

  const removed = await owner.request("DELETE", `${API}/settings/payment-methods/${created.body.data.id}`);
  assert.deepEqual(removed.body.data, { deleted: true });
  // Con pagos, borrar lo desactiva.
  const transfer = ids[3];
  assert.equal((await owner.post(`${API}/appointments/${appt.id}/payments`, { amountCents: 100, methodId: transfer })).status, 201);
  const kept = await owner.request("DELETE", `${API}/settings/payment-methods/${transfer}`);
  assert.equal(kept.body.data.deleted, false);
  assert.equal(kept.body.data.method.active, false);
  await owner.patch(`${API}/settings/payment-methods/${transfer}`, { active: true });
});

test("cobrar desde la cita: recepción cobra, el profesional no; sucursal ajena 403; saldo visible y gasto del cliente al día", async () => {
  const appt = await pastAppointment();
  const spentBefore = (await getClient(db, w.businessId, w.maria))?.totalSpentCents ?? 0;
  const deposit = await frontDesk.post(`${API}/appointments/${appt.id}/payments`, { kind: "deposit", amountCents: 1_000_000, methodId: cash, note: "Seña por SINPE" });
  assert.equal(deposit.status, 201, JSON.stringify(deposit.body));
  assert.equal(deposit.body.data.payment.kind, "deposit");
  assert.equal(deposit.body.data.balance.balanceCents, 1_500_000);
  assert.equal(deposit.body.data.balance.currency, "CRC");
  assert.equal((await getClient(db, w.businessId, w.maria))?.totalSpentCents, spentBefore + 1_000_000);

  const over = await frontDesk.post(`${API}/appointments/${appt.id}/payments`, { amountCents: 1_500_001, methodId: cash });
  assert.equal(over.status, 409);
  assert.equal(over.body.code, "amount_exceeds_balance");
  const wrongCurrency = await frontDesk.post(`${API}/appointments/${appt.id}/payments`, { amountCents: 100, methodId: cash, currency: "USD" });
  assert.equal(wrongCurrency.status, 400);
  assert.ok(wrongCurrency.body.fields["body.currency"]);
  const badAmount = await frontDesk.post(`${API}/appointments/${appt.id}/payments`, { amountCents: 10.5, methodId: cash });
  assert.equal(badAmount.status, 400);

  // El profesional no cobra, pero ve el saldo de SU cita; no el de otra.
  assert.equal((await ana.post(`${API}/appointments/${appt.id}/payments`, { amountCents: 100, methodId: cash })).body.code, "forbidden_role");
  const balance = await ana.get(`${API}/appointments/${appt.id}/balance`);
  assert.equal(balance.status, 200);
  assert.equal(balance.body.data.paidCents, 1_000_000);
  assert.equal(balance.body.data.payments[0].note, "Seña por SINPE");
  assert.equal((await loneStaff.get(`${API}/appointments/${appt.id}/balance`)).body.code, "own_appointments_only");

  // Recepción de Escazú no cobra una cita de Heredia.
  const heredia = await pastAppointment(w.heredia, w.carla, [w.pedicura]);
  const forbidden = await frontDesk.post(`${API}/appointments/${heredia.id}/payments`, { amountCents: 100, methodId: cash });
  assert.equal(forbidden.status, 403);
  assert.equal(forbidden.body.code, "location_forbidden");
  assert.equal((await owner.post(`${API}/appointments/${heredia.id}/payments`, { amountCents: 100, methodId: card })).status, 201);
  const missing = await owner.post(`${API}/appointments/00000000-0000-4000-8000-000000000009/payments`, { amountCents: 100, methodId: cash });
  assert.equal(missing.status, 404);
});

test("devoluciones solo de dueño y admin, con motivo y sin pasar lo cobrado", async () => {
  const appt = await pastAppointment();
  const charged = await frontDesk.post(`${API}/appointments/${appt.id}/payments`, { amountCents: 2_500_000, methodId: cash });
  const paymentId = charged.body.data.payment.id;
  assert.equal((await frontDesk.post(`${API}/sales/payments/${paymentId}/refund`, { amountCents: 100, reason: "x" })).body.code, "forbidden_role");
  assert.equal((await ana.post(`${API}/sales/payments/${paymentId}/refund`, { amountCents: 100, reason: "x" })).body.code, "forbidden_role");
  const noReason = await admin.post(`${API}/sales/payments/${paymentId}/refund`, { amountCents: 100, reason: " " });
  assert.equal(noReason.status, 400);
  assert.ok(noReason.body.fields["body.reason"]);
  const refund = await admin.post(`${API}/sales/payments/${paymentId}/refund`, { amountCents: 500_000, reason: "Tardó demasiado" });
  assert.equal(refund.status, 201, JSON.stringify(refund.body));
  assert.equal(refund.body.data.original.refundedCents, 500_000);
  const tooMuch = await owner.post(`${API}/sales/payments/${paymentId}/refund`, { amountCents: 2_000_001, reason: "x" });
  assert.equal(tooMuch.status, 409);
  assert.equal(tooMuch.body.code, "amount_exceeds_refundable");
});

test("cobros, pendientes y caja del día por HTTP: filtros, sucursal de la sesión y cobro suelto", async () => {
  const loose = await frontDesk.post(`${API}/sales/payments`, { clientId: w.sofia, locationId: w.escazu, kind: "deposit", amountCents: 300_000, methodId: cash });
  assert.equal(loose.status, 201, JSON.stringify(loose.body));
  assert.equal(loose.body.data.appointmentId, null);
  const looseHeredia = await frontDesk.post(`${API}/sales/payments`, { clientId: w.sofia, locationId: w.heredia, amountCents: 1, methodId: cash });
  assert.equal(looseHeredia.body.code, "location_forbidden");

  const today = crDay(0);
  const mine = await frontDesk.get(`${API}/sales/payments?from=${today}&to=${today}`);
  assert.equal(mine.status, 200);
  assert.ok(mine.body.data.items.length > 0);
  assert.ok(mine.body.data.items.every((p: { locationId: string }) => p.locationId === w.escazu), "recepción ve solo su sucursal");
  assert.equal((await frontDesk.get(`${API}/sales/payments?locationId=${w.heredia}`)).body.code, "location_forbidden");
  assert.equal((await frontDesk.get(`${API}/sales/payments`, { "x-location-id": w.heredia })).body.code, "location_forbidden");
  const all = await owner.get(`${API}/sales/payments?from=${today}&to=${today}`);
  assert.ok(all.body.data.items.some((p: { locationId: string }) => p.locationId === w.heredia), "el dueño ve todas");
  const sofiaOnly = await owner.get(`${API}/sales/payments?clientId=${w.sofia}&kind=deposit`);
  assert.ok(sofiaOnly.body.data.items.every((p: { clientId: string; kind: string }) => p.clientId === w.sofia && p.kind === "deposit"));
  const badRange = await owner.get(`${API}/sales/payments?from=${today}&to=${crDay(-1)}`);
  assert.equal(badRange.status, 400);
  assert.equal((await ana.get(`${API}/sales/payments`)).body.code, "forbidden_role");

  // Pendientes: una cita completada sin cobrar del todo.
  const appt = await pastAppointment();
  await owner.post(`${API}/appointments/${appt.id}/complete`);
  await owner.post(`${API}/appointments/${appt.id}/payments`, { amountCents: 1_000_000, methodId: cash });
  const pending = await frontDesk.get(`${API}/sales/pending`);
  assert.equal(pending.status, 200);
  const item = pending.body.data.items.find((i: { appointment: { id: string } }) => i.appointment.id === appt.id);
  assert.ok(item, JSON.stringify(pending.body.data));
  assert.equal(item.balanceCents, 1_500_000);

  const summary = await frontDesk.get(`${API}/sales/summary?date=${today}`);
  assert.equal(summary.status, 200);
  assert.equal(summary.body.data.locationId, null);
  assert.ok(summary.body.data.totals.collectedCents > 0);
  assert.ok(summary.body.data.byMethod.some((m: { name: string }) => m.name === "Efectivo"));
  const escazu = await owner.get(`${API}/sales/summary?locationId=${w.escazu}`);
  assert.equal(escazu.body.data.locationId, w.escazu);
  assert.equal(escazu.body.data.date, today);
  assert.equal((await frontDesk.get(`${API}/sales/summary?locationId=${w.heredia}`)).body.code, "location_forbidden");
});

test("comisiones por HTTP: reglas, cálculo al completar y cobrar, liquidar, pagar y Mis comisiones", async () => {
  // Reglas: validaciones y duplicado.
  assert.equal((await frontDesk.get(`${API}/settings/commission-rules`)).body.code, "forbidden_role");
  const tooHigh = await owner.post(`${API}/settings/commission-rules`, { kind: "percent", value: 10_001 });
  assert.equal(tooHigh.status, 400);
  assert.ok(tooHigh.body.fields["body.value"]);
  const both = await owner.post(`${API}/settings/commission-rules`, { serviceId: w.limpieza, categoryId: w.limpieza, kind: "percent", value: 100 });
  assert.equal(both.status, 400);
  const foreign = await owner.post(`${API}/settings/commission-rules`, { staffId: "00000000-0000-4000-8000-000000000003", kind: "percent", value: 100 });
  assert.equal(foreign.status, 400);
  assert.ok(foreign.body.fields["body.staffId"]);
  const general = await owner.post(`${API}/settings/commission-rules`, { kind: "percent", value: 1000 });
  assert.equal(general.status, 201, JSON.stringify(general.body));
  assert.equal(general.body.data.scope, "general");
  const duplicate = await admin.post(`${API}/settings/commission-rules`, { kind: "fixed", value: 500 });
  assert.equal(duplicate.status, 409);
  assert.equal(duplicate.body.code, "duplicate_rule");
  const anaRule = await admin.post(`${API}/settings/commission-rules`, { staffId: w.ana, serviceId: w.limpieza, kind: "percent", value: 2000 });
  assert.equal(anaRule.body.data.scope, "staff_service");
  const rules = await owner.get(`${API}/settings/commission-rules`);
  assert.deepEqual(rules.body.data.map((r: { scope: string }) => r.scope), ["staff_service", "general"], "de la más específica a la general");
  const patched = await owner.patch(`${API}/settings/commission-rules/${general.body.data.id}`, { kind: "percent", value: 20_000 });
  assert.equal(patched.status, 400);

  // Ana: limpieza al 20 %; Carla: la general (10 %).
  const anaAppt = await pastAppointment();
  const carlaAppt = await pastAppointment(w.heredia, w.carla, [w.pedicura]);
  for (const a of [anaAppt, carlaAppt]) assert.equal((await owner.post(`${API}/appointments/${a.id}/complete`)).status, 200);
  await frontDesk.post(`${API}/appointments/${anaAppt.id}/payments`, { amountCents: 2_500_000, methodId: cash });
  await owner.post(`${API}/appointments/${carlaAppt.id}/payments`, { amountCents: 1_200_000, methodId: card });

  const range = `from=${crDay(-60)}&to=${crDay(0)}`;
  const all = await owner.get(`${API}/commissions/entries?${range}`);
  assert.equal(all.status, 200, JSON.stringify(all.body));
  const byAppt = (id: string) => all.body.data.items.find((e: { appointmentId: string }) => e.appointmentId === id);
  assert.equal(byAppt(anaAppt.id).amountCents, 500_000);
  assert.equal(byAppt(anaAppt.id).serviceName, "Limpieza");
  assert.equal(byAppt(carlaAppt.id).amountCents, 120_000);

  // Mis comisiones: Ana ve solo lo suyo; pedir lo de otra → 403; sin profesional vinculado, nada.
  const mine = await ana.get(`${API}/commissions/entries?${range}`);
  assert.equal(mine.status, 200);
  assert.ok(mine.body.data.items.length > 0);
  assert.ok(mine.body.data.items.every((e: { staffId: string }) => e.staffId === w.ana));
  assert.equal((await ana.get(`${API}/commissions/entries?staffId=${w.carla}`)).body.code, "own_commissions_only");
  const mySummary = await ana.get(`${API}/commissions/summary?${range}`);
  assert.deepEqual(mySummary.body.data.rows.map((r: { staffId: string }) => r.staffId), [w.ana]);
  assert.deepEqual((await loneStaff.get(`${API}/commissions/entries`)).body.data.items, []);
  assert.equal((await frontDesk.get(`${API}/commissions/entries`)).body.code, "forbidden_role");
  assert.equal((await frontDesk.get(`${API}/commissions/summary`)).body.code, "forbidden_role");

  // Liquidar a Ana: solo dueño/admin con acceso a todas las sucursales; el profesional ve sus liquidaciones.
  const payoutBody = { staffId: w.ana, periodStart: crDay(-60), periodEnd: crDay(0) };
  assert.equal((await ana.post(`${API}/commissions/payouts`, payoutBody)).body.code, "forbidden_role");
  const payout = await admin.post(`${API}/commissions/payouts`, payoutBody);
  assert.equal(payout.status, 201, JSON.stringify(payout.body));
  assert.ok(payout.body.data.totalCents >= 500_000);
  const again = await admin.post(`${API}/commissions/payouts`, payoutBody);
  assert.equal(again.body.code, "nothing_to_pay");
  const badPeriod = await admin.post(`${API}/commissions/payouts`, { ...payoutBody, periodStart: crDay(1) });
  assert.equal(badPeriod.status, 400);
  const paid = await owner.post(`${API}/commissions/payouts/${payout.body.data.id}/paid`);
  assert.equal(paid.status, 200);
  assert.ok(paid.body.data.paidAt);
  assert.equal((await owner.request("DELETE", `${API}/commissions/payouts/${payout.body.data.id}`)).body.code, "already_paid");
  const myPayouts = await ana.get(`${API}/commissions/payouts`);
  assert.deepEqual(myPayouts.body.data.map((p: { id: string }) => p.id), [payout.body.data.id]);
  assert.equal((await ana.get(`${API}/commissions/payouts?staffId=${w.carla}`)).body.code, "own_commissions_only");
  const paidEntries = await ana.get(`${API}/commissions/entries?${range}&status=paid`);
  assert.ok(paidEntries.body.data.items.length > 0);
  assert.ok(paidEntries.body.data.items.every((e: { status: string; payoutId: string }) => e.status === "paid" && e.payoutId === payout.body.data.id));

  // Borrar la regla no borra lo calculado.
  assert.equal((await owner.request("DELETE", `${API}/settings/commission-rules/${anaRule.body.data.id}`)).status, 204);
  assert.ok((await ana.get(`${API}/commissions/entries?${range}`)).body.data.items.length > 0);
});
