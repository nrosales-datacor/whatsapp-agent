import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { eq } from "drizzle-orm";
import { invalidateBusinessContext } from "../../src/modules/business";
import { businesses } from "../../src/modules/business/schema";
import { countClientsByStatus, listClients } from "../../src/modules/clients";
import { clients } from "../../src/modules/clients/schema";
import { getHomeOverview, resolveReportScope, buildChannelsReport, buildClientsReport, buildSalesReport, buildServicesReport, buildStaffReport } from "../../src/modules/reports";
import { getCollectedTotals, recordAppointmentPayment, recordClientPayment, refundPayment, seedDefaultPaymentMethods, type PaymentMethodView } from "../../src/modules/sales";
import { payments } from "../../src/modules/sales/schema";
import {
  bookAppointment,
  cancelAppointment,
  completeAppointment,
  confirmAppointment,
  getAppointmentBreakdown,
  getBookedMinutesByStaff,
  getClientVisitStats,
  getServiceLineStats,
  markNoShow,
} from "../../src/modules/scheduling";
import { appointments } from "../../src/modules/scheduling/schema";
import { getStaffAvailableMinutes, markMemberActive } from "../../src/modules/team";
import { timeOff } from "../../src/modules/team/schema";
import { ValidationError } from "../../src/platform/http/errors";
import type { Session } from "../../src/platform/http/routeTypes";
import { withTenant } from "../../src/platform/db/scope";
import { readDailyUsage, summarizeDailyUsage, USAGE_METRICS } from "../../src/platform/observability/dailyUsage";
import { createUsageTracker } from "../../src/usage";
import { createTestMember } from "../helpers/identityFixtures";
import { createEphemeralDb } from "../helpers/pgliteDb";
import { createSchedulingWorld, CR, crAt, crDay, type SchedulingWorld } from "../helpers/schedulingFixtures";

// ─────────────────────────────────────────────────────────────────────────────
// Reportes e Inicio completo (I5) sobre Postgres real (PGlite) con el rol de la app (RLS):
// cada agregado SQL con datos sembrados — bordes del rango y zona horaria (una cita a las
// 23:50 de Costa Rica es del mismo día aunque en UTC ya sea el siguiente), sucursal,
// canceladas y no-show —, ocupación (horario ∩ sucursal − ausencias que se pisan),
// clientes nuevos vs. recurrentes y retención, montos por canal y tickets, los cinco
// reportes armados, el Inicio completo (cobrado hoy, nuevos, alertas, en riesgo, 14 días),
// "en riesgo" con el estado del CRM (lo mismo que la lista y sus chips, con las reglas del
// negocio) y las métricas de producto en daily_usage (citas, pagos, logins y usuarios
// activos una vez por persona y día).
// ─────────────────────────────────────────────────────────────────────────────

const base = await createEphemeralDb();
const { db } = base;
after(() => base.close());

before(async () => {
  await base.client.exec("SET ROLE app_runtime");
});

type World = SchedulingWorld & { methods: Record<string, PaymentMethodView> };

async function world(): Promise<World> {
  const w = await createSchedulingWorld(db);
  const methods = Object.fromEntries((await seedDefaultPaymentMethods(db, { businessId: w.businessId })).map((m) => [m.name, m]));
  return { ...w, methods };
}

function book(w: World, input: { staffId: string; locationId?: string; at: Date; serviceIds: string[]; clientId?: string; channel?: "panel" | "phone" | "walk_in" }) {
  return bookAppointment(db, w.businessId, {
    locationId: input.locationId ?? w.escazu,
    clientId: input.clientId ?? w.maria,
    serviceIds: input.serviceIds,
    staffId: input.staffId,
    startsAt: input.at,
    channel: input.channel ?? "panel",
    allowOutsideHours: true,
  });
}

/** Día de prueba (hace 20 días) en Costa Rica y sus vecinos. */
const D = crDay(-20);
const dayRange = (date: string) => ({ from: crAt(date, "00:00"), to: crAt(crDay(-19), "00:00") });

/**
 * Mundo de la agenda del día D:
 *   A  Ana    Escazú  D 00:10  Limpieza+Manicura  panel    → completada
 *   B  Beto   Escazú  D 23:50  Limpieza           phone    → cancelada (23:50 CR = 05:50 UTC del día siguiente)
 *   C  Beto   Escazú  D-1 23:59 Limpieza          panel    (fuera del rango; se solapa 54 min con D)
 *   E  Ana    Escazú  D+1 00:00 Limpieza          panel    (fuera del rango)
 *   F  Carla  Heredia D 10:00  Pedicura           walk_in → pendiente; canal pasado a whatsapp_ai
 *   G  Ana    Escazú  D 15:00  Limpieza           panel    → no-show
 */
async function agendaWorld() {
  const w = await world();
  const a = await book(w, { staffId: w.ana, at: crAt(D, "00:10"), serviceIds: [w.limpieza, w.manicura] });
  const b = await book(w, { staffId: w.beto, at: crAt(D, "23:50"), serviceIds: [w.limpieza], channel: "phone" });
  const c = await book(w, { staffId: w.beto, at: crAt(crDay(-21), "23:59"), serviceIds: [w.limpieza] });
  const e = await book(w, { staffId: w.ana, at: crAt(crDay(-19), "00:00"), serviceIds: [w.limpieza] });
  const f = await book(w, { staffId: w.carla, locationId: w.heredia, at: crAt(D, "10:00"), serviceIds: [w.pedicura], channel: "walk_in" });
  const g = await book(w, { staffId: w.ana, at: crAt(D, "15:00"), serviceIds: [w.limpieza] });
  await completeAppointment(db, w.businessId, a.id);
  await cancelAppointment(db, w.businessId, b.id, "Se enfermó");
  await markNoShow(db, w.businessId, g.id);
  // El agente agenda solo hacia adelante: para el reporte de canales se marca a mano.
  await withTenant(db, w.businessId, (tx) => tx.update(appointments).set({ channel: "whatsapp_ai" }).where(eq(appointments.id, f.id)));
  return { w, a, b, c, e, f, g };
}

test("citas por estado, canal, sucursal y día: bordes del rango y zona horaria del negocio", async () => {
  const { w } = await agendaWorld();
  const range = dayRange(D);

  const totals = await getAppointmentBreakdown(db, w.businessId, range);
  assert.equal(totals.total, 4, "A, B, F y G empiezan en D (C empieza el día anterior, E el siguiente)");
  assert.deepEqual(totals.byStatus, { pending: 1, confirmed: 0, completed: 1, cancelled: 1, no_show: 1 });
  assert.equal(totals.completedValueCents, 3_300_000, "solo la completada (Limpieza 25 000 + Manicura 8 000)");
  assert.deepEqual(totals.groups, [], "sin groupBy no hay grupos");

  const byDay = await getAppointmentBreakdown(db, w.businessId, { ...range, groupBy: "day", timeZone: CR });
  assert.deepEqual(byDay.groups.map((g) => [g.key, g.total]), [[D, 4]], "en la zona del negocio, las 23:50 siguen siendo D");
  const utc = await getAppointmentBreakdown(db, w.businessId, { ...range, groupBy: "day", timeZone: "UTC" });
  assert.deepEqual(utc.groups.map((g) => [g.key, g.total]), [[D, 3], [crDay(-19), 1]], "en UTC la de las 23:50 cae al día siguiente");

  const byLocation = await getAppointmentBreakdown(db, w.businessId, { ...range, groupBy: "location" });
  assert.deepEqual(byLocation.groups.map((g) => [g.key, g.total]), [[w.escazu, 3], [w.heredia, 1]]);
  const heredia = await getAppointmentBreakdown(db, w.businessId, { ...range, locationIds: [w.heredia] });
  assert.equal(heredia.total, 1);
  assert.equal((await getAppointmentBreakdown(db, w.businessId, { ...range, locationIds: [] })).total, 0, "[] = ninguna sucursal");

  const byChannel = await getAppointmentBreakdown(db, w.businessId, { ...range, groupBy: "channel" });
  assert.deepEqual(
    Object.fromEntries(byChannel.groups.map((g) => [g.key, g.total])),
    { panel: 2, phone: 1, whatsapp_ai: 1 },
  );
  const byStaff = await getAppointmentBreakdown(db, w.businessId, { ...range, groupBy: "staff" });
  const ana = byStaff.groups.find((g) => g.key === w.ana);
  assert.equal(ana?.total, 2);
  assert.equal(ana?.byStatus.no_show, 1);
  assert.equal((await getAppointmentBreakdown(db, w.businessId, { ...range, staffId: w.beto })).byStatus.cancelled, 1);
});

test("servicios: agendados (sin canceladas), realizados y su valor, por línea", async () => {
  const { w } = await agendaWorld();
  const lines = await getServiceLineStats(db, w.businessId, dayRange(D));
  const by = Object.fromEntries(lines.map((l) => [l.name, l]));
  assert.deepEqual([by.Limpieza.scheduled, by.Limpieza.completed, by.Limpieza.completedValueCents], [2, 1, 2_500_000], "A completada + G no-show; B cancelada no cuenta");
  assert.deepEqual([by.Manicura.scheduled, by.Manicura.completed, by.Manicura.completedValueCents], [1, 1, 800_000]);
  assert.deepEqual([by.Pedicura.scheduled, by.Pedicura.completed], [1, 0]);
  assert.equal(lines[0].completed >= lines[lines.length - 1].completed, true, "más vendidos primero");
  assert.deepEqual(await getServiceLineStats(db, w.businessId, { ...dayRange(D), locationIds: [w.heredia] }).then((l) => l.map((x) => x.name)), ["Pedicura"]);
});

test("ocupación: minutos agendados recortados al rango y disponibles = horario ∩ sucursal − ausencias (sin descontar dos veces)", async () => {
  const { w } = await agendaWorld();
  const range = dayRange(D);
  const booked = await getBookedMinutesByStaff(db, w.businessId, range);
  assert.equal(booked.get(w.ana), 115 + 70, "A (60 + 10 entre servicios + 40 + 5 de buffer final) + G (60 + 10); E es del día siguiente");
  assert.equal(booked.get(w.beto), 54, "C empieza el día anterior: solo cuentan sus 54 min dentro de D; B cancelada no ocupa");
  assert.equal(booked.get(w.carla), 70);

  // Vacaciones de Carla 08–10 y feriado del negocio 09–11 (se pisan: se descuentan 3 h, no 4);
  // cierre de Escazú 18–19 (Ana y Beto pierden 1 h); una ausencia de Ana en Heredia no la toca.
  await withTenant(db, w.businessId, (tx) =>
    tx.insert(timeOff).values([
      { businessId: w.businessId, staffId: w.carla, startsAt: crAt(D, "08:00"), endsAt: crAt(D, "10:00"), reason: "Vacaciones" },
      { businessId: w.businessId, startsAt: crAt(D, "09:00"), endsAt: crAt(D, "11:00"), reason: "Feriado" },
      { businessId: w.businessId, locationId: w.escazu, startsAt: crAt(D, "18:00"), endsAt: crAt(D, "19:00"), reason: "Inventario" },
      { businessId: w.businessId, staffId: w.ana, locationId: w.heredia, startsAt: crAt(D, "13:00"), endsAt: crAt(D, "14:00") },
    ]),
  );
  const locations = [
    { id: w.escazu, timezone: CR, hours: [0, 1, 2, 3, 4, 5, 6].flatMap((weekday) => [{ weekday, opensAt: "08:00", closesAt: "12:00" }, { weekday, opensAt: "13:00", closesAt: "19:00" }]) },
    { id: w.heredia, timezone: CR, hours: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, opensAt: "08:00", closesAt: "18:00" })) },
  ];
  const available = await getStaffAvailableMinutes(db, w.businessId, { ...range, locations });
  assert.equal(available.get(w.ana), 600 - 60 - 120, "Ana 08–12 y 13–19, menos el cierre 18–19 y el feriado 09–11");
  assert.equal(available.get(w.beto), 360 - 60, "Beto 13–19 menos el cierre de Escazú (el feriado de la mañana no lo toca)");
  assert.equal(available.get(w.carla), 600 - 180, "08–11 juntando vacaciones y feriado");

  // Sucursal de Heredia sola: solo Carla.
  const onlyHeredia = await getStaffAvailableMinutes(db, w.businessId, { ...range, locations: [locations[1]] });
  assert.deepEqual([...onlyHeredia.keys()], [w.carla]);
  // Una semana: 7 días de horario (menos lo del día D).
  const week = await getStaffAvailableMinutes(db, w.businessId, { from: crAt(crDay(-23), "00:00"), to: crAt(crDay(-16), "00:00"), locations });
  assert.equal(week.get(w.beto), 7 * 360 - 60);
});

test("clientes: nuevos vs. recurrentes en el rango (primera visita del negocio) y retención contra el período anterior", async () => {
  const w = await world();
  const [pedro, laura] = await withTenant(db, w.businessId, (tx) =>
    tx
      .insert(clients)
      .values([
        { businessId: w.businessId, name: "Pedro Mora", phone: "+50688880003" },
        { businessId: w.businessId, name: "Laura Vargas", phone: "+50688880004" },
      ])
      .returning({ id: clients.id }),
  );
  const visit = async (clientId: string, daysAgo: number, staffId = w.ana, locationId = w.escazu) => {
    const a = await book(w, { staffId, locationId, clientId, at: crAt(crDay(-daysAgo), "10:00"), serviceIds: [staffId === w.carla ? w.pedicura : w.limpieza] });
    await completeAppointment(db, w.businessId, a.id);
  };
  await visit(w.maria, 10); // período anterior
  await visit(w.maria, 2); // vuelve: recurrente y retenida
  await visit(w.sofia, 3); // primera visita: nueva
  await visit(pedro.id, 9); // vino antes y no volvió
  await visit(laura.id, 30); // historia vieja
  await visit(laura.id, 1, w.carla, w.heredia); // recurrente, en Heredia
  // Una cancelada no es visita.
  const cancelled = await book(w, { staffId: w.beto, clientId: pedro.id, at: crAt(crDay(-2), "15:00"), serviceIds: [w.limpieza] });
  await cancelAppointment(db, w.businessId, cancelled.id, null);

  const range = { from: crAt(crDay(-6), "00:00"), to: crAt(crDay(1), "00:00"), previousFrom: crAt(crDay(-13), "00:00"), timeZone: CR };
  const stats = await getClientVisitStats(db, w.businessId, range);
  assert.equal(stats.visits, 3);
  assert.equal(stats.served, 3, "María, Sofía y Laura");
  assert.equal(stats.newClients, 1, "Sofía");
  assert.equal(stats.returning, 2);
  assert.deepEqual([stats.previous.served, stats.previous.retained], [2, 1], "María y Pedro vinieron antes; volvió María");
  assert.equal(stats.retentionRate, 0.5);
  assert.deepEqual(stats.byDay, [
    { date: crDay(-3), newClients: 1, returningClients: 0 },
    { date: crDay(-2), newClients: 0, returningClients: 1 },
    { date: crDay(-1), newClients: 0, returningClients: 1 },
  ]);
  const escazu = await getClientVisitStats(db, w.businessId, { ...range, locationIds: [w.escazu] });
  assert.equal(escazu.served, 2, "Laura vino a Heredia");
});

test("montos por canal y tickets: cobros sueltos aparte, devoluciones restan; filtro por profesional con agrupación por día", async () => {
  const { w, a, f } = await agendaWorld();
  const paidAt = crAt(D, "16:00");
  const pa = await recordAppointmentPayment(db, w.businessId, { appointmentId: a.id, kind: "payment", amountCents: 3_300_000, methodId: w.methods.Efectivo.id, recordedBy: null, paidAt });
  await recordAppointmentPayment(db, w.businessId, { appointmentId: f.id, kind: "deposit", amountCents: 500_000, methodId: w.methods.Tarjeta.id, recordedBy: null, paidAt });
  await withTenant(db, w.businessId, (tx) => tx.update(appointments).set({ status: "completed" }).where(eq(appointments.id, f.id)));
  await recordAppointmentPayment(db, w.businessId, { appointmentId: f.id, kind: "payment", amountCents: 700_000, methodId: w.methods.Tarjeta.id, recordedBy: null, paidAt });
  await recordClientPayment(db, w.businessId, { clientId: w.sofia, locationId: w.escazu, kind: "deposit", amountCents: 100_000, methodId: w.methods.Efectivo.id, recordedBy: null, paidAt });
  const refund = await refundPayment(db, w.businessId, { paymentId: pa.payment.id, amountCents: 300_000, reason: "Descuento", recordedBy: null });
  // La devolución se hizo "hoy": se la lleva al día D para el rango.
  await withTenant(db, w.businessId, (tx) => tx.update(payments).set({ paidAt }).where(eq(payments.id, refund.refund.id)));

  const range = { from: crAt(D, "00:00"), to: crAt(crDay(-19), "00:00") };
  const byChannel = await getCollectedTotals(db, w.businessId, { ...range, groupBy: "channel" });
  assert.deepEqual(
    byChannel.groups.map((g) => [g.key, g.label, g.netCents]),
    [
      ["panel", "Panel", 3_000_000],
      ["whatsapp_ai", "Agente de WhatsApp", 1_200_000],
      [null, "Sin cita", 100_000],
    ],
  );
  assert.equal(byChannel.netCents, 4_300_000);
  assert.equal(byChannel.tickets, 3, "dos citas cobradas (la de seña + cobro es UNA) + un cobro suelto; la devolución no cuenta");
  assert.equal(byChannel.count, 5);

  const anaByDay = await getCollectedTotals(db, w.businessId, { ...range, staffId: w.ana, groupBy: "day", timeZone: CR });
  assert.deepEqual(anaByDay.groups.map((g) => [g.key, g.collectedCents, g.refundsCents, g.netCents]), [[D, 3_300_000, 300_000, 3_000_000]]);
  assert.equal(anaByDay.tickets, 1);
  const byMethodForCarla = await getCollectedTotals(db, w.businessId, { ...range, staffId: w.carla, groupBy: "method" });
  assert.deepEqual(byMethodForCarla.groups.map((g) => [g.label, g.netCents]), [["Tarjeta", 1_200_000]]);
});

test("los cinco reportes: rango inclusive en la zona del negocio, sucursal y totales coherentes", async () => {
  const { w, a } = await agendaWorld();
  await recordAppointmentPayment(db, w.businessId, {
    appointmentId: a.id,
    kind: "payment",
    amountCents: 3_300_000,
    methodId: w.methods["SINPE Móvil"].id,
    recordedBy: null,
    paidAt: crAt(D, "16:00"),
  });
  const owner: Session = { userId: randomUUID(), businessId: w.businessId, role: "owner", locationIds: "all", sessionEpoch: 0 };
  const scope = await resolveReportScope(db, owner, { from: D, to: D }, null);
  assert.equal(scope.view.days, 1);
  assert.deepEqual(scope.view.previous, { from: crDay(-21), to: crDay(-21) });

  const sales = await buildSalesReport(db, w.businessId, scope);
  assert.equal(sales.totals.netCents, 3_300_000);
  assert.equal(sales.totals.averageTicketCents, 3_300_000);
  assert.deepEqual(sales.byDay, [{ date: D, collectedCents: 3_300_000, refundsCents: 0, netCents: 3_300_000, count: 1 }]);
  assert.deepEqual(sales.byMethod.map((m) => m.label), ["SINPE Móvil"]);
  assert.equal(sales.previous.netCents, 0);

  const services = await buildServicesReport(db, w.businessId, scope);
  const limpieza = services.items.find((i) => i.name === "Limpieza");
  assert.equal(limpieza?.collectedNetCents, 2_500_000, "prorrateo por precio: 33 000 → 25 000 + 8 000");
  assert.equal(services.totals.collectedNetCents, 3_300_000);

  const staff = await buildStaffReport(db, w.businessId, scope);
  const ana = staff.items.find((i) => i.staffId === w.ana);
  assert.ok(ana);
  assert.deepEqual([ana.appointments, ana.completed, ana.noShow, ana.noShowRate], [2, 1, 1, 0.5]);
  assert.equal(ana.collectedNetCents, 3_300_000);
  assert.equal(ana.bookedMinutes, 185);
  assert.equal(ana.availableMinutes, 600);
  assert.ok(Math.abs((ana.occupancyRate ?? 0) - 185 / 600) < 1e-9);

  const channels = await buildChannelsReport(db, w.businessId, scope);
  assert.deepEqual(channels.items.map((i) => i.channel), ["whatsapp_ai", "panel", "phone", "walk_in", "web"], "los cinco canales siempre");
  assert.equal(channels.items.find((i) => i.channel === "panel")?.collectedNetCents, 3_300_000);
  assert.equal(channels.totals.appointments, 4);

  const clientsReport = await buildClientsReport(db, w.businessId, scope);
  assert.equal(clientsReport.served, 1);
  assert.equal(clientsReport.newClients, 1, "María: su primera visita es A");
  assert.equal(clientsReport.byDay.length, 1);

  // Sucursal: Heredia no tiene cobros ni la cita de Ana.
  const heredia = await resolveReportScope(db, owner, { from: D, to: D, locationId: w.heredia }, null);
  assert.equal((await buildSalesReport(db, w.businessId, heredia)).totals.netCents, 0);
  assert.deepEqual((await buildStaffReport(db, w.businessId, heredia)).items.find((i) => i.staffId === w.ana)?.appointments, 0);

  // Default: los últimos 30 días hasta hoy; inválidos → 400.
  const def = await resolveReportScope(db, owner, {}, null);
  assert.equal(def.view.days, 30);
  assert.equal(def.view.to, crDay(0));
  const invalidTo = (e: unknown) => e instanceof ValidationError && "query.to" in e.fields;
  await assert.rejects(resolveReportScope(db, owner, { from: D, to: crDay(-21) }, null), invalidTo);
  await assert.rejects(resolveReportScope(db, owner, { from: crDay(-400), to: crDay(0) }, null), invalidTo);
});

test("Inicio completo: cobrado hoy, clientes nuevos, citas y no-show de hoy, alertas, en riesgo e ingresos de 14 días", async () => {
  const w = await world();
  const today = crDay(1); // el "hoy" del Inicio (reloj inyectado)
  const now = crAt(today, "07:00");
  const tomorrow = crDay(2);
  const early = await book(w, { staffId: w.ana, at: crAt(today, "06:00"), serviceIds: [w.limpieza] });
  await book(w, { staffId: w.ana, at: crAt(today, "09:00"), serviceIds: [w.limpieza] });
  await book(w, { staffId: w.ana, at: crAt(tomorrow, "10:00"), serviceIds: [w.limpieza] });
  const confirmed = await book(w, { staffId: w.carla, locationId: w.heredia, at: crAt(tomorrow, "11:00"), serviceIds: [w.pedicura] });
  await confirmAppointment(db, w.businessId, confirmed.id);
  await markNoShow(db, w.businessId, early.id, { now });

  // Un cobro de "hoy" y otro de hace 3 días (las fechas de pago no pueden ser futuras: se mueven a mano).
  const past = await book(w, { staffId: w.beto, at: crAt(crDay(-3), "14:00"), serviceIds: [w.limpieza] });
  await completeAppointment(db, w.businessId, past.id);
  const p1 = await recordAppointmentPayment(db, w.businessId, { appointmentId: past.id, kind: "payment", amountCents: 1_000_000, methodId: w.methods.Efectivo.id, recordedBy: null });
  const p2 = await recordAppointmentPayment(db, w.businessId, { appointmentId: past.id, kind: "payment", amountCents: 2_000_000, methodId: w.methods.Efectivo.id, recordedBy: null });
  await withTenant(db, w.businessId, async (tx) => {
    await tx.update(payments).set({ paidAt: crAt(today, "06:30") }).where(eq(payments.id, p1.payment.id));
    await tx.update(payments).set({ paidAt: crAt(crDay(-2), "12:00") }).where(eq(payments.id, p2.payment.id));
    // Sofía se registró "hoy"; tres clientes con distinta última visita (60 días = en riesgo; 120 = inactivo).
    await tx.update(clients).set({ createdAt: crAt(today, "06:45") }).where(eq(clients.id, w.sofia));
    await tx.insert(clients).values([
      { businessId: w.businessId, name: "En riesgo", phone: "+50688880011", visitCount: 3, lastVisitAt: new Date(now.getTime() - 70 * 86_400_000) },
      { businessId: w.businessId, name: "Inactiva", phone: "+50688880012", visitCount: 1, lastVisitAt: new Date(now.getTime() - 130 * 86_400_000) },
      { businessId: w.businessId, name: "Activa", phone: "+50688880013", visitCount: 5, lastVisitAt: new Date(now.getTime() - 10 * 86_400_000) },
    ]);
  });

  const home = await getHomeOverview(db, w.businessId, { locationIds: null, locationId: null, now, countConversationsWaiting: async () => 2 });
  assert.equal(home.date, today);
  assert.equal(home.collectedToday.netCents, 1_000_000);
  assert.equal(home.newClientsToday, 1);
  assert.equal(home.appointmentsToday.total, 2);
  assert.equal(home.noShowsToday, 1);
  assert.equal(home.alerts.unconfirmed.today, 1, "la de las 09:00 (la de las 06:00 ya pasó y es no-show)");
  assert.equal(home.alerts.unconfirmed.tomorrow, 1, "la confirmada no cuenta");
  assert.equal(home.alerts.unconfirmed.items.length, 2);
  assert.equal(home.alerts.atRisk.count, 1);
  assert.deepEqual(
    home.alerts.atRisk.items.map((c) => [c.name, c.visitCount, c.lastVisitAt]),
    [["En riesgo", 3, new Date(now.getTime() - 70 * 86_400_000).toISOString()]],
  );
  assert.equal(home.revenue.length, 14);
  assert.equal(home.revenue[13].date, today);
  assert.equal(home.revenue[13].netCents, 1_000_000);
  assert.equal(home.revenue.find((d) => d.date === crDay(-2))?.netCents, 2_000_000);
  assert.equal(home.conversationsWaiting, 2);

  const heredia = await getHomeOverview(db, w.businessId, { locationIds: [w.heredia], locationId: w.heredia, now });
  assert.equal(heredia.appointmentsToday.total, 0);
  assert.equal(heredia.collectedToday.netCents, 0);
  assert.equal(heredia.alerts.unconfirmed.tomorrow, 0);
  assert.equal(heredia.conversationsWaiting, null);
});

test("en riesgo = estado del CRM: Inicio, la lista filtrada y los chips dicen lo mismo (reglas fijas y por frecuencia)", async () => {
  const w = await world();
  const now = new Date();
  const ago = (days: number) => new Date(now.getTime() - days * 86_400_000);
  await withTenant(db, w.businessId, (tx) =>
    tx.insert(clients).values([
      // Nunca vino y se registró hace 90 días: en riesgo por el alta (el cálculo por última visita no lo veía).
      { businessId: w.businessId, name: "Sin visitas", phone: "+50688880021", createdAt: ago(90) },
      // Viene cada ~9 días y hace 25 que no: en riesgo solo por frecuencia (2 × 8,75 días).
      { businessId: w.businessId, name: "Frecuente", phone: "+50688880022", visitCount: 5, firstVisitAt: ago(60), lastVisitAt: ago(25), createdAt: ago(61) },
      // 70 días sin venir: en riesgo con el umbral fijo (60); por frecuencia (cada 65 días) todavía no.
      { businessId: w.businessId, name: "Espaciada", phone: "+50688880023", visitCount: 3, firstVisitAt: ago(200), lastVisitAt: ago(70), createdAt: ago(201) },
      { businessId: w.businessId, name: "Inactiva", phone: "+50688880024", visitCount: 1, firstVisitAt: ago(130), lastVisitAt: ago(130), createdAt: ago(131) },
      // Con los datos eliminados no aparece en ningún lado.
      { businessId: w.businessId, name: "Cliente eliminado", visitCount: 2, firstVisitAt: ago(100), lastVisitAt: ago(80), createdAt: ago(101), anonymizedAt: ago(1) },
    ]),
  );

  async function check(expected: string[]) {
    const home = await getHomeOverview(db, w.businessId, { locationIds: null, locationId: null, now });
    assert.deepEqual(home.alerts.atRisk.items.map((c) => c.name), expected, "Inicio: los más cerca de pasar a inactivos primero");
    assert.equal(home.alerts.atRisk.count, expected.length);
    const list = await listClients(db, w.businessId, { statuses: ["at_risk"] }, { now, withStatus: true });
    assert.deepEqual(list.items.map((c) => c.name).sort(), [...expected].sort(), "la lista filtrada por «En riesgo»");
    assert.equal((await countClientsByStatus(db, w.businessId, {}, { now })).at_risk, expected.length, "el chip «En riesgo»");
    return home;
  }

  // Reglas default (fijo: en riesgo a los 60 días, inactivo a los 120).
  const home = await check(["Sin visitas", "Espaciada"]);
  assert.equal(home.alerts.atRisk.items[0].lastVisitAt, null, "todavía no vino");

  // El negocio pasa a "por frecuencia": cambia quién está en riesgo, en todos lados a la vez.
  await withTenant(db, w.businessId, (tx) => tx.update(businesses).set({ clientStatusRules: { atRiskMode: "frequency" } }).where(eq(businesses.id, w.businessId)));
  invalidateBusinessContext(w.businessId);
  await check(["Sin visitas", "Frecuente"]);
});

test("daily_usage: citas creadas, pagos, logins y usuarios activos (una vez por persona y día, aunque haya muchos requests)", async () => {
  const w = await world();
  let clock = crAt(crDay(0), "10:00");
  const usage = createUsageTracker({ now: () => clock });
  const appt = await bookAppointment(db, w.businessId, {
    locationId: w.escazu,
    clientId: w.maria,
    serviceIds: [w.limpieza],
    staffId: w.ana,
    startsAt: crAt(crDay(-1), "10:00"),
    channel: "panel",
    allowOutsideHours: true,
    onBooked: usage.appointmentBooked,
  });
  await completeAppointment(db, w.businessId, appt.id);
  await recordAppointmentPayment(db, w.businessId, {
    appointmentId: appt.id,
    kind: "payment",
    amountCents: 2_500_000,
    methodId: w.methods.Efectivo.id,
    recordedBy: null,
    onRecorded: usage.paymentRecorded,
  });
  // Un gancho que falla no afecta la operación.
  const survived = await bookAppointment(db, w.businessId, {
    locationId: w.escazu,
    clientId: w.sofia,
    serviceIds: [w.limpieza],
    staffId: w.beto,
    startsAt: crAt(crDay(-1), "15:00"),
    channel: "panel",
    allowOutsideHours: true,
    onBooked: () => {
      throw new Error("boom");
    },
  });
  assert.ok(survived.id);

  const member = await createTestMember(db, { businessId: w.businessId, role: "owner" });
  const session: Session = { userId: member.userId, businessId: w.businessId, role: "owner", locationIds: "all", sessionEpoch: 0 };
  await usage.login(db, w.businessId, member.userId);
  for (let i = 0; i < 5; i++) await usage.sessionSeen(db, session);
  // Otro proceso (otro rastreador, sin su caché) el mismo día: tampoco cuenta de nuevo.
  await createUsageTracker({ now: () => clock }).sessionSeen(db, session);
  clock = crAt(crDay(1), "09:00");
  await usage.sessionSeen(db, session);

  const read = (metric: string) => readDailyUsage(db, w.businessId, { metric, from: crDay(-5), to: crDay(5) });
  assert.deepEqual(await read(USAGE_METRICS.appointmentsCreated), [{ date: crDay(0), value: 1 }], "la del gancho que falló no se cuenta");
  assert.deepEqual(await read(USAGE_METRICS.paymentsRecorded), [{ date: crDay(0), value: 1 }]);
  assert.deepEqual(await read(USAGE_METRICS.logins), [{ date: crDay(0), value: 1 }]);
  assert.deepEqual(await read(USAGE_METRICS.activeUsers), [
    { date: crDay(0), value: 1 },
    { date: crDay(1), value: 1 },
  ]);
  assert.equal(await markMemberActive(db, w.businessId, member.userId, crDay(1)), false, "ya marcado ese día");

  const summary = await summarizeDailyUsage(db, { from: crDay(-5), to: crDay(5), metrics: [USAGE_METRICS.activeUsers] });
  const mine = summary.find((r) => r.businessId === w.businessId);
  assert.deepEqual([mine?.total, mine?.activeDays, mine?.lastDate], [2, 2, crDay(1)]);
});
