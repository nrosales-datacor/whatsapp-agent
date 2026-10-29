import assert from "node:assert/strict";
import { after, test } from "node:test";
import { eq, sql } from "drizzle-orm";
import { businesses } from "../../src/modules/business/schema";
import { services } from "../../src/modules/catalog/schema";
import { clients } from "../../src/modules/clients/schema";
import { commissionEntries } from "../../src/modules/commissions/schema";
import { campaigns, campaignSends } from "../../src/modules/campaigns/schema";
import { payments } from "../../src/modules/sales/schema";
import { appointments, appointmentServices, reminders } from "../../src/modules/scheduling/schema";
import { memberships, staff, users } from "../../src/modules/team/schema";
import { conversations, messages, whatsappChannels } from "../../src/modules/whatsapp/schema";
import { configHistory, dailyUsage, pushSubscriptions } from "../../src/platform/db/schema";
import { rowsOf } from "../../src/platform/db/rows";
import { withSystem, withTenant } from "../../src/platform/db/scope";
import { appointmentValues, createBusinessFixture, hasPgCode, type BusinessFixture } from "../helpers/domainFixtures";
import { createEphemeralDb } from "../helpers/pgliteDb";

// ─────────────────────────────────────────────────────────────────────────────
// Lo del esquema del dominio que vive en SQL a mano (drizzle/0002_domain_constraints.sql)
// o que es fácil de romper al regenerar migraciones: FKs de las tablas de plataforma,
// trigger de última actividad, la cascada de la baja de un negocio y las FKs NO ACTION
// que protegen el histórico contable.
// ─────────────────────────────────────────────────────────────────────────────

const base = await createEphemeralDb();
const { db } = base;
after(() => base.close());

const FK_VIOLATION = "23503";
const UNIQUE_VIOLATION = "23505";
const CHECK_VIOLATION = "23514";

test("SQL a mano: las FKs de las tablas de plataforma y el EXCLUDE de las citas existen en la base migrada", async () => {
  const rows = rowsOf<{ conname: string; contype: string; deltype: string }>(
    await db.execute(sql`
      SELECT conname, contype, confdeltype AS deltype FROM pg_constraint
      WHERE conname IN (
        'push_subscriptions_business_id_businesses_id_fk', 'push_subscriptions_user_id_users_id_fk',
        'config_history_business_id_businesses_id_fk', 'config_history_changed_by_users_id_fk',
        'daily_usage_business_id_businesses_id_fk', 'appointments_staff_no_overlap'
      )
    `),
  );
  const byName = Object.fromEntries(rows.map((r) => [r.conname, r]));
  // confdeltype: c = CASCADE, n = SET NULL. contype: f = FK, x = EXCLUDE.
  assert.equal(byName.push_subscriptions_business_id_businesses_id_fk?.deltype, "c");
  assert.equal(byName.push_subscriptions_user_id_users_id_fk?.deltype, "c");
  assert.equal(byName.config_history_business_id_businesses_id_fk?.deltype, "c");
  assert.equal(byName.config_history_changed_by_users_id_fk?.deltype, "n");
  assert.equal(byName.daily_usage_business_id_businesses_id_fk?.deltype, "c");
  assert.equal(byName.appointments_staff_no_overlap?.contype, "x");
});

async function channelAndConversation(f: BusinessFixture, phoneNumberId: string) {
  return withTenant(db, f.businessId, async (tx) => {
    const [channel] = await tx
      .insert(whatsappChannels)
      .values({ businessId: f.businessId, phoneNumberId })
      .returning({ id: whatsappChannels.id });
    const [conv] = await tx
      .insert(conversations)
      .values({ businessId: f.businessId, clientId: f.clientId, channelId: channel.id, lastActivityAt: new Date("2026-11-01T00:00:00Z") })
      .returning({ id: conversations.id });
    return { channelId: channel.id, conversationId: conv.id };
  });
}

test("trigger: cada mensaje nuevo adelanta conversations.last_activity_at (y uno con fecha vieja no la atrasa)", async () => {
  const f = await createBusinessFixture(db);
  const { conversationId } = await channelAndConversation(f, "pnid-trigger");
  const activity = async () => {
    const [c] = await withTenant(db, f.businessId, (tx) =>
      tx.select({ at: conversations.lastActivityAt }).from(conversations).where(eq(conversations.id, conversationId)),
    );
    return c.at.toISOString();
  };
  const msg = (createdAt: string) =>
    withTenant(db, f.businessId, (tx) =>
      tx.insert(messages).values({ businessId: f.businessId, conversationId, role: "user", content: "hola", createdAt: new Date(createdAt) }),
    );
  await msg("2026-11-02T10:00:00Z");
  assert.equal(await activity(), "2026-11-02T10:00:00.000Z");
  await msg("2026-11-01T08:00:00Z");
  assert.equal(await activity(), "2026-11-02T10:00:00.000Z", "GREATEST: no retrocede");
});

test("trigger: funciona con el rol de la app (el UPDATE pasa por RLS con el mismo contexto)", async () => {
  const f = await createBusinessFixture(db);
  const { conversationId } = await channelAndConversation(f, "pnid-trigger-rls");
  await base.client.exec("SET ROLE app_runtime");
  try {
    await withTenant(db, f.businessId, (tx) =>
      tx.insert(messages).values({ businessId: f.businessId, conversationId, role: "user", content: "hola", createdAt: new Date("2026-12-01T10:00:00Z") }),
    );
    const [c] = await withTenant(db, f.businessId, (tx) =>
      tx.select({ at: conversations.lastActivityAt }).from(conversations).where(eq(conversations.id, conversationId)),
    );
    assert.equal(c.at.toISOString(), "2026-12-01T10:00:00.000Z");
  } finally {
    await base.client.exec("RESET ROLE");
  }
});

test("FKs NO ACTION: no se borra un cliente ni un profesional con citas (se desactiva o anonimiza)", async () => {
  const f = await createBusinessFixture(db);
  await withTenant(db, f.businessId, async (tx) => {
    await tx.insert(appointments).values(appointmentValues(f, "2026-11-10T15:00:00Z", 60));
  });
  await assert.rejects(
    withTenant(db, f.businessId, (tx) => tx.delete(clients).where(eq(clients.id, f.clientId))),
    (e) => hasPgCode(e, FK_VIOLATION),
  );
  await assert.rejects(
    withTenant(db, f.businessId, (tx) => tx.delete(staff).where(eq(staff.id, f.staffIds[0]))),
    (e) => hasPgCode(e, FK_VIOLATION),
  );
});

test("CHECKs y únicos: estado desconocido, teléfono no E.164, teléfono repetido en el mismo negocio", async () => {
  const fa = await createBusinessFixture(db);
  const fb = await createBusinessFixture(db);
  await assert.rejects(
    withTenant(db, fa.businessId, (tx) => tx.insert(appointments).values(appointmentValues(fa, "2026-11-11T15:00:00Z", 30, { status: "booked" }))),
    (e) => hasPgCode(e, CHECK_VIOLATION),
  );
  await assert.rejects(
    withTenant(db, fa.businessId, (tx) => tx.insert(clients).values({ businessId: fa.businessId, name: "X", phone: "8888-0000" })),
    (e) => hasPgCode(e, CHECK_VIOLATION),
  );
  await assert.rejects(
    withTenant(db, fa.businessId, (tx) => tx.insert(clients).values({ businessId: fa.businessId, name: "Otro", phone: "+50688880000" })),
    (e) => hasPgCode(e, UNIQUE_VIOLATION),
    "el fixture ya tiene ese teléfono en este negocio",
  );
  // Mismo teléfono en OTRO negocio: es otro cliente, válido. (El fixture de B ya lo usa.)
  const both = await withSystem(db, (tx) => tx.select({ b: clients.businessId }).from(clients).where(eq(clients.phone, "+50688880000")));
  assert.ok(both.some((r) => r.b === fa.businessId) && both.some((r) => r.b === fb.businessId));
});

test("baja de un negocio: la cascada borra TODAS sus filas (incluidas las de plataforma); el usuario global queda", async () => {
  const f = await createBusinessFixture(db);
  const other = await createBusinessFixture(db);
  const [user] = await withSystem(db, (tx) =>
    tx.insert(users).values({ email: `baja-${f.businessId.slice(0, 8)}@example.com`, name: "Dueña" }).returning({ id: users.id }),
  );
  await withTenant(db, f.businessId, async (tx) => {
    await tx.insert(memberships).values({ businessId: f.businessId, userId: user.id, role: "owner" });
    const [svc] = await tx
      .insert(services)
      .values({ businessId: f.businessId, name: "Limpieza facial", durationMin: 60, priceCents: 2_500_000 })
      .returning({ id: services.id });
    const [appt] = await tx
      .insert(appointments)
      .values(appointmentValues(f, "2026-11-12T15:00:00Z", 60, { status: "completed", totalCents: 2_500_000 }))
      .returning({ id: appointments.id });
    const [line] = await tx
      .insert(appointmentServices)
      .values({ businessId: f.businessId, appointmentId: appt.id, serviceId: svc.id, name: "Limpieza facial", durationMin: 60, priceCents: 2_500_000 })
      .returning({ id: appointmentServices.id });
    await tx.insert(reminders).values({
      businessId: f.businessId,
      appointmentId: appt.id,
      kind: "day_before",
      channel: "whatsapp",
      scheduledFor: new Date("2026-11-11T15:00:00Z"),
    });
    await tx.insert(payments).values({
      businessId: f.businessId,
      locationId: f.locationId,
      clientId: f.clientId,
      appointmentId: appt.id,
      amountCents: 2_500_000,
      paymentMethodId: f.paymentMethodId,
      recordedBy: user.id,
    });
    await tx.insert(commissionEntries).values({
      businessId: f.businessId,
      staffId: f.staffIds[0],
      appointmentServiceId: line.id,
      appointmentId: appt.id,
      locationId: f.locationId,
      earnedAt: new Date("2026-11-12T15:00:00Z"),
      baseCents: 2_500_000,
      amountCents: 375_000,
      rule: { ruleId: null, kind: "percent", value: 1500 },
    });
    const [camp] = await tx
      .insert(campaigns)
      .values({ businessId: f.businessId, name: "Promo", message: "Hola", segment: {} })
      .returning({ id: campaigns.id });
    await tx.insert(campaignSends).values({ businessId: f.businessId, campaignId: camp.id, clientId: f.clientId });
    await tx.insert(pushSubscriptions).values({ businessId: f.businessId, userId: user.id, sessionEpoch: 0, endpoint: `https://push.example/${f.businessId}`, p256dh: "k", auth: "a" });
    await tx.insert(configHistory).values({ businessId: f.businessId, entity: "business", snapshot: { name: "x" }, changedBy: user.id });
    await tx.insert(dailyUsage).values({ businessId: f.businessId, date: "2026-11-12", metric: "appointments_created", value: 1 });
  });
  const { conversationId } = await channelAndConversation(f, "pnid-baja");
  await withTenant(db, f.businessId, (tx) =>
    tx.insert(messages).values({ businessId: f.businessId, conversationId, role: "user", content: "hola" }),
  );

  await withSystem(db, (tx) => tx.delete(businesses).where(eq(businesses.id, f.businessId)));

  const tables = rowsOf<{ table_name: string }>(
    await db.execute(sql`
      SELECT table_name FROM information_schema.columns
      WHERE table_schema = 'public' AND column_name = 'business_id' AND table_name <> 'audit_log'
    `),
  ).map((r) => r.table_name);
  assert.ok(tables.length >= 30, `se esperaban todas las tablas de negocio (hay ${tables.length})`);
  const leftovers: string[] = [];
  for (const table of tables) {
    const [r] = rowsOf<{ n: number }>(
      await db.execute(sql`SELECT count(*)::int AS n FROM ${sql.identifier(table)} WHERE business_id = ${f.businessId}`),
    );
    if (r.n > 0) leftovers.push(`${table}: ${r.n}`);
  }
  assert.deepEqual(leftovers, [], "audit_log queda a propósito (rastro de la baja); el resto se va");

  const [u] = await withSystem(db, (tx) => tx.select({ id: users.id }).from(users).where(eq(users.id, user.id)));
  assert.ok(u, "el usuario es global: puede estar en otros negocios");
  const [stillThere] = await withSystem(db, (tx) => tx.select({ id: businesses.id }).from(businesses).where(eq(businesses.id, other.businessId)));
  assert.ok(stillThere, "el otro negocio no se toca");
});
