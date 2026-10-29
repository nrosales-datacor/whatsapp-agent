import assert from "node:assert/strict";
import { test } from "node:test";
import { segmentQuery } from "../../src/modules/campaigns/segment";
import { directActionOf, followUpReplyOf, marketingConsentReplyOf } from "../../src/modules/whatsapp/commands";
import { describeInteractiveReply, followUpButtonIds, marketingConsentButtonIds } from "../../src/modules/whatsapp/payload";
import { TOOL_DEFINITIONS, TOOL_NAMES, toolDefinitionsFor } from "../../src/modules/whatsapp/agent/tools";

// ─────────────────────────────────────────────────────────────────────────────
// Piezas puras del crecimiento (I6): el protocolo de botones del consentimiento y del
// seguimiento post-servicio (codificar ↔ decodificar), las tools que se le ofrecen al
// modelo según lo activo, y las fechas relativas de un segmento de campaña.
// ─────────────────────────────────────────────────────────────────────────────

const APPT = "5b1c3d4e-0000-4000-8000-00000000abcd";

test("botones de promociones y de seguimiento: ida y vuelta, y frase para el historial", () => {
  const mkt = marketingConsentButtonIds();
  assert.equal(marketingConsentReplyOf({ interactiveId: mkt.yes }), true);
  assert.equal(marketingConsentReplyOf({ interactiveId: mkt.no }), false);
  assert.equal(marketingConsentReplyOf({ interactiveId: "mkt|quizas" }), null);
  assert.equal(directActionOf({ kind: "text", text: "Sí, quiero", interactiveId: mkt.yes }), "marketing_consent");

  const fu = followUpButtonIds(APPT);
  assert.deepEqual(followUpReplyOf({ interactiveId: fu.negative }), { appointmentId: APPT, answer: "negative" });
  assert.equal(followUpReplyOf({ interactiveId: "fu|no-es-uuid|positive" }), null);
  assert.equal(followUpReplyOf({ interactiveId: `fu|${APPT}|feliz` }), null);
  assert.equal(directActionOf({ kind: "text", text: "Excelente", interactiveId: fu.positive }), "follow_up_reply");
  // Escrito a mano (sin botón) es un turno del agente, no una acción directa.
  assert.equal(directActionOf({ kind: "text", text: "sí" }), null);

  assert.equal(describeInteractiveReply(mkt.yes, "Sí, me interesa"), "Sí, quiero recibir promociones");
  assert.equal(describeInteractiveReply(fu.positive, "Excelente 😀"), "¡Excelente! 😀");
  assert.equal(describeInteractiveReply("slot:2026-10-30T10:00", "jue 30 · 10:00"), "jue 30 · 10:00");
});

test("tools del turno: las de crecimiento solo si están activas; los nombres de todas para las evals", () => {
  assert.equal(toolDefinitionsFor(undefined).length, TOOL_DEFINITIONS.length);
  const names = (g: Parameters<typeof toolDefinitionsFor>[0]) => toolDefinitionsFor(g).map((t) => t.function.name);
  assert.ok(names({ quoteRecovery: true, upsellRules: [] }).includes("record_quote"));
  assert.ok(!names({ quoteRecovery: true, upsellRules: [] }).includes("decline_upsell"));
  const upsell = names({ quoteRecovery: false, upsellRules: [{ serviceId: "a", suggestServiceId: "b" }] });
  assert.ok(upsell.includes("add_service_to_appointment") && upsell.includes("decline_upsell") && !upsell.includes("record_quote"));
  for (const n of ["record_quote", "add_service_to_appointment", "decline_upsell"]) assert.ok(TOOL_NAMES.includes(n));
  for (const t of toolDefinitionsFor({ quoteRecovery: true, upsellRules: [{ serviceId: "a", suggestServiceId: "b" }] })) {
    assert.equal(t.function.strict, true, t.function.name);
  }
});

test("segmento: «hace al menos/como mucho N días» en la zona del negocio; sin citas próximas por defecto", () => {
  const now = new Date("2026-10-25T15:00:00Z"); // 09:00 en Costa Rica
  const biz = "00000000-0000-4000-8000-000000000001";
  const { filters, scope } = segmentQuery(biz, { lastVisitMinDays: 60, lastVisitMaxDays: 180, tags: ["vip"], statuses: ["at_risk"] }, now, "America/Costa_Rica");
  assert.equal(filters.lastVisitTo, "2026-08-26");
  assert.equal(filters.lastVisitFrom, "2026-04-28");
  assert.deepEqual(filters.tags, ["vip"]);
  assert.deepEqual(filters.statuses, ["at_risk"]);
  assert.ok(scope, "excluye por defecto a quien ya tiene cita próxima");
  assert.equal(segmentQuery(biz, { excludeUpcoming: false }, now, "America/Costa_Rica").scope, undefined);
  assert.deepEqual(segmentQuery(biz, {}, now, "America/Costa_Rica").filters.tags, undefined, "vacío = todos");
});
