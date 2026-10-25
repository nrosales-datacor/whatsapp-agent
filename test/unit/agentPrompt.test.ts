import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentContext } from "../../src/modules/whatsapp/agent/context";
import { buildMessages } from "../../src/modules/whatsapp/agent/runner";
import { buildSystemPrompt, buildTurnContext, hoursText } from "../../src/modules/whatsapp/agent/prompt";
import { agentText, isOutOfScopeReply } from "../../src/modules/whatsapp/agent/texts";

// ─────────────────────────────────────────────────────────────────────────────
// Prompt del agente (sin base ni OpenAI): identidad, terminología del rubro, registro,
// sucursales con dirección y horario, precios ("se cotiza" sin inventar), conocimiento y
// FAQ; y la regla de caché: el prompt del negocio no depende de la hora, del canal ni del
// cliente (eso va en el mensaje del turno, al final).
// ─────────────────────────────────────────────────────────────────────────────

const ESCAZU = "11111111-1111-4111-8111-111111111111";
const HEREDIA = "22222222-2222-4222-8222-222222222222";

function dentalContext(overrides: Partial<AgentContext> = {}): AgentContext {
  return {
    businessId: "99999999-9999-4999-8999-999999999999",
    businessName: "Clínica Sonrisa",
    businessKind: "un negocio de odontología",
    country: "CR",
    currency: "CRC",
    timezone: "America/Costa_Rica",
    terminology: {
      client: "paciente",
      clients: "pacientes",
      staffMember: "especialista",
      staff: "especialistas",
      appointment: "cita",
      appointments: "citas",
      location: "sede",
      locations: "sedes",
    },
    locations: [
      {
        id: ESCAZU,
        name: "Escazú",
        address: "Plaza Demo, local 4",
        phone: "+50600000100",
        timezone: "America/Costa_Rica",
        hours: [
          { weekday: 1, start: "14:00", end: "19:00" },
          { weekday: 1, start: "09:00", end: "13:00" },
          { weekday: 6, start: "09:00", end: "12:00" },
        ],
      },
      { id: HEREDIA, name: "Heredia", address: null, phone: null, timezone: "America/Costa_Rica", hours: [] },
    ],
    services: [
      { id: "s-limpieza", name: "Limpieza dental", description: "Con flúor", durationMin: 45, priceCents: 2_500_000, variablePrice: false, locationIds: [] },
      { id: "s-ortodoncia", name: "Valoración de ortodoncia", description: null, durationMin: 30, priceCents: 0, variablePrice: false, locationIds: [ESCAZU] },
      { id: "s-blanqueamiento", name: "Blanqueamiento", description: null, durationMin: 60, priceCents: 9_000_000, variablePrice: true, locationIds: [] },
    ],
    staff: [{ id: "st-ana", name: "Dra. Ana", locationIds: [ESCAZU, HEREDIA] }],
    settings: {
      tone: "profesional y cálido",
      register: "usted",
      instructions: "No atendemos urgencias por WhatsApp.",
      knowledge: [{ id: "pagos", title: "Formas de pago", items: ["SINPE Móvil", "Tarjeta"] }],
      faq: [{ question: "¿Atienden niños?", answer: "Desde los 6 años." }],
      texts: {},
    },
    ...overrides,
  };
}

test("buildSystemPrompt: identidad, terminología, registro, sedes con dirección y horario, precios, conocimiento y FAQ", () => {
  const prompt = buildSystemPrompt(dentalContext());
  assert.match(prompt, /asistente de WhatsApp de "Clínica Sonrisa", un negocio de odontología/);
  assert.match(prompt, /Decí "paciente"/);
  assert.match(prompt, /"especialista" \/ "especialistas"/);
  assert.match(prompt, /"sede" \/ "sedes"/);
  assert.match(prompt, /tratando al cliente de usted/);
  assert.match(prompt, /Tono: profesional y cálido/);
  assert.match(prompt, /# INSTRUCCIONES DEL NEGOCIO\nNo atendemos urgencias por WhatsApp\./);
  // Sedes: dirección, teléfono y horario ordenado (lunes con dos tramos, domingo cerrado).
  assert.match(prompt, /- Escazú \(id: 11111111-1111-4111-8111-111111111111\)\n  Dirección: Plaza Demo, local 4\n  Teléfono: \+50600000100/);
  assert.match(prompt, /lunes: 09:00–13:00 y 14:00–19:00/);
  assert.match(prompt, /sábado: 09:00–12:00 · domingo: cerrado/);
  // Precios: el de lista, "se cotiza" sin precio, "desde" si es variable; y dónde se ofrece.
  assert.match(prompt, /- Limpieza dental \(id: s-limpieza\): ₡\s?25[\s.]000, ~45 min — Con flúor/);
  assert.match(prompt, /- Valoración de ortodoncia \(id: s-ortodoncia\): se cotiza, ~30 min — solo en: Escazú/);
  assert.match(prompt, /Blanqueamiento \(id: s-blanqueamiento\): desde ₡\s?90[\s.]000 \(se cotiza\)/);
  assert.match(prompt, /Dra\. Ana \(id: st-ana\) — atiende en: Escazú, Heredia/);
  assert.match(prompt, /## Formas de pago\n- SINPE Móvil\n- Tarjeta/);
  assert.match(prompt, /- P: ¿Atienden niños\?\n {2}R: Desde los 6 años\./);
  // Reglas que no se negocian.
  assert.match(prompt, /NO INVENTES NADA/);
  assert.match(prompt, /check_availability/);
  assert.match(prompt, /CONFIRMAR ANTES DE ACTUAR/);
  assert.match(prompt, /handoff_to_human/);
  assert.match(prompt, /solo puedo ayudarle con cosas de Clínica Sonrisa/, "ejemplo de fuera de alcance en el registro del negocio");
});

test("buildSystemPrompt: el registro vos y el tú cambian la frase de trato", () => {
  const base = dentalContext();
  assert.match(buildSystemPrompt({ ...base, settings: { ...base.settings, register: "vos" } }), /tratando al cliente de vos/);
  assert.match(buildSystemPrompt({ ...base, settings: { ...base.settings, register: "tu" } }), /tratando al cliente de tú/);
});

test("buildSystemPrompt: estable (no depende de la hora); la fecha, el canal y el cliente van en el mensaje del turno", () => {
  const ctx = dentalContext();
  const a = buildSystemPrompt(ctx);
  assert.equal(a, buildSystemPrompt(ctx));
  assert.doesNotMatch(a, /2026|Ahora mismo/);

  const turn = buildTurnContext(ctx, { now: new Date("2026-10-21T15:03:00Z"), channelLocationId: ESCAZU, clientName: "Marco" });
  assert.match(turn, /Hoy es 2026-10-21/);
  assert.match(turn, /09:03/, "hora local de Costa Rica (UTC−6)");
  assert.match(turn, /este año es 2026/);
  assert.match(turn, /atiende solo la sede Escazú/);
  assert.match(turn, /se llama Marco/);

  const multi = buildTurnContext(ctx, { now: new Date("2026-10-21T15:03:00Z"), channelLocationId: null, clientName: "Sin nombre" });
  assert.match(multi, /atiende todas las sedes: si el paciente no dijo en cuál, preguntale/);
  assert.match(multi, /todavía no tiene nombre registrado/);
});

test("buildMessages: prompt → historial previo → contexto del turno → mensajes nuevos del cliente", () => {
  const ctx = dentalContext();
  const now = new Date("2026-10-21T15:00:00Z");
  const messages = buildMessages(
    ctx,
    {
      businessId: ctx.businessId,
      conversationId: "c",
      clientId: "x",
      clientPhone: "+50688887777",
      clientName: "Marco",
      locationId: null,
      now,
      history: [
        { role: "user", text: "hola", at: new Date("2026-10-21T14:00:00Z") },
        { role: "assistant", text: "¡Hola! ¿En qué le ayudo?", at: new Date("2026-10-21T14:00:05Z") },
        { role: "user", text: "quiero una limpieza", at: new Date("2026-10-21T14:59:00Z") },
        { role: "user", text: "para mañana", at: new Date("2026-10-21T14:59:30Z") },
      ],
    },
    { maxMessages: 20, maxDays: 30 },
  );
  assert.deepEqual(
    messages.map((m) => m.role),
    ["system", "user", "assistant", "system", "user", "user"],
  );
  assert.match(String(messages[3].content), /CONTEXTO DE ESTE TURNO/);
  assert.equal(messages[5].content, "para mañana");
});

test("hoursText y textos fijos por registro, con override del negocio", () => {
  assert.equal(hoursText({ hours: [] }).split(" · ").length, 7);
  const settings = { register: "usted" as const, texts: {} };
  assert.match(agentText(settings, "handoff"), /Permítame consultarlo/);
  assert.match(agentText({ register: "vos", texts: {} }, "notUnderstood"), /¿Me lo repetís\?/);
  assert.equal(agentText({ register: "vos", texts: { handoff: "Ya le aviso a alguien" } }, "handoff"), "Ya le aviso a alguien");
  assert.equal(isOutOfScopeReply("Disculpe, solo puedo ayudarle con cosas de la clínica"), true);
  assert.equal(isOutOfScopeReply("Claro, te ayudo con tu cita"), false);
});

test("buildSystemPrompt: las reglas de crecimiento (I6) aparecen solo si están activas en el negocio", () => {
  const ctx = dentalContext();
  const off = buildSystemPrompt(ctx);
  assert.doesNotMatch(off, /record_quote|upsell_offer/);
  const quotes = buildSystemPrompt(ctx, { quoteRecovery: true, upsellRules: [] });
  assert.match(quotes, /SEGUIMIENTO DE COTIZACIONES.*`record_quote`/);
  assert.doesNotMatch(quotes, /upsell_offer/);
  const upsell = buildSystemPrompt(ctx, { quoteRecovery: false, upsellRules: [{ serviceId: "a", suggestServiceId: "b" }] });
  assert.match(upsell, /`upsell_offer`.*`add_service_to_appointment`.*`decline_upsell`/s);
  assert.match(upsell, /paciente/, "usa la terminología del negocio");
});
