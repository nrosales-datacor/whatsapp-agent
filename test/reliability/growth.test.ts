import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, test } from "node:test";
import { and, eq } from "drizzle-orm";

// ─────────────────────────────────────────────────────────────────────────────
// Crecimiento (I6) de punta a punta contra PGlite como el rol de la app, con Graph y el
// agente como dobles:
//   • Consentimiento: tras la primera cita agendada por el agente, "¿te avisamos de
//     promociones?" (solo con Campañas, una sola vez); el "Sí" queda en el cliente y en
//     la auditoría; sin Campañas no se pregunta.
//   • Reseñas: el barrido encola el seguimiento de las citas completadas; botones con la
//     ventana abierta, plantilla `followUp` con la ventana cerrada, nada sin plantilla;
//     "Excelente" pide la reseña, "Mal" pasa a una persona y avisa al equipo.
//   • Rescate: una cotización abierta por cliente y servicio; toque 1 con horarios como
//     botones, toque 2 por plantilla; agendar la cierra como recuperada con el monto; la
//     baja corta el rescate.
//   • Upsell: la regla aplica, se agrega a continuación (horario y solapes re-chequeados),
//     el rechazo se recuerda.
//   • Campañas: lanzar exige plantilla y audiencia; el despacho manda la plantilla de
//     marketing, salta a quien pidió la baja después y completa; cancelar corta; los
//     resultados cuentan respuestas y citas.
// ─────────────────────────────────────────────────────────────────────────────

process.env.TOKENS_ENCRYPTION_KEY = "d".repeat(64);
process.env.CAMPAIGN_SEND_INTERVAL_MS = "0";

const { registerJobHandlers } = await import("../../src/jobs");
const { listTenantAudit } = await import("../../src/platform/audit/auditLog");
const { getClient, recordMarketingConsent, recordMarketingOptOut } = await import("../../src/modules/clients");
const { clients } = await import("../../src/modules/clients/schema");
const { addServiceToAppointment, bookAppointment, completeAppointment, getAppointment } = await import("../../src/modules/scheduling");
const { cancelCampaign, createCampaign, getCampaign, launchCampaign, previewSegment } = await import("../../src/modules/campaigns");
const { campaignSends } = await import("../../src/modules/campaigns/schema");
const { sweepFollowUps } = await import("../../src/modules/whatsapp/followUps");
const { updateGrowthSettings } = await import("../../src/modules/whatsapp/growthSettings");
const { closeQuotesForAppointment, recordQuote, sweepQuoteRecovery } = await import("../../src/modules/whatsapp/quotes");
const { pickUpsell } = await import("../../src/modules/whatsapp/upsell");
const { conversations, followUps, quotes } = await import("../../src/modules/whatsapp/schema");
const { processWebhookBody } = await import("../../src/modules/whatsapp/webhook");
const { _resetChannelStateForTests } = await import("../../src/modules/whatsapp/channels");
const { emptyEffects, executeTool, loadAgentContext } = await import("../../src/modules/whatsapp/agent");
const { withTenant } = await import("../../src/platform/db/scope");
const { _resetShutdownForTests } = await import("../../src/platform/net/shutdown");
const { _resetJobHandlersForTests } = await import("../../src/platform/queue/handlers");
const { startQueueWorker } = await import("../../src/platform/queue/worker");
const { createEphemeralDb } = await import("../helpers/pgliteDb");
const { allJobs, silenceConsole, waitFor } = await import("../helpers/queue");
const { createSchedulingWorld, crAt, crDay } = await import("../helpers/schedulingFixtures");
const { createChannel, fakeWhatsApp, inboundBody, okResult } = await import("../helpers/whatsappFixtures");

const base = await createEphemeralDb();
const { db } = base;
let restoreConsole: () => void;
let fake: ReturnType<typeof fakeWhatsApp>;

const ALL_GROWTH = { marketingConsent: true, reviews: true, quoteRecovery: true, upsell: true };
let growth = { ...ALL_GROWTH };

before(async () => {
  restoreConsole = silenceConsole();
  await base.client.exec("SET ROLE app_runtime");
});
after(async () => {
  restoreConsole();
  await base.close();
});
beforeEach(() => {
  _resetJobHandlersForTests();
  _resetShutdownForTests();
  _resetChannelStateForTests();
  growth = { ...ALL_GROWTH };
  fake = fakeWhatsApp(db, { getGrowth: () => growth });
  registerJobHandlers({ whatsapp: fake.deps });
});
afterEach(() => _resetShutdownForTests());

async function drain(): Promise<void> {
  const worker = startQueueWorker({ db, concurrency: 1, pollMs: 10, retentionDays: 0 });
  try {
    await waitFor(
      async () => (await allJobs(db)).every((j) => j.status === "done" || j.status === "dead" || j.runAfter.getTime() > Date.now() + 1000),
      "cola vacía",
      30_000,
    );
  } finally {
    await worker.stop();
  }
  const dead = (await allJobs(db)).filter((j) => j.status === "dead");
  assert.equal(dead.length, 0, `jobs en dead: ${dead.map((d) => d.lastError).join(" | ")}`);
}

const MARIA_PHONE = "50688880001";
const SOFIA_PHONE = "50688880002";

async function setup(templates: Record<string, { name: string; language: string }> = {}) {
  const w = await createSchedulingWorld(db);
  const channel = await createChannel(db, w.businessId, { templates });
  return { ...w, ...channel };
}
type World = Awaited<ReturnType<typeof setup>>;

/** El cliente escribe (abre la ventana de 24 h) y se limpia lo que le respondió el agente. */
async function clientWrites(w: World, from: string, text = "hola"): Promise<void> {
  await processWebhookBody(db, inboundBody({ phoneNumberId: w.phoneNumberId, from, text }));
  await drain();
  fake.sent.length = 0;
}

async function tapButton(w: World, from: string, id: string, title = "ok"): Promise<void> {
  await processWebhookBody(
    db,
    inboundBody({ phoneNumberId: w.phoneNumberId, from, type: "interactive", message: { interactive: { type: "button_reply", button_reply: { id, title } } } }),
  );
  await drain();
}

const actor = (w: World) => ({ businessId: w.businessId, userId: null });

// ── Consentimiento ──────────────────────────────────────────────────────────

test("consentimiento: tras la primera cita agendada se pregunta UNA vez; el Sí queda en el cliente y en la auditoría", async () => {
  const w = await setup();
  await clientWrites(w, SOFIA_PHONE);
  fake.agentResult = { ...okResult("¡Listo! Quedó agendada."), actions: [{ type: "appointment_booked", appointmentId: "00000000-0000-4000-8000-000000000009" }] };
  await clientWrites(w, SOFIA_PHONE, "sí, agendámela");
  // clientWrites limpia lo enviado: se repite el turno para ver lo que manda.
  await withTenant(db, w.businessId, (tx) => tx.update(clients).set({ marketingConsentRequestedAt: null }).where(eq(clients.id, w.sofia)));
  await processWebhookBody(db, inboundBody({ phoneNumberId: w.phoneNumberId, from: SOFIA_PHONE, text: "confirmo" }));
  await drain();
  const question = fake.sent.find((m) => m.kind === "buttons" && m.buttons?.some((b) => b.id === "mkt|yes"));
  assert.ok(question, `se pregunta con botones: ${JSON.stringify(fake.sent)}`);
  assert.match(question!.text!, /promociones/);
  assert.deepEqual(question!.buttons?.map((b) => b.id), ["mkt|yes", "mkt|no"]);

  // Otra cita: ya no se pregunta.
  fake.sent.length = 0;
  await processWebhookBody(db, inboundBody({ phoneNumberId: w.phoneNumberId, from: SOFIA_PHONE, text: "otra cita" }));
  await drain();
  assert.ok(!fake.sent.some((m) => m.buttons?.some((b) => b.id === "mkt|yes")), "no insiste");

  fake.agentResult = okResult("¿Algo más?");
  await tapButton(w, SOFIA_PHONE, "mkt|yes", "Sí, me interesa");
  const sofia = await getClient(db, w.businessId, w.sofia);
  assert.ok(sofia?.marketingConsentAt, "consentimiento guardado");
  assert.match(fake.sent.at(-1)!.text!, /Te vamos a avisar de promociones/);
  assert.equal(fake.agentCalls.at(-1)?.history.at(-1)?.text.includes("promociones"), false, "el botón no pasa por el agente");
  const audit = await listTenantAudit(db, w.businessId, 20);
  assert.ok(audit.some((a) => a.action === "client_marketing_consent_granted" && a.details.clientId === w.sofia && a.details.source === "whatsapp"));
});

test("consentimiento: sin Campañas en el plan no se pregunta; el No no es una baja", async () => {
  const w = await setup();
  growth = { ...ALL_GROWTH, marketingConsent: false };
  await clientWrites(w, MARIA_PHONE);
  fake.agentResult = { ...okResult("Agendada."), actions: [{ type: "appointment_booked", appointmentId: "00000000-0000-4000-8000-000000000008" }] };
  await processWebhookBody(db, inboundBody({ phoneNumberId: w.phoneNumberId, from: MARIA_PHONE, text: "dale" }));
  await drain();
  assert.ok(!fake.sent.some((m) => m.buttons?.some((b) => b.id === "mkt|yes")));

  fake.agentResult = okResult("ok");
  await tapButton(w, MARIA_PHONE, "mkt|no", "No, gracias");
  const maria = await getClient(db, w.businessId, w.maria);
  assert.equal(maria?.marketingConsentAt, null);
  assert.equal(maria?.marketingOptOutAt, null, "decir que no no es pedir la baja");
  assert.match(fake.sent.at(-1)!.text!, /No te vamos a enviar promociones/);
});

// ── Reseñas ─────────────────────────────────────────────────────────────────

/** Cita de Limpieza que empezó hace `hoursAgo` horas, completada. */
async function completedAppointment(w: World, clientId: string, hoursAgo = 5) {
  const startsAt = new Date(Date.now() - hoursAgo * 3_600_000);
  const appt = await bookAppointment(db, w.businessId, {
    locationId: w.escazu,
    clientId,
    serviceIds: [w.limpieza],
    staffId: w.ana,
    startsAt,
    channel: "panel",
    allowOutsideHours: true,
  });
  return completeAppointment(db, w.businessId, appt.id);
}

async function enableReviews(w: World, reviewUrl: string | null = "https://g.page/r/demo/review") {
  await updateGrowthSettings(db, actor(w), ALL_GROWTH, { reviews: { enabled: true, delayHours: 3, reviewUrl } });
}

test("reseñas: ventana abierta → botones; «Excelente» pide la reseña; un segundo toque no la vuelve a pedir", async () => {
  const w = await setup();
  await clientWrites(w, SOFIA_PHONE);
  await enableReviews(w);
  const appt = await completedAppointment(w, w.sofia);
  assert.deepEqual(await sweepFollowUps(db, () => growth), { enqueued: 1 });
  await drain();
  const [msg] = fake.sent;
  assert.equal(msg.kind, "buttons");
  assert.match(msg.text!, /¿Cómo te fue con Limpieza en Estética Agenda\?/);
  assert.deepEqual(msg.buttons?.map((b) => b.id), [`fu|${appt.id}|positive`, `fu|${appt.id}|neutral`, `fu|${appt.id}|negative`]);
  assert.deepEqual(await sweepFollowUps(db, () => growth), { enqueued: 0 }, "nunca dos seguimientos por cita");

  await tapButton(w, SOFIA_PHONE, `fu|${appt.id}|positive`, "Excelente 😀");
  assert.match(fake.sent.at(-1)!.text!, /reseña en Google: https:\/\/g\.page\/r\/demo\/review/);
  const [row] = await withTenant(db, w.businessId, (tx) => tx.select().from(followUps).where(eq(followUps.appointmentId, appt.id)));
  assert.equal(row.sentiment, "positive");
  assert.equal(row.reviewRequested, true);

  await tapButton(w, SOFIA_PHONE, `fu|${appt.id}|positive`, "Excelente 😀");
  assert.doesNotMatch(fake.sent.at(-1)!.text!, /reseña/);
});

test("reseñas: ventana cerrada → plantilla followUp con los botones como payload; sin plantilla no se manda nada", async () => {
  const withTemplate = await setup({ followUp: { name: "seguimiento_servicio", language: "es" } });
  await enableReviews(withTemplate);
  const appt = await completedAppointment(withTemplate, withTemplate.maria);
  await sweepFollowUps(db, () => growth);
  await drain();
  const sent = fake.sent.filter((m) => m.phoneNumberId === withTemplate.phoneNumberId);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].template?.name, "seguimiento_servicio");
  assert.deepEqual(sent[0].template?.bodyParams, ["María Fernández", "Limpieza"]);
  assert.deepEqual(sent[0].template?.quickReplyPayloads, [`fu|${appt.id}|positive`, `fu|${appt.id}|neutral`, `fu|${appt.id}|negative`]);

  const noTemplate = await setup();
  await enableReviews(noTemplate);
  const other = await completedAppointment(noTemplate, noTemplate.maria);
  await sweepFollowUps(db, () => growth);
  await drain();
  assert.equal(fake.sent.filter((m) => m.phoneNumberId === noTemplate.phoneNumberId).length, 0);
  const rows = await withTenant(db, noTemplate.businessId, (tx) => tx.select().from(followUps).where(eq(followUps.appointmentId, other.id)));
  assert.equal(rows.length, 0, "se libera la fila: no cuenta como enviado");
});

test("reseñas: «Mal» pide disculpas y pasa a una persona; sin la función en el plan no hay barrido", async () => {
  const w = await setup();
  await clientWrites(w, SOFIA_PHONE);
  await enableReviews(w);
  const appt = await completedAppointment(w, w.sofia);
  await sweepFollowUps(db, () => growth);
  await drain();
  fake.pushes.length = 0;
  await tapButton(w, SOFIA_PHONE, `fu|${appt.id}|negative`, "Mal 😕");
  assert.match(fake.sent.at(-1)!.text!, /Lamentamos mucho/);
  const [conv] = await withTenant(db, w.businessId, (tx) => tx.select().from(conversations).where(eq(conversations.clientId, w.sofia)));
  assert.equal(conv.mode, "human", "pasa a una persona");

  const other = await setup();
  await enableReviews(other);
  await completedAppointment(other, other.maria);
  assert.deepEqual(await sweepFollowUps(db, (id) => (id === other.businessId ? { ...ALL_GROWTH, reviews: false } : growth)), { enqueued: 0 });
});

// ── Rescate de cotizaciones ─────────────────────────────────────────────────

async function enableQuotes(w: World) {
  await updateGrowthSettings(db, actor(w), ALL_GROWTH, { quoteRecovery: { enabled: true, waitHours: 2, firstTouchText: null } });
}

test("rescate: una cotización abierta por cliente y servicio; toque 1 con horarios como botones, toque 2 por plantilla", async () => {
  const w = await setup({ quoteRecovery: { name: "rescate_cotizacion", language: "es" } });
  await clientWrites(w, SOFIA_PHONE);
  await enableQuotes(w);
  // Con sucursal conocida se ofrecen horarios de ahí (con varias y sin preferida, va solo el texto).
  await withTenant(db, w.businessId, (tx) => tx.update(clients).set({ preferredLocationId: w.escazu }).where(eq(clients.id, w.sofia)));
  const at = new Date(Date.now() - 3 * 3_600_000);
  assert.equal(await recordQuote(db, w.businessId, { clientId: w.sofia, serviceId: w.limpieza, amountCents: 2_500_000, at }), true);
  assert.equal(await recordQuote(db, w.businessId, { clientId: w.sofia, serviceId: w.limpieza, amountCents: 2_500_000, at }), false, "no se duplica");

  assert.equal((await sweepQuoteRecovery(db, () => growth)).enqueued, 1);
  await drain();
  const [first] = fake.sent;
  assert.equal(first.kind, "buttons");
  assert.match(first.text!, /consultaste por Limpieza \(₡25\s?000\)/);
  assert.ok(first.buttons!.length >= 1 && first.buttons!.every((b) => b.id.startsWith("slot:")));
  const [q] = await withTenant(db, w.businessId, (tx) => tx.select().from(quotes).where(eq(quotes.clientId, w.sofia)));
  assert.equal(q.status, "first_touch");

  // Un día después: el segundo toque va por plantilla.
  await withTenant(db, w.businessId, (tx) => tx.update(quotes).set({ firstTouchAt: new Date(Date.now() - 25 * 3_600_000) }).where(eq(quotes.id, q.id)));
  assert.equal((await sweepQuoteRecovery(db, () => growth)).enqueued, 1);
  await drain();
  const second = fake.sent.at(-1)!;
  assert.equal(second.template?.name, "rescate_cotizacion");
  assert.equal(second.template?.bodyParams?.[0], "Sofía Castro");
  assert.equal(second.template?.bodyParams?.[1], "Limpieza");

  // Agenda: la cotización se cierra como recuperada, con el monto.
  const appt = await bookAppointment(db, w.businessId, {
    locationId: w.escazu,
    clientId: w.sofia,
    serviceIds: [w.limpieza],
    staffId: w.ana,
    startsAt: crAt(crDay(4), "10:00"),
    channel: "panel",
  });
  assert.equal(await closeQuotesForAppointment(db, w.businessId, appt), 1);
  const [closed] = await withTenant(db, w.businessId, (tx) => tx.select().from(quotes).where(eq(quotes.id, q.id)));
  assert.equal(closed.status, "recovered");
  assert.equal(closed.recoveredCents, 2_500_000);
  assert.equal(closed.appointmentId, appt.id);
});

test("rescate: quien pidió la baja no recibe toques; sin la función activada no hay barrido", async () => {
  const w = await setup();
  await clientWrites(w, MARIA_PHONE);
  await enableQuotes(w);
  await recordQuote(db, w.businessId, { clientId: w.maria, serviceId: w.manicura, amountCents: 800_000, at: new Date(Date.now() - 3 * 3_600_000) });
  await recordMarketingOptOut(db, w.businessId, w.maria);
  await sweepQuoteRecovery(db, () => growth);
  await drain();
  assert.equal(fake.sent.length, 0);
  const [q] = await withTenant(db, w.businessId, (tx) => tx.select().from(quotes).where(eq(quotes.clientId, w.maria)));
  assert.equal(q.status, "opted_out");

  const off = await setup();
  await recordQuote(db, off.businessId, { clientId: off.sofia, serviceId: off.manicura, amountCents: 800_000, at: new Date(Date.now() - 5 * 3_600_000) });
  const result = await sweepQuoteRecovery(db, (id) => (id === off.businessId ? growth : { ...ALL_GROWTH, quoteRecovery: false }));
  assert.equal(result.enqueued, 0, "el dueño no lo activó");
});

// ── Upsell ──────────────────────────────────────────────────────────────────

test("upsell: la regla aplica a la cita; lo rechazado hace poco o ya agendado no se ofrece", () => {
  const rules = [{ serviceId: "s-mani", suggestServiceId: "s-pedi" }];
  const bookable = [{ serviceId: "s-pedi", name: "Pedicura", priceCents: 1_200_000, variablePrice: false, durationMin: 60, locationIds: [] }];
  const appointment = { locationId: "loc", services: [{ serviceId: "s-mani" }] } as never;
  const today = "2026-10-25";
  assert.equal(pickUpsell({ rules, appointment, bookable, declined: [], today })?.serviceId, "s-pedi");
  assert.equal(pickUpsell({ rules, appointment, bookable, declined: [{ serviceId: "s-pedi", date: "2026-10-01" }], today }), null);
  assert.equal(pickUpsell({ rules, appointment, bookable, declined: [{ serviceId: "s-pedi", date: "2026-06-01" }], today })?.serviceId, "s-pedi", "pasados 60 días se vuelve a ofrecer");
  const both = { locationId: "loc", services: [{ serviceId: "s-mani" }, { serviceId: "s-pedi" }] } as never;
  assert.equal(pickUpsell({ rules, appointment: both, bookable, declined: [], today }), null);
  assert.equal(pickUpsell({ rules, appointment, bookable: [{ ...bookable[0], locationIds: ["otra"] }], declined: [], today }), null, "no se ofrece en esa sucursal");
});

test("upsell: agregar un servicio alarga la cita con la misma persona; si choca con otra cita, 409 slot_taken", async () => {
  const w = await setup();
  const day = crDay(5);
  const appt = await bookAppointment(db, w.businessId, { locationId: w.escazu, clientId: w.maria, serviceIds: [w.limpieza], staffId: w.ana, startsAt: crAt(day, "08:00"), channel: "panel" });
  const added = await addServiceToAppointment(db, w.businessId, appt.id, w.manicura);
  assert.deepEqual(added.services.map((s) => s.name), ["Limpieza", "Manicura"]);
  // Limpieza 60 + 10 de buffer + Manicura 40 + 5 de buffer.
  assert.equal(new Date(added.endsAt).getTime() - new Date(added.startsAt).getTime(), 115 * 60_000);
  assert.equal(added.totalCents, 2_500_000 + 800_000);
  await assert.rejects(addServiceToAppointment(db, w.businessId, appt.id, w.manicura), (e: { code?: string }) => e.code === "service_already_added");

  // Otro día: Manicura 08:00–08:45 y otra cita de Ana a las 08:45; la Pedicura no entra a continuación.
  const day2 = crDay(10);
  const tight = await bookAppointment(db, w.businessId, { locationId: w.escazu, clientId: w.maria, serviceIds: [w.manicura], staffId: w.ana, startsAt: crAt(day2, "08:00"), channel: "panel" });
  await bookAppointment(db, w.businessId, { locationId: w.escazu, clientId: w.sofia, serviceIds: [w.limpieza], staffId: w.ana, startsAt: crAt(day2, "08:45"), channel: "panel" });
  await assert.rejects(addServiceToAppointment(db, w.businessId, tight.id, w.pedicura), (e: { code?: string }) => e.code === "slot_taken");
  assert.equal((await getAppointment(db, w.businessId, tight.id))?.services.length, 1, "no quedó a medias");
});

test("upsell (agente): book_appointment ofrece la sugerencia; add_service la agrega; decline_upsell la recuerda", async () => {
  const w = await setup();
  const ctx = await loadAgentContext(db, w.businessId);
  assert.ok(ctx);
  await clientWrites(w, MARIA_PHONE);
  const [conv] = await withTenant(db, w.businessId, (tx) => tx.select().from(conversations).where(eq(conversations.clientId, w.maria)));
  const input = {
    businessId: w.businessId,
    conversationId: conv.id,
    clientId: w.maria,
    clientPhone: "+50688880001",
    clientName: "María Fernández",
    locationId: w.escazu,
    history: [],
    now: new Date(),
    growth: { quoteRecovery: true, upsellRules: [{ serviceId: w.manicura, suggestServiceId: w.pedicura }] },
  };
  const run = (name: string, args: Record<string, unknown>) =>
    executeTool(name, JSON.stringify(args), { executor: db, ctx: ctx!, input, effects: emptyEffects() }, (e) => {
      throw e;
    });
  const day = crDay(6);
  const booked = await run("book_appointment", { location_id: null, service_ids: [w.manicura], date: day, time: "08:00", staff_id: w.ana, client_name: null, notes: null });
  assert.equal(booked.ok, true, JSON.stringify(booked));
  assert.equal((booked.upsell_offer as { service_id: string }).service_id, w.pedicura);

  const added = await run("add_service_to_appointment", { appointment_id: (booked.appointment as { appointment_id: string }).appointment_id, service_id: w.pedicura });
  assert.equal(added.ok, true, JSON.stringify(added));
  assert.match(String((added.appointment as { services: string }).services), /Manicura \+ Pedicura/);
  const notInRules = await run("add_service_to_appointment", { appointment_id: null, service_id: w.limpieza });
  assert.equal(notInRules.ok, false, "solo lo que ofrecen las reglas");

  await run("decline_upsell", { service_id: w.pedicura });
  const again = await run("book_appointment", { location_id: null, service_ids: [w.manicura], date: crDay(7), time: "08:00", staff_id: w.ana, client_name: null, notes: null });
  assert.equal(again.ok, true, JSON.stringify(again));
  assert.equal(again.upsell_offer, undefined, "rechazado hace poco: no se ofrece");

  const quoted = await run("record_quote", { service_id: w.limpieza });
  assert.equal(quoted.ok, true);
  const off = await executeTool("record_quote", JSON.stringify({ service_id: w.limpieza }), { executor: db, ctx: ctx!, input: { ...input, growth: undefined }, effects: emptyEffects() }, () => {});
  assert.equal(off.ok, false, "sin rescate activo la tool no hace nada");
});

// ── Campañas ────────────────────────────────────────────────────────────────

const PROMO = { name: "Promo de octubre", message: "Este mes la limpieza facial va con 20% de descuento.", segment: {} };

test("campañas: vista previa con excluidos; lanzar exige plantilla de marketing y audiencia", async () => {
  const w = await setup();
  await recordMarketingConsent(db, w.businessId, w.maria, true);
  const preview = await previewSegment(db, w.businessId, {});
  assert.equal(preview.eligible, 1);
  assert.equal(preview.withoutConsent, 1);
  assert.deepEqual(preview.sample.map((s) => s.name), ["María Fernández"]);
  assert.deepEqual(preview.channels, { connected: 1, withTemplate: 0 });

  const draft = await createCampaign(db, w.businessId, PROMO, null);
  assert.equal(draft.status, "draft");
  const owner = "00000000-0000-4000-8000-0000000000aa";
  await assert.rejects(launchCampaign(db, w.businessId, draft.id, { userId: owner }), (e: { code?: string }) => e.code === "no_marketing_template");

  const empty = await setup({ marketing: { name: "promo", language: "es" } });
  const nobody = await createCampaign(db, empty.businessId, PROMO, null);
  await assert.rejects(launchCampaign(db, empty.businessId, nobody.id, { userId: owner }), (e: { code?: string }) => e.code === "empty_audience");
});

test("campañas: el despacho manda la plantilla, salta a quien pidió la baja y completa; resultados con respuestas y citas", async () => {
  const w = await setup({ marketing: { name: "promo_mensual", language: "es" } });
  await recordMarketingConsent(db, w.businessId, w.maria, true);
  await recordMarketingConsent(db, w.businessId, w.sofia, true);
  const draft = await createCampaign(db, w.businessId, PROMO, null);
  const launched = await launchCampaign(db, w.businessId, draft.id, { userId: "00000000-0000-4000-8000-0000000000aa" });
  assert.equal(launched.status, "sending");
  assert.equal(launched.totalRecipients, 2);

  // Sofía pide la baja antes de que le toque: se la salta.
  await recordMarketingOptOut(db, w.businessId, w.sofia);
  await drain();
  const sent = fake.sent.filter((m) => m.kind === "template");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].template?.name, "promo_mensual");
  assert.deepEqual(sent[0].template?.bodyParams, ["María Fernández", PROMO.message]);

  // María responde y agenda: cuenta en los resultados.
  fake.agentResult = okResult("¡Claro!");
  await processWebhookBody(db, inboundBody({ phoneNumberId: w.phoneNumberId, from: MARIA_PHONE, text: "¡Quiero la promo!" }));
  await drain();
  await bookAppointment(db, w.businessId, { locationId: w.escazu, clientId: w.maria, serviceIds: [w.limpieza], staffId: w.ana, startsAt: crAt(crDay(8), "09:00"), channel: "panel" });

  const detail = await getCampaign(db, w.businessId, draft.id);
  assert.equal(detail.status, "completed");
  assert.deepEqual(detail.counts, { total: 2, pending: 0, sent: 1, failed: 0, skipped: 1 });
  assert.deepEqual(detail.results, { replied: 1, appointments: 1, clientsBooked: 1 });
  assert.deepEqual(detail.recipients.map((r) => r.status).sort(), ["sent", "skipped"]);
});

test("campañas: programada espera su hora; cancelar deja lo pendiente omitido y no manda nada", async () => {
  const w = await setup({ marketing: { name: "promo_mensual", language: "es" } });
  await recordMarketingConsent(db, w.businessId, w.maria, true);
  const draft = await createCampaign(db, w.businessId, { ...PROMO, segment: { excludeUpcoming: false } }, null);
  const later = new Date(Date.now() + 2 * 86_400_000);
  const scheduled = await launchCampaign(db, w.businessId, draft.id, { userId: "00000000-0000-4000-8000-0000000000aa", scheduledFor: later });
  assert.equal(scheduled.status, "scheduled");
  assert.equal(scheduled.scheduledFor, later.toISOString());
  const cancelled = await cancelCampaign(db, w.businessId, draft.id, "00000000-0000-4000-8000-0000000000aa");
  assert.equal(cancelled.status, "cancelled");
  assert.deepEqual(cancelled.counts, { total: 1, pending: 0, sent: 0, failed: 0, skipped: 1 });
  const rows = await withTenant(db, w.businessId, (tx) => tx.select().from(campaignSends).where(and(eq(campaignSends.campaignId, draft.id), eq(campaignSends.status, "skipped"))));
  assert.equal(rows[0].error, "cancelled");
  await assert.rejects(cancelCampaign(db, w.businessId, draft.id, "00000000-0000-4000-8000-0000000000aa"), (e: { code?: string }) => e.code === "campaign_finished");
  assert.equal(fake.sent.filter((m) => m.kind === "template").length, 0);
});

test("campañas: el segmento usa los filtros del CRM y excluye a quien ya tiene una cita próxima", async () => {
  const w = await setup();
  await recordMarketingConsent(db, w.businessId, w.maria, true);
  await recordMarketingConsent(db, w.businessId, w.sofia, true);
  await withTenant(db, w.businessId, (tx) => tx.update(clients).set({ tags: ["vip-facial"] }).where(eq(clients.id, w.sofia)));
  assert.deepEqual((await previewSegment(db, w.businessId, { tags: ["vip-facial"] })).sample.map((s) => s.name), ["Sofía Castro"]);

  await bookAppointment(db, w.businessId, { locationId: w.escazu, clientId: w.maria, serviceIds: [w.limpieza], staffId: w.ana, startsAt: crAt(crDay(9), "09:00"), channel: "panel" });
  assert.deepEqual((await previewSegment(db, w.businessId, {})).sample.map((s) => s.name), ["Sofía Castro"], "María ya vuelve sola");
  assert.equal((await previewSegment(db, w.businessId, { excludeUpcoming: false })).eligible, 2);

  // "Te toca de nuevo": última limpieza completada hace más de 6 meses.
  const old = await bookAppointment(db, w.businessId, {
    locationId: w.escazu,
    clientId: w.sofia,
    serviceIds: [w.limpieza],
    staffId: w.ana,
    startsAt: new Date(Date.now() - 200 * 86_400_000),
    channel: "panel",
    allowOutsideHours: true,
  });
  await completeAppointment(db, w.businessId, old.id);
  const lapsed = await previewSegment(db, w.businessId, { lapsedService: { serviceId: w.limpieza, months: 6 }, excludeUpcoming: false });
  assert.deepEqual(lapsed.sample.map((s) => s.name), ["Sofía Castro"]);
});
