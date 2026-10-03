import { test } from "node:test";
import assert from "node:assert/strict";
import { codigoMoneda, formatearMonto, simboloMoneda } from "../../src/config/moneda";
import * as panel from "../../web/src/lib/formato";

// ─────────────────────────────────────────────────────────────────────────────
// E11 — montos en la moneda del negocio (src/config/moneda.ts) y su copia gemela
// del panel (web/src/lib/formato.ts). Puros, sin red ni base.
// ─────────────────────────────────────────────────────────────────────────────

test("codigoMoneda: acepta código ISO (cualquier caja) o símbolo", () => {
  assert.equal(codigoMoneda("CRC"), "CRC");
  assert.equal(codigoMoneda("usd"), "USD");
  assert.equal(codigoMoneda("₡"), "CRC");
  assert.equal(codigoMoneda(" Q "), "GTQ");
  assert.equal(codigoMoneda("$"), "USD");
  assert.equal(codigoMoneda("Bs"), null);
  assert.equal(codigoMoneda(""), null);
});

test("colones (piloto): mismo formato que antes de E11, con símbolo o con código", () => {
  const antes = "₡" + (15000).toLocaleString("es-CR"); // lo que armaba el código viejo
  assert.equal(formatearMonto(15000, "₡"), antes);
  assert.equal(formatearMonto(15000, "CRC"), antes);
});

test("otras monedas: símbolo y separadores del país de la moneda", () => {
  assert.equal(formatearMonto(1500, "USD"), "$1,500");
  assert.equal(formatearMonto(12.5, "USD"), "$12.50", "con centavos: 2 decimales");
  assert.equal(formatearMonto(1500, "MXN"), "$1,500");
  assert.match(formatearMonto(250, "GTQ"), /^Q\s?250$/);
  assert.doesNotMatch(formatearMonto(1500, "USD"), /₡|USD/);
});

test("moneda no reconocida: cae al texto configurado + número", () => {
  assert.equal(formatearMonto(1500, "Bs"), `Bs${(1500).toLocaleString("es")}`);
  assert.equal(formatearMonto(Number.NaN, "USD"), "$0");
});

test("simboloMoneda: para prefijos de inputs", () => {
  assert.equal(simboloMoneda("CRC"), "₡");
  assert.equal(simboloMoneda("₡"), "₡");
  assert.equal(simboloMoneda("USD"), "$");
  assert.equal(simboloMoneda("Bs"), "Bs");
  assert.equal(simboloMoneda(""), "₡");
});

test("panel y backend formatean exactamente igual (copia gemela)", () => {
  for (const moneda of ["₡", "CRC", "USD", "usd", "$", "MXN", "GTQ", "Q", "EUR", "€", "COP", "PEN", "S/", "Bs", ""]) {
    for (const n of [0, 5, 1500, 15000, 12.5, 1234567]) {
      assert.equal(panel.monto(n, moneda), formatearMonto(n, moneda), `${moneda} ${n}`);
    }
    assert.equal(panel.simboloMoneda(moneda), simboloMoneda(moneda), moneda);
  }
  assert.equal(panel.monto(15000), formatearMonto(15000, "₡"), "sin moneda (backend viejo): colones");
});
