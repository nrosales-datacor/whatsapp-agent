import "../helpers/setupEnv";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  botonesConsentimiento,
  decidirPedido,
  DIAS_ENTRE_PEDIDOS,
  esPedidoDeBaja,
  respuestaConsentimiento,
} from "../../src/campaigns/consentimiento";
import { crearTenant } from "../helpers/fixtures";

// ─────────────────────────────────────────────────────────────────────────────
// Baja normalizada + política del pedido de consentimiento de marketing
// (revisión pre-venta 2026-10). Puras, sin red ni base.
// ─────────────────────────────────────────────────────────────────────────────

const PEDIDOS_DE_BAJA = [
  "baja",
  "BAJA",
  "BAJA.",
  "Baja!!",
  "  baja  ",
  "¡Baja! 🙏",
  "baja por favor",
  "Hola, baja",
  "stop",
  "STOP",
  "Stop.",
  "cancelar suscripción",
  "Cancelar mi suscripcion",
  "quiero cancelar la suscripción",
  "darme de baja",
  "Quiero darme de baja",
  "denme de baja por favor",
  "no quiero más promociones",
  "No quiero mas promociones.",
  "no quiero recibir más mensajes",
  "ya no quiero más mensajes",
  "no deseo recibir publicidad",
  "no me manden más",
  "No me manden mas mensajes",
  "no me envíen más promociones gracias",
  "ya no me escriban más",
  "quiero dejar de recibir promociones",
  "unsubscribe",
];

const NO_SON_BAJA = [
  "quiero cancelar mi cita",
  "cancelar",
  "Cancelar la cita de mañana",
  "quiero darme de baja del estrés y lavar el carro",
  "¿Baja el precio si son dos carros?",
  "bajar el precio",
  "la luz de stop del carro no sirve",
  "stop de freno",
  "no quiero más cera, solo lavado",
  "no me manden más fotos, ya las vi",
  "no quiero",
  "no me manden la factura",
  "hola",
  "",
  "   ",
  "¿me pueden mandar más promociones? 😄",
];

for (const t of PEDIDOS_DE_BAJA) {
  test(`baja: "${t}" SÍ es pedido de baja`, () => {
    assert.equal(esPedidoDeBaja(t), true);
  });
}

for (const t of NO_SON_BAJA) {
  test(`baja: "${t}" NO es pedido de baja (sin falso positivo)`, () => {
    assert.equal(esPedidoDeBaja(t), false);
  });
}

test("baja: un mensaje largo que termina en 'baja' no dispara", () => {
  assert.equal(esPedidoDeBaja("les escribo para preguntar si el precio del lavado completo está en baja"), false);
});

// ── Protocolo de botones ──

test("botones: ids de Sí/No se decodifican; otros ids no", () => {
  const [si, no] = botonesConsentimiento();
  assert.equal(respuestaConsentimiento(si.id), "si");
  assert.equal(respuestaConsentimiento(no.id), "no");
  assert.equal(respuestaConsentimiento("postbien|cita-1"), null);
  assert.equal(respuestaConsentimiento(undefined), null);
  for (const b of botonesConsentimiento()) assert.ok(b.titulo.length <= 20, "título ≤20 chars (límite de Meta)");
});

// ── Política: cuándo se pregunta ──

const pro = crearTenant({ plan: "pro" });
const basico = crearTenant({ plan: "basico" });
const nada = { consentimientoEn: null, pedidoEn: null };

test("pedido: plan sin campañas → no se pregunta", () => {
  assert.equal(decidirPedido(basico, { optOutEn: null }, nada, false), "sin_plan");
  assert.equal(decidirPedido(basico, { optOutEn: null }, nada, true), "sin_plan");
});

test("pedido: cliente con baja → nunca se le pregunta (ni el bot ni el panel)", () => {
  const baja = { optOutEn: "2026-07-01T00:00:00.000Z" };
  assert.equal(decidirPedido(pro, baja, nada, false), "baja");
  assert.equal(decidirPedido(pro, baja, nada, true), "baja");
});

test("pedido: ya consintió → no se repregunta", () => {
  assert.equal(decidirPedido(pro, { optOutEn: null }, { consentimientoEn: new Date(), pedidoEn: new Date() }, true), "ya_consiente");
});

test("pedido: el bot pregunta UNA sola vez en la vida del cliente", () => {
  assert.equal(decidirPedido(pro, { optOutEn: null }, nada, false), null);
  const haceUnAnio = new Date(Date.now() - 365 * 86_400_000);
  assert.equal(decidirPedido(pro, { optOutEn: null }, { consentimientoEn: null, pedidoEn: haceUnAnio }, false), "ya_preguntado");
});

test("pedido: el panel puede re-preguntar solo pasados DIAS_ENTRE_PEDIDOS", () => {
  const ahora = new Date("2026-10-01T12:00:00Z");
  const reciente = new Date(ahora.getTime() - (DIAS_ENTRE_PEDIDOS - 1) * 86_400_000);
  const viejo = new Date(ahora.getTime() - (DIAS_ENTRE_PEDIDOS + 1) * 86_400_000);
  assert.equal(decidirPedido(pro, { optOutEn: null }, { consentimientoEn: null, pedidoEn: reciente }, true, ahora), "ya_preguntado");
  assert.equal(decidirPedido(pro, { optOutEn: null }, { consentimientoEn: null, pedidoEn: viejo }, true, ahora), null);
});
