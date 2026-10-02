import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  alertarPlataforma,
  olvidarAlerta,
  _configurarEnvioWebhookParaTests,
  _resetAlertasParaTests,
} from "../../src/observabilidad/alertas";
import {
  esErrorDeTokenInvalido,
  listarTokensInvalidos,
  registrarRespuestaGraph,
  _resetTokensInvalidosParaTests,
} from "../../src/whatsapp/estadoToken";

// ─────────────────────────────────────────────────────────────────────────────
// Canal de alertas a la plataforma (observabilidad/alertas.ts): deduplicación por
// (tipo, tenant) con cooldown, webhook genérico {text, content} y la detección de
// token de WhatsApp inválido (whatsapp/estadoToken.ts).
// ─────────────────────────────────────────────────────────────────────────────

let enviados: { url: string; text: string; content: string }[] = [];
const urlPrevia = process.env.ALERTAS_WEBHOOK_URL;

beforeEach(() => {
  _resetAlertasParaTests();
  _resetTokensInvalidosParaTests();
  enviados = [];
  _configurarEnvioWebhookParaTests(async (url, cuerpo) => {
    enviados.push({ url, ...cuerpo });
  });
  process.env.ALERTAS_WEBHOOK_URL = "https://hooks.ejemplo.test/alertas";
});

afterEach(() => {
  _configurarEnvioWebhookParaTests(null);
  if (urlPrevia === undefined) delete process.env.ALERTAS_WEBHOOK_URL;
  else process.env.ALERTAS_WEBHOOK_URL = urlPrevia;
});

const base = { tipo: "dlq_reciente" as const, severidad: "critica" as const, mensaje: "3 jobs en error" };

test("alertas: la primera ocurrencia sale por el webhook con {text, content}", () => {
  assert.equal(alertarPlataforma({ ...base, tenantId: "t1" }, 1_000), true);
  assert.equal(enviados.length, 1);
  assert.equal(enviados[0].url, "https://hooks.ejemplo.test/alertas");
  assert.match(enviados[0].text, /dlq_reciente/);
  assert.match(enviados[0].text, /tenant t1/);
  assert.equal(enviados[0].text, enviados[0].content, "Slack lee `text`, Discord lee `content`: mismo texto");
});

test("alertas: deduplica la misma (tipo, tenant) dentro del cooldown y vuelve a salir al vencer", () => {
  const cooldownMs = 60_000;
  assert.equal(alertarPlataforma({ ...base, tenantId: "t1", cooldownMs }, 0), true);
  assert.equal(alertarPlataforma({ ...base, tenantId: "t1", cooldownMs }, 30_000), false, "dentro del cooldown");
  assert.equal(alertarPlataforma({ ...base, tenantId: "t1", cooldownMs }, 59_999), false);
  assert.equal(alertarPlataforma({ ...base, tenantId: "t1", cooldownMs }, 60_000), true, "venció el cooldown");
  assert.equal(enviados.length, 2);
});

test("alertas: el cooldown es por (tipo, tenant) — otro tenant u otro tipo no quedan silenciados", () => {
  assert.equal(alertarPlataforma({ ...base, tenantId: "t1" }, 0), true);
  assert.equal(alertarPlataforma({ ...base, tenantId: "t2" }, 1), true, "otro tenant");
  assert.equal(alertarPlataforma({ ...base, tipo: "cuota_agotada", tenantId: "t1" }, 2), true, "otro tipo");
  assert.equal(alertarPlataforma({ ...base, tipo: "cola_atascada" }, 3), true, "global (sin tenant)");
  assert.equal(alertarPlataforma({ ...base, tipo: "cola_atascada" }, 4), false);
  assert.equal(enviados.length, 4);
});

test("alertas: olvidarAlerta permite re-alertar de inmediato (problema resuelto y recaída)", () => {
  assert.equal(alertarPlataforma({ ...base, tenantId: "t1" }, 0), true);
  olvidarAlerta("dlq_reciente", "t1");
  assert.equal(alertarPlataforma({ ...base, tenantId: "t1" }, 1), true);
});

test("alertas: sin ALERTAS_WEBHOOK_URL no intenta el POST (solo log/Sentry) y no lanza", () => {
  delete process.env.ALERTAS_WEBHOOK_URL;
  assert.equal(alertarPlataforma({ ...base, tenantId: "t1" }, 0), true);
  assert.equal(enviados.length, 0);
});

test("alertas: un webhook que falla no lanza ni rompe al llamador", async () => {
  _configurarEnvioWebhookParaTests(async () => {
    throw new Error("503 de Slack");
  });
  assert.doesNotThrow(() => alertarPlataforma({ ...base, tenantId: "t1" }, 0));
  await new Promise((r) => setImmediate(r)); // deja correr el catch del envío en segundo plano
});

// ── Token de WhatsApp inválido ──────────────────────────────────────────────

test("estadoToken: 401 o error Graph 190 cuentan como token inválido; otros errores no", () => {
  assert.equal(esErrorDeTokenInvalido(401, ""), true);
  assert.equal(esErrorDeTokenInvalido(400, JSON.stringify({ error: { code: 190, type: "OAuthException" } })), true);
  assert.equal(esErrorDeTokenInvalido(400, JSON.stringify({ error: { code: 131026 } })), false);
  assert.equal(esErrorDeTokenInvalido(500, "<html>"), false);
});

test("estadoToken: marca el tenant y alerta una sola vez por racha; un envío OK limpia la marca", () => {
  registrarRespuestaGraph("t-token", false, 401, JSON.stringify({ error: { code: 190 } }));
  registrarRespuestaGraph("t-token", false, 401, JSON.stringify({ error: { code: 190 } }));
  assert.equal(listarTokensInvalidos().length, 1);
  assert.equal(listarTokensInvalidos()[0].tenantId, "t-token");
  assert.equal(listarTokensInvalidos()[0].codigoGraph, 190);
  assert.equal(enviados.length, 1, "deduplicado: un solo aviso por la racha");
  assert.match(enviados[0].text, /token_whatsapp_invalido/);

  registrarRespuestaGraph("t-token", true, 200);
  assert.equal(listarTokensInvalidos().length, 0, "el token volvió a funcionar");

  registrarRespuestaGraph("t-token", false, 401);
  assert.equal(enviados.length, 2, "recaída tras recuperarse: avisa de inmediato, sin esperar el cooldown");
});

test("estadoToken: un error que no es de token no marca nada ni alerta", () => {
  registrarRespuestaGraph("t-otro", false, 400, JSON.stringify({ error: { code: 131047 } }));
  assert.equal(listarTokensInvalidos().length, 0);
  assert.equal(enviados.length, 0);
});
