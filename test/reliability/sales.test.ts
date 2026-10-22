import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createBusiness } from "../../src/modules/business";
import { getClient } from "../../src/modules/clients";
import {
  getAppointmentBalance,
  getCollectedTotals,
  getDailySummary,
  listPaymentMethods,
  listPayments,
  listPendingBalances,
  prorateByPrice,
  recordAppointmentPayment,
  recordClientPayment,
  refundPayment,
  seedDefaultPaymentMethods,
  type PaymentMethodView,
} from "../../src/modules/sales";
import { bookAppointment, cancelAppointment, completeAppointment } from "../../src/modules/scheduling";
import { HttpError, ValidationError } from "../../src/platform/http/errors";
import { PROVISIONING_STEPS } from "../../src/provisioning";
import { createEphemeralDb } from "../helpers/pgliteDb";
import { createSchedulingWorld, CR, crAt, crDay, type SchedulingWorld } from "../helpers/schedulingFixtures";

// ─────────────────────────────────────────────────────────────────────────────
// Ventas sobre Postgres real (PGlite) con el rol de la app (RLS): saldo de una cita con
// señas y cobros, pendientes, tope del saldo, devoluciones (parciales, totales, nunca más
// de lo cobrado), cobros simultáneos, cita cancelada, moneda y método, gasto total del
// cliente, cobro suelto, caja del día por método, los totales cobrados para Reportes
// (por método, profesional y servicio con prorrateo) y los métodos default del alta.
// ─────────────────────────────────────────────────────────────────────────────

const base = await createEphemeralDb();
const { db } = base;
after(() => base.close());

let w: SchedulingWorld;
let methods: Record<string, PaymentMethodView>;

before(async () => {
  await base.client.exec("SET ROLE app_runtime");
  w = await createSchedulingWorld(db);
  methods = Object.fromEntries((await seedDefaultPaymentMethods(db, { businessId: w.businessId })).map((m) => [m.name, m]));
});

const isHttp = (status: number, code: string) => (e: unknown) => e instanceof HttpError && e.status === status && e.code === code;
const isField = (field: string) => (e: unknown) => e instanceof ValidationError && field in e.fields;

/** Cita ya pasada (se puede completar) de Ana en Escazú: Limpieza ₡25 000 + Manicura ₡8 000. */
async function pastAppointment(daysAgo: number, hm = "09:00", clientId = w.maria, serviceIds = [w.limpieza, w.manicura]) {
  return bookAppointment(db, w.businessId, {
    locationId: w.escazu,
    clientId,
    serviceIds,
    staffId: w.ana,
    startsAt: crAt(crDay(-daysAgo), hm),
    channel: "panel",
    allowOutsideHours: true,
  });
}

function pay(appointmentId: string, amountCents: number, kind: "deposit" | "payment" = "payment", method = "Efectivo") {
  return recordAppointmentPayment(db, w.businessId, { appointmentId, kind, amountCents, methodId: methods[method].id, recordedBy: null });
}

test("métodos de pago: el negocio nace con los cuatro default (alta real) y sembrar dos veces no duplica", async () => {
  const { business } = await createBusiness(
    db,
    { name: "Uñas Prueba", industry: "nails", timezone: CR, currency: "CRC", country: "CR", locationName: "Centro" },
    PROVISIONING_STEPS,
  );
  const seeded = await listPaymentMethods(db, business.id);
  assert.deepEqual(
    seeded.map((m) => [m.name, m.position, m.active]),
    [
      ["Efectivo", 0, true],
      ["SINPE Móvil", 1, true],
      ["Tarjeta", 2, true],
      ["Transferencia", 3, true],
    ],
  );
  await seedDefaultPaymentMethods(db, { businessId: business.id });
  assert.equal((await listPaymentMethods(db, business.id)).length, 4);
});

test("saldo y pendientes: seña antes de la cita, cobro después, nunca más que el saldo", async () => {
  const appt = await pastAppointment(3);
  assert.equal(appt.totalCents, 3_300_000);

  const deposit = await pay(appt.id, 1_000_000, "deposit", "SINPE Móvil");
  assert.equal(deposit.payment.kind, "deposit");
  assert.equal(deposit.payment.method?.name, "SINPE Móvil");
  assert.equal(deposit.balance.depositsCents, 1_000_000);
  assert.equal(deposit.balance.balanceCents, 2_300_000);
  await assert.rejects(pay(appt.id, 2_300_001, "deposit"), isHttp(409, "amount_exceeds_balance"));

  // Mientras no esté completada no es "pendiente de cobro".
  const window = { from: new Date(Date.now() - 30 * 86_400_000), to: new Date(Date.now() + 86_400_000) };
  assert.ok(!(await listPendingBalances(db, w.businessId, window)).items.some((i) => i.appointment.id === appt.id));

  await completeAppointment(db, w.businessId, appt.id);
  const pending = await listPendingBalances(db, w.businessId, window);
  const item = pending.items.find((i) => i.appointment.id === appt.id);
  assert.ok(item, "completada con saldo: aparece en Pendientes");
  assert.equal(item.paidCents, 1_000_000);
  assert.equal(item.balanceCents, 2_300_000);
  // Acotado por sucursal: en Heredia no está.
  assert.ok(!(await listPendingBalances(db, w.businessId, { ...window, locationIds: [w.heredia] })).items.some((i) => i.appointment.id === appt.id));

  await assert.rejects(pay(appt.id, 500_000, "deposit"), isHttp(409, "deposit_not_allowed"));
  await assert.rejects(pay(appt.id, 2_300_001), isHttp(409, "amount_exceeds_balance"));
  const paid = await pay(appt.id, 2_300_000, "payment", "Tarjeta");
  assert.equal(paid.balance.balanceCents, 0);
  assert.equal(paid.balance.paidCents, 3_300_000);
  assert.deepEqual(
    paid.balance.payments.map((p) => p.kind),
    ["payment", "deposit"],
  );
  assert.ok(!(await listPendingBalances(db, w.businessId, window)).items.some((i) => i.appointment.id === appt.id));
  await assert.rejects(pay(appt.id, 1), (e: unknown) => isHttp(409, "amount_exceeds_balance")(e) && /ya está pagada/.test((e as Error).message));
});

test("devoluciones: parcial y total de un pago, nunca más de lo cobrado; devolver deja saldo otra vez", async () => {
  const appt = await pastAppointment(4, "10:00");
  await completeAppointment(db, w.businessId, appt.id);
  const { payment } = await pay(appt.id, 3_300_000);

  const partial = await refundPayment(db, w.businessId, { paymentId: payment.id, amountCents: 500_000, reason: "Descuento por demora", recordedBy: null });
  assert.equal(partial.refund.kind, "refund");
  assert.equal(partial.refund.refundOfId, payment.id);
  assert.equal(partial.refund.note, "Descuento por demora");
  assert.equal(partial.refund.method?.name, "Efectivo", "por defecto se devuelve por el mismo método");
  assert.equal(partial.original.refundedCents, 500_000);
  const balance = await getAppointmentBalance(db, w.businessId, appt.id);
  assert.equal(balance.refundsCents, 500_000);
  assert.equal(balance.balanceCents, 500_000, "las devoluciones restan de lo cobrado");

  await assert.rejects(
    refundPayment(db, w.businessId, { paymentId: payment.id, amountCents: 2_800_001, reason: "x", recordedBy: null }),
    isHttp(409, "amount_exceeds_refundable"),
  );
  const rest = await refundPayment(db, w.businessId, {
    paymentId: payment.id,
    amountCents: 2_800_000,
    reason: "Cliente insatisfecha",
    methodId: methods["SINPE Móvil"].id,
    recordedBy: null,
  });
  assert.equal(rest.refund.method?.name, "SINPE Móvil");
  assert.equal(rest.original.refundedCents, 3_300_000);
  await assert.rejects(
    refundPayment(db, w.businessId, { paymentId: payment.id, amountCents: 1, reason: "x", recordedBy: null }),
    (e: unknown) => isHttp(409, "amount_exceeds_refundable")(e) && /entero/.test((e as Error).message),
  );
  await assert.rejects(refundPayment(db, w.businessId, { paymentId: rest.refund.id, amountCents: 1, reason: "x", recordedBy: null }), isHttp(409, "not_refundable"));
  await assert.rejects(refundPayment(db, w.businessId, { paymentId: payment.id, amountCents: 1, reason: "  ", recordedBy: null }), isField("body.reason"));
});

test("cobros simultáneos del mismo saldo: uno gana, el otro ve el saldo nuevo (409)", async () => {
  const appt = await pastAppointment(5, "11:00");
  await completeAppointment(db, w.businessId, appt.id);
  const results = await Promise.allSettled([pay(appt.id, 3_300_000), pay(appt.id, 3_300_000), pay(appt.id, 3_300_000)]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  for (const r of results.filter((r) => r.status === "rejected")) assert.ok(isHttp(409, "amount_exceeds_balance")((r as PromiseRejectedResult).reason));
  assert.equal((await getAppointmentBalance(db, w.businessId, appt.id)).paidCents, 3_300_000);
});

test("cita cancelada: no se cobra, pero la seña se puede devolver", async () => {
  const appt = await bookAppointment(db, w.businessId, {
    locationId: w.escazu,
    clientId: w.sofia,
    serviceIds: [w.limpieza],
    staffId: w.ana,
    startsAt: crAt(crDay(6), "09:00"),
    channel: "panel",
  });
  const { payment } = await pay(appt.id, 1_000_000, "deposit");
  await cancelAppointment(db, w.businessId, appt.id, "Se mudó");
  await assert.rejects(pay(appt.id, 100), isHttp(409, "appointment_closed"));
  const refund = await refundPayment(db, w.businessId, { paymentId: payment.id, amountCents: 1_000_000, reason: "Canceló con tiempo", recordedBy: null });
  assert.equal(refund.original.refundedCents, 1_000_000);
});

test("validaciones: moneda del negocio, método inactivo o ajeno, fecha futura, cita inexistente", async () => {
  const appt = await pastAppointment(6, "12:00");
  const input = { appointmentId: appt.id, kind: "payment" as const, amountCents: 100, methodId: methods.Efectivo.id, recordedBy: null };
  await assert.rejects(recordAppointmentPayment(db, w.businessId, { ...input, currency: "USD" }), isField("body.currency"));
  assert.equal((await recordAppointmentPayment(db, w.businessId, { ...input, currency: "crc" })).payment.amountCents, 100);
  await assert.rejects(recordAppointmentPayment(db, w.businessId, { ...input, methodId: "00000000-0000-4000-8000-000000000000" }), isField("body.methodId"));
  await assert.rejects(recordAppointmentPayment(db, w.businessId, { ...input, paidAt: new Date(Date.now() + 3_600_000) }), isField("body.paidAt"));
  await assert.rejects(recordAppointmentPayment(db, w.businessId, { ...input, amountCents: 0 }), isField("body.amountCents"));
  await assert.rejects(recordAppointmentPayment(db, w.businessId, { ...input, appointmentId: "00000000-0000-4000-8000-000000000000" }), isHttp(404, "not_found"));
  // Un método de OTRO negocio no sirve.
  const other = await createSchedulingWorld(db);
  const [foreign] = await seedDefaultPaymentMethods(db, { businessId: other.businessId });
  await assert.rejects(recordAppointmentPayment(db, w.businessId, { ...input, methodId: foreign.id }), isField("body.methodId"));
});

test("gasto total del cliente (total_spent_cents): cobros y señas suman, devoluciones restan, también los sueltos", async () => {
  const world = await createSchedulingWorld(db);
  const [cash] = await seedDefaultPaymentMethods(db, { businessId: world.businessId });
  const appt = await bookAppointment(db, world.businessId, {
    locationId: world.escazu,
    clientId: world.sofia,
    serviceIds: [world.limpieza],
    staffId: world.ana,
    startsAt: crAt(crDay(-1), "09:00"),
    channel: "panel",
    allowOutsideHours: true,
  });
  const spent = async () => (await getClient(db, world.businessId, world.sofia))?.totalSpentCents;
  assert.equal(await spent(), 0);
  const { payment } = await recordAppointmentPayment(db, world.businessId, { appointmentId: appt.id, kind: "deposit", amountCents: 1_000_000, methodId: cash.id, recordedBy: null });
  assert.equal(await spent(), 1_000_000);
  const loose = await recordClientPayment(db, world.businessId, {
    clientId: world.sofia,
    locationId: world.heredia,
    kind: "deposit",
    amountCents: 99_000_000,
    methodId: cash.id,
    note: "Seña de un paquete (sin cita: sin tope)",
    recordedBy: null,
  });
  assert.equal(loose.appointmentId, null);
  assert.equal(loose.location?.name, "Heredia");
  assert.equal(await spent(), 100_000_000);
  await refundPayment(db, world.businessId, { paymentId: payment.id, amountCents: 400_000, reason: "Ajuste", recordedBy: null });
  assert.equal(await spent(), 99_600_000);
  await assert.rejects(
    recordClientPayment(db, world.businessId, { clientId: "00000000-0000-4000-8000-000000000000", locationId: world.escazu, kind: "payment", amountCents: 1, methodId: cash.id, recordedBy: null }),
    isField("body.clientId"),
  );
});

test("caja del día por método (resumen) y movimientos con filtros", async () => {
  const world = await createSchedulingWorld(db);
  const m = Object.fromEntries((await seedDefaultPaymentMethods(db, { businessId: world.businessId })).map((x) => [x.name, x]));
  const today = crDay(0);
  const at = (hm: string) => crAt(today, hm);
  const book = (hm: string, locationId: string, staffId: string) =>
    bookAppointment(db, world.businessId, { locationId, clientId: world.maria, serviceIds: [world.limpieza], staffId, startsAt: at(hm), channel: "panel", allowOutsideHours: true });
  const a1 = await book("08:00", world.escazu, world.ana);
  const a2 = await book("09:00", world.heredia, world.carla);
  const now = new Date(Math.max(Date.now(), at("23:00").getTime()));
  const charge = (appointmentId: string, kind: "deposit" | "payment", amountCents: number, method: string, hm: string) =>
    recordAppointmentPayment(db, world.businessId, { appointmentId, kind, amountCents, methodId: m[method].id, recordedBy: null, paidAt: at(hm), now });
  await charge(a1.id, "deposit", 500_000, "SINPE Móvil", "07:00");
  const big = await charge(a1.id, "payment", 2_000_000, "Efectivo", "10:00");
  await charge(a2.id, "payment", 2_500_000, "Tarjeta", "11:00");
  // Ayer (no entra en la caja de hoy).
  await recordClientPayment(db, world.businessId, { clientId: world.sofia, locationId: world.escazu, kind: "payment", amountCents: 100_000, methodId: m.Efectivo.id, recordedBy: null, paidAt: crAt(crDay(-1), "15:00") });
  const refund = await refundPayment(db, world.businessId, { paymentId: big.payment.id, amountCents: 300_000, reason: "Vuelto mal dado", recordedBy: null });

  const summary = await getDailySummary(db, world.businessId, { date: today, timezone: CR });
  const byName = Object.fromEntries(summary.byMethod.map((x) => [x.name, x]));
  assert.deepEqual(Object.keys(byName), ["Efectivo", "SINPE Móvil", "Tarjeta", "Transferencia"], "todos los activos, aunque estén en cero");
  assert.equal(byName["SINPE Móvil"].depositsCents, 500_000);
  assert.equal(byName.Efectivo.paymentsCents, 2_000_000);
  assert.equal(byName.Efectivo.count, 2, "el cobro y su devolución");
  assert.equal(byName.Efectivo.refundsCents, 300_000);
  assert.equal(byName.Tarjeta.netCents, 2_500_000);
  assert.equal(byName.Transferencia.count, 0);
  assert.equal(summary.totals.depositsCents, 500_000);
  assert.equal(summary.totals.refundsCents, 300_000);
  assert.equal(summary.totals.collectedCents, summary.totals.depositsCents + summary.totals.paymentsCents);
  assert.equal(summary.totals.netCents, summary.totals.collectedCents - 300_000);
  // Por sucursal: Heredia solo tiene el cobro con tarjeta.
  const heredia = await getDailySummary(db, world.businessId, { date: today, timezone: CR, locationIds: [world.heredia], locationId: world.heredia });
  assert.equal(heredia.totals.paymentsCents, 2_500_000);
  assert.equal(heredia.totals.count, 1);
  assert.equal(heredia.locationId, world.heredia);

  const day = { from: crAt(today, "00:00"), to: crAt(crDay(1), "00:00") };
  const all = await listPayments(db, world.businessId, day);
  assert.ok(all.items.some((p) => p.id === refund.refund.id));
  assert.equal(all.totals.refundsCents, 300_000);
  const onlyCash = await listPayments(db, world.businessId, { ...day, methodId: m.Efectivo.id, kind: "payment" });
  assert.ok(onlyCash.items.every((p) => p.method?.name === "Efectivo" && p.kind === "payment"));
  const sofia = await listPayments(db, world.businessId, { from: crAt(crDay(-1), "00:00"), to: day.to, clientId: world.sofia });
  assert.deepEqual(sofia.items.map((p) => p.amountCents), [100_000]);
  const limited = await listPayments(db, world.businessId, { ...day, limit: 1 });
  assert.equal(limited.items.length, 1);
  assert.equal(limited.truncated, true);
  assert.equal(limited.totals.count, all.totals.count, "los totales son de todo el filtro");
});

test("totales cobrados para Reportes (I5): por método, profesional y servicio, con prorrateo entre líneas", async () => {
  const world = await createSchedulingWorld(db);
  const m = Object.fromEntries((await seedDefaultPaymentMethods(db, { businessId: world.businessId })).map((x) => [x.name, x]));
  const day = crDay(-2);
  const twoLines = await bookAppointment(db, world.businessId, {
    locationId: world.escazu,
    clientId: world.maria,
    serviceIds: [world.limpieza, world.manicura], // 25 000 + 8 000
    staffId: world.ana,
    startsAt: crAt(day, "09:00"),
    channel: "panel",
    allowOutsideHours: true,
  });
  const carla = await bookAppointment(db, world.businessId, {
    locationId: world.heredia,
    clientId: world.sofia,
    serviceIds: [world.pedicura],
    staffId: world.carla,
    startsAt: crAt(day, "10:00"),
    channel: "panel",
    allowOutsideHours: true,
  });
  const paidAt = crAt(day, "12:00");
  await recordAppointmentPayment(db, world.businessId, { appointmentId: twoLines.id, kind: "payment", amountCents: 1_650_000, methodId: m.Efectivo.id, recordedBy: null, paidAt });
  await recordAppointmentPayment(db, world.businessId, { appointmentId: carla.id, kind: "payment", amountCents: 1_200_000, methodId: m.Tarjeta.id, recordedBy: null, paidAt });
  await recordClientPayment(db, world.businessId, { clientId: world.maria, locationId: world.escazu, kind: "deposit", amountCents: 50_000, methodId: m.Efectivo.id, recordedBy: null, paidAt });
  const range = { from: crAt(day, "00:00"), to: crAt(crDay(-1), "00:00") };

  const byMethod = await getCollectedTotals(db, world.businessId, { ...range, groupBy: "method" });
  assert.equal(byMethod.collectedCents, 2_900_000);
  assert.equal(byMethod.netCents, 2_900_000);
  assert.deepEqual(
    byMethod.groups.map((g) => [g.label, g.netCents]),
    [
      ["Efectivo", 1_700_000],
      ["Tarjeta", 1_200_000],
    ],
  );
  const byStaff = await getCollectedTotals(db, world.businessId, { ...range, groupBy: "staff" });
  assert.deepEqual(
    byStaff.groups.map((g) => [g.key, g.netCents]),
    [
      [world.ana, 1_650_000],
      [world.carla, 1_200_000],
      [null, 50_000],
    ],
  );
  const byService = await getCollectedTotals(db, world.businessId, { ...range, groupBy: "service" });
  const service = Object.fromEntries(byService.groups.map((g) => [g.label, g.netCents]));
  // ₡16 500 cobrados de una cita de ₡33 000: mitad de cada línea.
  assert.equal(service.Limpieza, 1_250_000);
  assert.equal(service.Manicura, 400_000);
  assert.equal(service.Pedicura, 1_200_000);
  assert.equal(service["Sin cita"], 50_000);
  const onlyAna = await getCollectedTotals(db, world.businessId, { ...range, staffId: world.ana });
  assert.equal(onlyAna.netCents, 1_650_000);
  assert.equal(onlyAna.count, 1);
  const onlyManicura = await getCollectedTotals(db, world.businessId, { ...range, serviceId: world.manicura });
  assert.equal(onlyManicura.netCents, 400_000);
  const heredia = await getCollectedTotals(db, world.businessId, { ...range, locationIds: [world.heredia], groupBy: "day" });
  assert.deepEqual(heredia.groups.map((g) => [g.key, g.netCents]), [[day, 1_200_000]]);
});

test("prorrateo por precio: la suma da exacto y el resto va a las fracciones mayores", () => {
  assert.deepEqual(prorateByPrice(100, [{ priceCents: 1 }, { priceCents: 1 }, { priceCents: 1 }]), [34, 33, 33]);
  assert.deepEqual(prorateByPrice(1_650_000, [{ priceCents: 2_500_000 }, { priceCents: 800_000 }]), [1_250_000, 400_000]);
  assert.deepEqual(prorateByPrice(500, [{ priceCents: 0 }, { priceCents: 0 }]), [500, 0], "sin precios: todo a la primera");
  assert.deepEqual(prorateByPrice(0, [{ priceCents: 10 }]), [0]);
});
