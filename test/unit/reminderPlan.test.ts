import assert from "node:assert/strict";
import { test } from "node:test";
import { initialReminderChannel, planReminders, resolveReminderChannel } from "../../src/modules/scheduling/reminders";
import { zonedInstant } from "../../src/modules/scheduling/time";

// ─────────────────────────────────────────────────────────────────────────────
// Plan de recordatorios (cuándo, en la zona de la sucursal) y la regla del canal
// (PLAN-GESTION.md §4), puros. El circuito completo (loop → job → correo) está en
// test/reliability/reminders.test.ts.
// ─────────────────────────────────────────────────────────────────────────────

const CR = "America/Costa_Rica";
const MONDAY = "2026-10-26";
const at = (hm: string, date = MONDAY) => {
  const [h, m] = hm.split(":").map(Number);
  return zonedInstant(date, h * 60 + m, CR);
};

test("recordatorios: el día anterior a las 17:00 y el mismo día 2 h antes (nunca antes de las 7)", () => {
  const plan = (start: Date, now: Date) => planReminders(start, CR, now).map((r) => [r.kind, r.scheduledFor.toISOString()]);
  const monday = new Date("2026-10-26T15:00:00Z"); // lunes 09:00 en CR
  // Reservada el miércoles anterior para el lunes a las 10:00.
  assert.deepEqual(plan(at("10:00"), new Date("2026-10-21T15:00:00Z")), [
    ["day_before", "2026-10-25T23:00:00.000Z"], // domingo 17:00
    ["same_day", "2026-10-26T14:00:00.000Z"], // lunes 08:00
  ]);
  // A las 08:00: el del mismo día a las 07:00 (1 h antes); a las 07:20 se omite.
  assert.deepEqual(plan(at("08:00"), new Date("2026-10-21T15:00:00Z"))[1], ["same_day", "2026-10-26T13:00:00.000Z"]);
  assert.deepEqual(
    plan(at("07:20"), new Date("2026-10-21T15:00:00Z")).map(([k]) => k),
    ["day_before"],
  );
  // Reservada el domingo a las 18:00: el del día anterior ya pasó.
  assert.deepEqual(plan(at("10:00"), at("18:00", "2026-10-25")).map(([k]) => k), ["same_day"]);
  // Reservada una hora antes: ninguno.
  assert.deepEqual(plan(at("10:00"), monday), []);
});

test("canal del recordatorio (§4): preferido si el negocio lo tiene; correo con email; WhatsApp con número", () => {
  assert.equal(initialReminderChannel(["whatsapp", "email"], "email"), "email");
  assert.equal(initialReminderChannel(["whatsapp"], "email"), "whatsapp", "el negocio no tiene correo activo: su default");
  assert.equal(initialReminderChannel([], "email"), null);
  const base = { businessChannels: ["whatsapp", "email"] as const, preferred: null, hasEmail: true, whatsappConnected: false };
  assert.equal(resolveReminderChannel({ ...base }), "email", "sin WhatsApp conectado cae a correo");
  assert.equal(resolveReminderChannel({ ...base, whatsappConnected: true }), "whatsapp");
  assert.equal(resolveReminderChannel({ ...base, preferred: "email", whatsappConnected: true }), "email");
  assert.equal(resolveReminderChannel({ ...base, hasEmail: false }), "whatsapp_pending");
  assert.equal(resolveReminderChannel({ ...base, businessChannels: ["email"], hasEmail: false }), "none");
  assert.equal(resolveReminderChannel({ ...base, businessChannels: ["whatsapp"], preferred: "email" }), "whatsapp_pending");
});
