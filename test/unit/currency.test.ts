import { test } from "node:test";
import assert from "node:assert/strict";
import { currencyCode, currencySymbol, formatAmount } from "../../src/platform/money/currency";
import * as panel from "../../web/src/lib/formato";

// ─────────────────────────────────────────────────────────────────────────────
// Montos en la moneda del negocio (src/platform/money/currency.ts) y su copia gemela del
// panel (web/src/lib/formato.ts). Puros, sin red ni base.
// ─────────────────────────────────────────────────────────────────────────────

test("currencyCode: acepta código ISO (cualquier caja) o símbolo", () => {
  assert.equal(currencyCode("CRC"), "CRC");
  assert.equal(currencyCode("usd"), "USD");
  assert.equal(currencyCode("₡"), "CRC");
  assert.equal(currencyCode(" Q "), "GTQ");
  assert.equal(currencyCode("$"), "USD");
  assert.equal(currencyCode("Bs"), null);
  assert.equal(currencyCode(""), null);
});

test("colones: mismo formato con símbolo o con código", () => {
  const expected = "₡" + (15000).toLocaleString("es-CR");
  assert.equal(formatAmount(15000, "₡"), expected);
  assert.equal(formatAmount(15000, "CRC"), expected);
});

test("otras monedas: símbolo y separadores del país de la moneda", () => {
  assert.equal(formatAmount(1500, "USD"), "$1,500");
  assert.equal(formatAmount(12.5, "USD"), "$12.50", "con centavos: 2 decimales");
  assert.equal(formatAmount(1500, "MXN"), "$1,500");
  assert.match(formatAmount(250, "GTQ"), /^Q\s?250$/);
  assert.doesNotMatch(formatAmount(1500, "USD"), /₡|USD/);
});

test("moneda no reconocida: cae al texto configurado + número", () => {
  assert.equal(formatAmount(1500, "Bs"), `Bs${(1500).toLocaleString("es")}`);
  assert.equal(formatAmount(Number.NaN, "USD"), "$0");
});

test("currencySymbol: para prefijos de inputs", () => {
  assert.equal(currencySymbol("CRC"), "₡");
  assert.equal(currencySymbol("₡"), "₡");
  assert.equal(currencySymbol("USD"), "$");
  assert.equal(currencySymbol("Bs"), "Bs");
  assert.equal(currencySymbol(""), "₡");
});

test("panel y backend formatean exactamente igual (copia gemela)", () => {
  for (const currency of ["₡", "CRC", "USD", "usd", "$", "MXN", "GTQ", "Q", "EUR", "€", "COP", "PEN", "S/", "Bs", ""]) {
    for (const n of [0, 5, 1500, 15000, 12.5, 1234567]) {
      assert.equal(panel.monto(n, currency), formatAmount(n, currency), `${currency} ${n}`);
    }
    assert.equal(panel.simboloMoneda(currency), currencySymbol(currency), currency);
  }
  assert.equal(panel.monto(15000), formatAmount(15000, "₡"), "sin moneda: colones");
});
