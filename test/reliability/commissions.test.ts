import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { eq } from "drizzle-orm";
import { serviceCategories, services } from "../../src/modules/catalog/schema";
import {
  commissionFor,
  createPayout,
  deletePayout,
  getCommissionSummary,
  listCommissionEntries,
  listPayouts,
  markPayoutPaid,
  recalculateAppointmentCommissions,
  resolveRule,
  type CommissionRuleView,
} from "../../src/modules/commissions";
import { commissionRules } from "../../src/modules/commissions/schema";
import { recordAppointmentPayment, refundPayment, seedDefaultPaymentMethods } from "../../src/modules/sales";
import { bookAppointment, completeAppointment } from "../../src/modules/scheduling";
import { withTenant } from "../../src/platform/db/scope";
import { HttpError } from "../../src/platform/http/errors";
import { createEphemeralDb } from "../helpers/pgliteDb";
import { createSchedulingWorld, crAt, crDay, type SchedulingWorld } from "../helpers/schedulingFixtures";

// ─────────────────────────────────────────────────────────────────────────────
// Comisiones sobre Postgres real (PGlite) con el rol de la app: precedencia de reglas,
// cálculo SOBRE LO COBRADO por línea (prorrateo con varios servicios), recálculo con cada
// cobro y devolución (los ganchos que inyecta la composición), la copia de la regla,
// liquidación (lo liquidado no se recalcula: la diferencia va en un ajuste), pagar y
// anular una liquidación, y el resumen por profesional.
// ─────────────────────────────────────────────────────────────────────────────

const base = await createEphemeralDb();
const { db } = base;
after(() => base.close());

let w: SchedulingWorld;
let cash: string;
let facial: string;

const recalc = (tx: Parameters<typeof recalculateAppointmentCommissions>[0], businessId: string, appointmentId: string) =>
  recalculateAppointmentCommissions(tx, businessId, appointmentId);

before(async () => {
  await base.client.exec("SET ROLE app_runtime");
  w = await createSchedulingWorld(db);
  [{ id: cash }] = await seedDefaultPaymentMethods(db, { businessId: w.businessId });
  // Limpieza en la categoría "Facial"; el resto sin categoría.
  facial = await withTenant(db, w.businessId, async (tx) => {
    const [cat] = await tx.insert(serviceCategories).values({ businessId: w.businessId, name: "Facial" }).returning({ id: serviceCategories.id });
    await tx.update(services).set({ categoryId: cat.id }).where(eq(services.id, w.limpieza));
    return cat.id;
  });
});

type Rule = { staffId?: string | null; serviceId?: string | null; categoryId?: string | null; kind: "percent" | "fixed"; value: number };

async function setRules(businessId: string, rules: Rule[]): Promise<void> {
  await withTenant(db, businessId, async (tx) => {
    await tx.delete(commissionRules).where(eq(commissionRules.businessId, businessId));
    if (rules.length) await tx.insert(commissionRules).values(rules.map((r) => ({ businessId, staffId: null, serviceId: null, categoryId: null, ...r })));
  });
}

let daysAgo = 4;
/** Cita pasada de `staffId` en Escazú (cada una otro día, para no encimarse). */
async function pastAppointment(serviceIds: string[], staffId = w.ana) {
  daysAgo += 1;
  return bookAppointment(db, w.businessId, {
    locationId: w.escazu,
    clientId: w.maria,
    serviceIds,
    staffId,
    startsAt: crAt(crDay(-daysAgo), "09:00"),
    channel: "panel",
    allowOutsideHours: true,
  });
}

const complete = (id: string) => completeAppointment(db, w.businessId, id, { onCompleted: recalc });
const pay = (appointmentId: string, amountCents: number, kind: "deposit" | "payment" = "payment") =>
  recordAppointmentPayment(db, w.businessId, { appointmentId, kind, amountCents, methodId: cash, recordedBy: null, onPaymentsChanged: recalc });
const refund = (paymentId: string, amountCents: number) =>
  refundPayment(db, w.businessId, { paymentId, amountCents, reason: "Devolución de prueba", recordedBy: null, onPaymentsChanged: recalc });

const wide = { from: new Date(Date.now() - 400 * 86_400_000), to: new Date(Date.now() + 400 * 86_400_000) };
async function entriesOf(appointmentId: string) {
  const { items } = await listCommissionEntries(db, w.businessId, wide);
  return items.filter((e) => e.appointmentId === appointmentId).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}
const amounts = (items: { serviceName: string | null; amountCents: number }[]) =>
  Object.fromEntries(items.map((e) => [e.serviceName, e.amountCents]));

test("precedencia: profesional+servicio → servicio → categoría → profesional → general (solo activas)", () => {
  const rule = (id: string, scope: CommissionRuleView["scope"], fields: Partial<CommissionRuleView>, active = true): CommissionRuleView => ({
    id,
    scope,
    staffId: null,
    serviceId: null,
    categoryId: null,
    kind: "percent",
    value: 1000,
    active,
    createdAt: "",
    updatedAt: "",
    ...fields,
  });
  const rules = [
    rule("general", "general", {}),
    rule("staff", "staff", { staffId: "S1" }),
    rule("category", "category", { categoryId: "C1" }),
    rule("service", "service", { serviceId: "V1" }),
    rule("staff_service", "staff_service", { staffId: "S1", serviceId: "V1" }),
    rule("off", "staff_service", { staffId: "S2", serviceId: "V1" }, false),
  ];
  const pick = (staffId: string, serviceId: string | null, categoryId: string | null) => resolveRule(rules, { staffId, serviceId, categoryId })?.id ?? null;
  assert.equal(pick("S1", "V1", "C1"), "staff_service");
  assert.equal(pick("S2", "V1", "C1"), "service", "la de S2 está inactiva");
  assert.equal(pick("S2", "V2", "C1"), "category");
  assert.equal(pick("S1", "V2", "C2"), "staff");
  assert.equal(pick("S2", "V2", null), "general");
  assert.equal(pick("S2", null, null), "general", "una línea de un servicio borrado");
  assert.equal(resolveRule([], { staffId: "S1", serviceId: "V1", categoryId: null }), null);
});

test("cálculo: porcentaje sobre lo cobrado; fijo prorrateado por la parte cobrada de la línea", () => {
  assert.equal(commissionFor({ ruleId: null, kind: "percent", value: 1500 }, 2_000_000, 2_500_000), 300_000);
  assert.equal(commissionFor({ ruleId: null, kind: "fixed", value: 500_000 }, 1_250_000, 2_500_000), 250_000);
  assert.equal(commissionFor({ ruleId: null, kind: "fixed", value: 500_000 }, 2_500_000, 2_500_000), 500_000);
  assert.equal(commissionFor({ ruleId: null, kind: "fixed", value: 500_000 }, 0, 0), 500_000, "servicio sin precio: el fijo entero");
});

test("sobre lo cobrado, por línea: sin cobros no hay movimiento; un cobro parcial se prorratea entre servicios", async () => {
  await setRules(w.businessId, [
    { kind: "percent", value: 1000 }, // general 10 %
    { serviceId: w.manicura, kind: "percent", value: 2000 }, // manicura 20 %
    { staffId: w.ana, serviceId: w.limpieza, kind: "percent", value: 3000 }, // Ana en limpieza 30 %
    { categoryId: facial, kind: "percent", value: 2500 }, // pierde contra la de Ana
  ]);
  const appt = await pastAppointment([w.limpieza, w.manicura]); // 25 000 + 8 000
  await pay(appt.id, 1_000_000, "deposit"); // seña: la cita todavía no se completó
  assert.deepEqual(await entriesOf(appt.id), [], "antes de completar no hay comisión");
  await complete(appt.id);
  // ₡10 000 cobrados de ₡33 000: Limpieza 7 576 (30 %) y Manicura 2 424 (20 %).
  let entries = await entriesOf(appt.id);
  assert.deepEqual(amounts(entries), { Limpieza: 227_273, Manicura: 48_485 });
  assert.equal(entries.find((e) => e.serviceName === "Limpieza")?.baseCents, 757_576);
  assert.equal(entries.reduce((n, e) => n + e.baseCents, 0), 1_000_000, "la suma de las bases es lo cobrado");
  assert.deepEqual(entries.find((e) => e.serviceName === "Limpieza")?.rule.value, 3000);
  assert.ok(entries.every((e) => e.status === "pending" && e.payoutId === null && !e.adjustment));
  assert.equal(entries[0].earnedAt, appt.startsAt, "se gana el día de la cita");

  await pay(appt.id, 2_300_000); // el resto
  entries = await entriesOf(appt.id);
  assert.equal(entries.length, 2, "recalcular actualiza, no duplica");
  assert.deepEqual(amounts(entries), { Limpieza: 750_000, Manicura: 160_000 });
});

test("recálculo con devolución, y la regla queda copiada (cambiarla no reescribe lo calculado)", async () => {
  await setRules(w.businessId, [{ kind: "percent", value: 1000 }]);
  const appt = await pastAppointment([w.pedicura]); // 12 000
  await complete(appt.id);
  assert.deepEqual(await entriesOf(appt.id), [], "completada sin cobrar: nada todavía");
  const { payment } = await pay(appt.id, 1_200_000);
  assert.deepEqual(amounts(await entriesOf(appt.id)), { Pedicura: 120_000 });

  await setRules(w.businessId, [{ kind: "percent", value: 5000 }]);
  await refund(payment.id, 200_000);
  // Sigue con el 10 % con el que nació, sobre ₡10 000.
  const [entry] = await entriesOf(appt.id);
  assert.equal(entry.amountCents, 100_000);
  assert.equal(entry.baseCents, 1_000_000);
  assert.equal(entry.rule.value, 1000);

  await refund(payment.id, 1_000_000);
  assert.deepEqual(await entriesOf(appt.id), [], "todo devuelto: sin comisión abierta");
});

test("fijo por línea y categoría; sin regla aplicable no hay movimiento", async () => {
  await setRules(w.businessId, [
    { categoryId: facial, kind: "fixed", value: 400_000 }, // ₡4 000 por limpieza
  ]);
  const appt = await pastAppointment([w.limpieza, w.manicura]);
  await complete(appt.id);
  await pay(appt.id, 1_650_000); // mitad
  assert.deepEqual(amounts(await entriesOf(appt.id)), { Limpieza: 200_000 }, "manicura no tiene regla");
});

test("liquidación: junta lo abierto, lo liquidado no se recalcula (va un ajuste), se paga, y se puede anular sin pagar", async () => {
  const world = await createSchedulingWorld(db);
  const [{ id: method }] = await seedDefaultPaymentMethods(db, { businessId: world.businessId });
  await setRules(world.businessId, [{ kind: "percent", value: 1000 }]);
  const book = (hm: string, daysAgo: number, staffId = world.ana) =>
    bookAppointment(db, world.businessId, {
      locationId: world.escazu,
      clientId: world.maria,
      serviceIds: [world.limpieza],
      staffId,
      startsAt: crAt(crDay(-daysAgo), hm),
      channel: "panel",
      allowOutsideHours: true,
    });
  const charge = (appointmentId: string, amountCents: number) =>
    recordAppointmentPayment(db, world.businessId, { appointmentId, kind: "payment", amountCents, methodId: method, recordedBy: null, onPaymentsChanged: recalc });
  const entries = async (filter: Partial<Parameters<typeof listCommissionEntries>[2]> = {}) =>
    (await listCommissionEntries(db, world.businessId, { ...wide, ...filter })).items;

  const a1 = await book("09:00", 10);
  const a2 = await book("10:00", 9);
  const beto = await book("14:00", 9, world.beto);
  for (const a of [a1, a2, beto]) await completeAppointment(db, world.businessId, a.id, { onCompleted: recalc });
  const p1 = await charge(a1.id, 2_500_000); // ₡2 500 de comisión
  await charge(a2.id, 1_000_000); // parcial: ₡1 000
  await charge(beto.id, 3_000_000);

  const periodStart = crDay(-30);
  const periodEnd = crDay(0);
  const payout = await createPayout(db, world.businessId, { staffId: world.ana, periodStart, periodEnd, note: "Quincena" });
  assert.equal(payout.totalCents, 350_000);
  assert.equal(payout.entryCount, 2);
  assert.equal(payout.staff?.name, "Ana");
  assert.equal(payout.paidAt, null);
  assert.equal((await entries({ status: "in_payout" })).length, 2);
  assert.equal((await entries({ status: "open", staffId: world.beto })).length, 1, "lo de Beto queda abierto");
  await assert.rejects(createPayout(db, world.businessId, { staffId: world.ana, periodStart, periodEnd }), (e: unknown) => e instanceof HttpError && e.code === "nothing_to_pay");

  // Cobro del resto DESPUÉS de liquidar: lo liquidado no cambia; la diferencia va en un ajuste abierto.
  await charge(a2.id, 1_500_000);
  const a2Entries = (await entries()).filter((e) => e.appointmentId === a2.id).sort((x, y) => x.createdAt.localeCompare(y.createdAt));
  assert.deepEqual(
    a2Entries.map((e) => [e.amountCents, e.payoutId === payout.id, e.adjustment]),
    [
      [100_000, true, false],
      [150_000, false, true],
    ],
  );
  // Devolución DESPUÉS de liquidar: ajuste negativo.
  await refundPayment(db, world.businessId, { paymentId: p1.payment.id, amountCents: 500_000, reason: "Queja", recordedBy: null, onPaymentsChanged: recalc });
  const a1Entries = (await entries()).filter((e) => e.appointmentId === a1.id);
  assert.deepEqual(a1Entries.map((e) => e.amountCents).sort((x, y) => x - y), [-50_000, 250_000]);
  assert.equal(a1Entries.find((e) => e.payoutId === payout.id)?.amountCents, 250_000, "lo liquidado no se recalcula");

  // Pagar la liquidación.
  const paid = await markPayoutPaid(db, world.businessId, payout.id, { paidBy: null });
  assert.ok(paid.paidAt);
  assert.ok((await entries({ payoutId: payout.id })).every((e) => e.status === "paid"));
  await assert.rejects(markPayoutPaid(db, world.businessId, payout.id, { paidBy: null }), (e: unknown) => e instanceof HttpError && e.code === "already_paid");
  await assert.rejects(deletePayout(db, world.businessId, payout.id), (e: unknown) => e instanceof HttpError && e.code === "already_paid");

  // Siguiente liquidación: los ajustes (+1 500 − 500 = ₡1 000).
  const next = await createPayout(db, world.businessId, { staffId: world.ana, periodStart: crDay(-1), periodEnd });
  assert.equal(next.totalCents, 100_000);
  assert.equal(next.entryCount, 2);
  // Anularla devuelve sus movimientos a abiertos (y los recalcula).
  await deletePayout(db, world.businessId, next.id);
  const reopened = await entries({ status: "open", staffId: world.ana });
  assert.deepEqual(reopened.map((e) => e.amountCents).sort((x, y) => x - y), [-50_000, 150_000]);
  assert.deepEqual(
    (await listPayouts(db, world.businessId, { staffId: world.ana })).map((p) => p.id),
    [payout.id],
  );

  // Resumen por profesional del período.
  const summary = await getCommissionSummary(db, world.businessId, wide);
  const ana = summary.rows.find((r) => r.staffId === world.ana);
  assert.ok(ana);
  assert.equal(ana.paidCents, 350_000);
  assert.equal(ana.openCents, 100_000);
  assert.equal(ana.inPayoutCents, 0);
  assert.equal(summary.rows.find((r) => r.staffId === world.beto)?.openCents, 300_000);
  assert.equal(summary.totals.amountCents, 750_000);
  const onlyBeto = await getCommissionSummary(db, world.businessId, { ...wide, staffId: world.beto });
  assert.deepEqual(onlyBeto.rows.map((r) => r.name), ["Beto"]);
});

test("sin reglas (p. ej. un negocio Básico) completar y cobrar no generan movimientos", async () => {
  const world = await createSchedulingWorld(db);
  const [{ id: method }] = await seedDefaultPaymentMethods(db, { businessId: world.businessId });
  const appt = await bookAppointment(db, world.businessId, {
    locationId: world.escazu,
    clientId: world.maria,
    serviceIds: [world.limpieza],
    staffId: world.ana,
    startsAt: crAt(crDay(-1), "09:00"),
    channel: "panel",
    allowOutsideHours: true,
  });
  await completeAppointment(db, world.businessId, appt.id, { onCompleted: recalc });
  await recordAppointmentPayment(db, world.businessId, { appointmentId: appt.id, kind: "payment", amountCents: 2_500_000, methodId: method, recordedBy: null, onPaymentsChanged: recalc });
  assert.equal((await listCommissionEntries(db, world.businessId, wide)).count, 0);
});
