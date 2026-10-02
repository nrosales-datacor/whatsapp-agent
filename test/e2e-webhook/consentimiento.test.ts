import "../helpers/setupEnv"; // PRIMERO: fija OPENAI_API_KEY antes de importar handleWebhook
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { RepositorioEnMemoria } from "../../src/booking/inMemoryRepository";
import { responderEntrante, type Pendiente } from "../../src/handleWebhook";
import {
  _resetConsentimientoMemoriaParaTests,
  almacenConsentimiento,
  pedirConsentimientoMarketing,
} from "../../src/campaigns/consentimiento";
import type { Conversacion, Tenant } from "../../src/types";
import { crearTenant } from "../helpers/fixtures";
import { desactivarMockWebhook, instalarMockWebhook } from "../helpers/webhookMock";

// ─────────────────────────────────────────────────────────────────────────────
// Flujo de botones del consentimiento de marketing, IN-PROCESS (mismo arnés que
// webhook.test.ts: repo en memoria + Graph/OpenAI mockeados). Sin DATABASE_URL el
// consentimiento cae al almacén en memoria del proceso (se resetea por test).
// ─────────────────────────────────────────────────────────────────────────────

const CLIENTE = "50688886666";

function tenantPro(overrides: Partial<Tenant> = {}): Tenant {
  return crearTenant({ plan: "pro", accessToken: "test-token", linkResenas: "https://g.page/r/demo", ...overrides });
}

async function nuevaConv(repo: RepositorioEnMemoria, tenant: Tenant): Promise<Conversacion> {
  const c = await repo.obtenerOConversacion(tenant.id, CLIENTE);
  return (await repo.obtenerConversacionPorId(tenant.id, c.id))!;
}

function pendiente(tenant: Tenant, conv: Conversacion, texto: string, interactiveId?: string): Pendiente {
  return {
    clase: "texto",
    tenant,
    conv,
    primerContacto: false,
    historialPrevio: [],
    entrante: {
      phoneNumberId: tenant.phoneNumberId,
      clienteWa: CLIENTE,
      texto,
      esTexto: true,
      messageId: `wamid.${Math.random()}`,
      interactiveId,
    },
  };
}

beforeEach(() => _resetConsentimientoMemoriaParaTests());
afterEach(() => desactivarMockWebhook());

test("post-servicio positivo (Pro): tras la reseña, el bot ofrece UNA vez los botones Sí/No", async () => {
  const mock = instalarMockWebhook();
  const repo = new RepositorioEnMemoria();
  const tenant = tenantPro();
  const conv = await nuevaConv(repo, tenant);

  await responderEntrante(pendiente(tenant, conv, "Excelente 😃", "postexcelente|cita-1"), repo);

  assert.equal(mock.llamadasLLM(), 0);
  assert.equal(mock.enviados.length, 2, "reseña + pedido de consentimiento");
  assert.match(mock.enviados[0].texto ?? "", /reseña/i);
  assert.equal(mock.enviados[1].tipo, "interactive");
  const ids = mock.enviados[1].interactive.action.buttons.map((b: any) => b.reply.id);
  assert.deepEqual(ids, ["mktsi", "mktno"]);
  assert.match(mock.enviados[1].interactive.body.text, /BAJA/, "el pedido explica cómo darse de baja");
  assert.ok((await almacenConsentimiento().leer(tenant.id, CLIENTE)).pedidoEn, "queda registrado que se preguntó");

  // Segunda cita, otra respuesta positiva: ya no se vuelve a preguntar.
  const mock2 = instalarMockWebhook();
  await responderEntrante(pendiente(tenant, conv, "Excelente 😃", "postexcelente|cita-2"), repo);
  assert.equal(mock2.enviados.length, 1, "solo la reseña, sin re-preguntar");
});

test("post-servicio negativo o plan Básico: NO se pide consentimiento", async () => {
  const mock = instalarMockWebhook();
  const repo = new RepositorioEnMemoria();
  const tenant = tenantPro();
  const conv = await nuevaConv(repo, tenant);
  await responderEntrante(pendiente(tenant, conv, "Mal 😞", "postmal|cita-1"), repo);
  assert.ok(mock.enviados.every((e) => e.tipo !== "interactive"));

  const mock2 = instalarMockWebhook();
  const basico = crearTenant({ plan: "basico", accessToken: "test-token", id: "otro-tenant" });
  const conv2 = await nuevaConv(repo, basico);
  await responderEntrante(pendiente(basico, conv2, "Todo bien 👍", "postbien|cita-9"), repo);
  assert.equal(mock2.enviados.length, 1, "Básico no tiene campañas: no tiene sentido pedir permiso");
});

test('tocar "Sí, avísenme" registra el consentimiento (acción directa, sin agente)', async () => {
  const mock = instalarMockWebhook();
  const repo = new RepositorioEnMemoria();
  const tenant = tenantPro();
  const conv = await nuevaConv(repo, tenant);

  await responderEntrante(pendiente(tenant, conv, "Sí, quiero recibir promociones ✅", "mktsi"), repo);

  assert.equal(mock.llamadasLLM(), 0);
  assert.ok((await almacenConsentimiento().leer(tenant.id, CLIENTE)).consentimientoEn);
  assert.match(mock.enviados[0].texto ?? "", /BAJA/);
});

test('tocar "No, gracias" deja sin consentimiento; un "Sí" previo se revoca', async () => {
  const mock = instalarMockWebhook();
  const repo = new RepositorioEnMemoria();
  const tenant = tenantPro();
  const conv = await nuevaConv(repo, tenant);

  await responderEntrante(pendiente(tenant, conv, "Sí", "mktsi"), repo);
  await responderEntrante(pendiente(tenant, conv, "No", "mktno"), repo);

  assert.equal(mock.llamadasLLM(), 0);
  assert.equal((await almacenConsentimiento().leer(tenant.id, CLIENTE)).consentimientoEn, null);
  assert.match(mock.enviados[1].texto ?? "", /no te vamos a enviar promociones/i);
});

test('una baja escrita ("No me manden más") marca opt-out Y retira el consentimiento', async () => {
  const mock = instalarMockWebhook();
  const repo = new RepositorioEnMemoria();
  const tenant = tenantPro();
  const conv = await nuevaConv(repo, tenant);

  await responderEntrante(pendiente(tenant, conv, "Sí", "mktsi"), repo);
  await responderEntrante(pendiente(tenant, conv, "No me manden más!!"), repo);

  const fresca = await repo.obtenerConversacionPorId(tenant.id, conv.id);
  assert.ok(fresca?.optOutEn, "queda la baja");
  assert.equal((await almacenConsentimiento().leer(tenant.id, CLIENTE)).consentimientoEn, null);
  assert.equal(mock.llamadasLLM(), 0, "la baja no pasa por el agente");
  assert.match(mock.enviados[1].texto ?? "", /promociones/);
});

test('"quiero cancelar mi cita" NO es baja: pasa al agente', async () => {
  const mock = instalarMockWebhook();
  mock.programarLLM({ texto: "Claro, ¿cuál cita querés cancelar?" });
  const repo = new RepositorioEnMemoria();
  const tenant = tenantPro();
  const conv = await nuevaConv(repo, tenant);

  await responderEntrante(pendiente(tenant, conv, "quiero cancelar mi cita"), repo);

  const fresca = await repo.obtenerConversacionPorId(tenant.id, conv.id);
  assert.equal(fresca?.optOutEn ?? null, null);
  assert.equal(mock.llamadasLLM(), 1);
});

test("pedido manual del panel: respeta la baja y no re-pregunta antes de 30 días", async () => {
  const mock = instalarMockWebhook();
  const repo = new RepositorioEnMemoria();
  const tenant = tenantPro();
  let conv = await nuevaConv(repo, tenant);

  assert.equal(await pedirConsentimientoMarketing(tenant, repo, conv, { manual: true }), "enviado");
  assert.equal(mock.enviados.length, 1);
  assert.equal(await pedirConsentimientoMarketing(tenant, repo, conv, { manual: true }), "ya_preguntado");

  await repo.marcarOptOut(tenant.id, conv.id);
  conv = (await repo.obtenerConversacionPorId(tenant.id, conv.id))!;
  _resetConsentimientoMemoriaParaTests();
  assert.equal(await pedirConsentimientoMarketing(tenant, repo, conv, { manual: true }), "baja");
  assert.equal(mock.enviados.length, 1, "no se mandó nada más");
});
