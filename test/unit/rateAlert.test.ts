import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { forgetAlert, _resetAlertsForTests, _setWebhookSenderForTests } from "../../src/platform/observability/alerts";
import { numberFromEnv, rateAlert, rateAlertCount, _resetRateAlertsForTests } from "../../src/platform/observability/rateAlert";
import {
  LLM_UNAVAILABLE_ALERT,
  trackAgentFailure,
  trackReplySendFailure,
  WHATSAPP_SEND_FAILING_ALERT,
} from "../../src/modules/whatsapp/alerts";
import { GraphError } from "../../src/modules/whatsapp/graph";

// ─────────────────────────────────────────────────────────────────────────────
// Alertas por tasa (src/platform/observability/rateAlert.ts) y sus usos en el turno de
// WhatsApp (src/modules/whatsapp/alerts.ts): umbral dentro de la ventana, cooldown,
// ventanas por (tipo, negocio), cuenta global y exclusión de los errores de token.
// El recorrido completo por el pipeline está en test/reliability/whatsappAlerts.test.ts.
// ─────────────────────────────────────────────────────────────────────────────

let sent: string[] = [];
const previousUrl = process.env.ALERTS_WEBHOOK_URL;

beforeEach(() => {
  _resetAlertsForTests();
  _resetRateAlertsForTests();
  sent = [];
  _setWebhookSenderForTests(async (_url, body) => {
    sent.push(body.text);
  });
  process.env.ALERTS_WEBHOOK_URL = "https://hooks.ejemplo.test/alertas";
});

afterEach(() => {
  _setWebhookSenderForTests(null);
  if (previousUrl === undefined) delete process.env.ALERTS_WEBHOOK_URL;
  else process.env.ALERTS_WEBHOOK_URL = previousUrl;
});

const MIN = 60_000;
const opts = (tenantId: string | null = "t1") => ({
  type: "demo_rate",
  tenantId,
  severity: "critical" as const,
  threshold: 3,
  windowMs: 10 * MIN,
  message: (n: number) => `${n} fallos`,
  cooldownMs: 30 * MIN,
});

test("rateAlert: debajo del umbral no alerta; al llegar, una sola alerta con la cuenta", () => {
  assert.equal(rateAlert(opts(), 0), false);
  assert.equal(rateAlert(opts(), 1), false);
  assert.equal(rateAlert(opts(), 2), true, "tercer evento en la ventana");
  assert.equal(sent.length, 1);
  assert.match(sent[0], /demo_rate · tenant t1: 3 fallos/);
  assert.equal(rateAlert(opts(), 3), false, "cooldown: no repite en cada evento");
  assert.equal(sent.length, 1);
});

test("rateAlert: los eventos viejos salen de la ventana", () => {
  rateAlert(opts(), 0);
  rateAlert(opts(), 1);
  assert.equal(rateAlert(opts(), 10 * MIN + 1), false, "los dos primeros ya vencieron");
  assert.equal(rateAlertCount("demo_rate", "t1", 10 * MIN, 10 * MIN + 1), 1);
});

test("rateAlert: ventanas separadas por negocio y global; forgetAlert deja re-alertar", () => {
  for (let i = 0; i < 2; i++) rateAlert(opts("t1"), i);
  for (let i = 0; i < 2; i++) rateAlert(opts("t2"), i);
  assert.equal(sent.length, 0, "2 + 2 no suman entre negocios");
  for (let i = 0; i < 3; i++) rateAlert(opts(null), i);
  assert.equal(sent.length, 1, "la global lleva su propia cuenta");
  assert.doesNotMatch(sent[0], /tenant/);
  rateAlert(opts("t1"), 5);
  assert.equal(sent.length, 2);
  forgetAlert("demo_rate", "t1");
  assert.equal(rateAlert(opts("t1"), 6), true, "olvidada: el próximo evento sobre el umbral vuelve a salir");
});

test("numberFromEnv: vacía o inválida → default; respeta el mínimo y acepta 0 si se permite", () => {
  const name = "ALERTS_TEST_NUMBER";
  delete process.env[name];
  assert.equal(numberFromEnv(name, 7), 7);
  process.env[name] = "abc";
  assert.equal(numberFromEnv(name, 7), 7);
  process.env[name] = "0";
  assert.equal(numberFromEnv(name, 7), 0);
  assert.equal(numberFromEnv(name, 7, 1), 7, "0 debajo del mínimo");
  process.env[name] = " 12 ";
  assert.equal(numberFromEnv(name, 7, 1), 12);
  delete process.env[name];
});

// ── Turno de WhatsApp ────────────────────────────────────────────────────────

test("llm_unavailable: 5 fallos del agente de un negocio en 10 min → UNA alerta critical", () => {
  const results = Array.from({ length: 8 }, (_, i) => trackAgentFailure("b-1", i * 1_000));
  assert.deepEqual(results, [false, false, false, false, true, false, false, false]);
  assert.equal(sent.length, 1);
  assert.match(sent[0], new RegExp(`🚨 .*${LLM_UNAVAILABLE_ALERT} · tenant b-1: 5 turnos del agente fallaron`));
});

test("llm_unavailable: 10 fallos repartidos entre negocios → alerta GLOBAL (ninguno solo llega a su umbral)", () => {
  for (let i = 0; i < 10; i++) trackAgentFailure(`b-${i % 5}`, i * 1_000); // 2 por negocio
  assert.equal(sent.length, 1);
  assert.match(sent[0], new RegExp(`${LLM_UNAVAILABLE_ALERT}: 10 turnos .* sumando todos los negocios`));
});

test("llm_unavailable: los umbrales salen del entorno", () => {
  process.env.ALERTS_LLM_FAILURES = "2";
  try {
    assert.equal(trackAgentFailure("b-1", 0), false);
    assert.equal(trackAgentFailure("b-1", 1), true);
  } finally {
    delete process.env.ALERTS_LLM_FAILURES;
  }
});

test("whatsapp_send_failing: cuentan los rechazos de Meta que NO son de token", () => {
  const blocked = new GraphError("Graph send (403): cuenta bloqueada", { status: 403, code: 368, transient: false });
  for (let i = 0; i < 4; i++) assert.equal(trackReplySendFailure("b-1", blocked, i), false);
  assert.equal(trackReplySendFailure("b-1", blocked, 4), true);
  assert.match(sent[0], new RegExp(`${WHATSAPP_SEND_FAILING_ALERT} · tenant b-1`));
});

test("whatsapp_send_failing: el token rechazado (401 / 190) no cuenta: ya tiene su alerta propia", () => {
  const token401 = new GraphError("Graph send (401)", { status: 401, transient: false });
  const code190 = new GraphError("Graph send (400)", { status: 400, code: 190, transient: false });
  const wrapped = new Error("envoltura", { cause: code190 });
  for (let i = 0; i < 10; i++) {
    assert.equal(trackReplySendFailure("b-1", [token401, code190, wrapped][i % 3], i), false);
  }
  assert.equal(sent.length, 0);
  assert.equal(rateAlertCount(WHATSAPP_SEND_FAILING_ALERT, "b-1", 10 * MIN, 10), 0);
});
