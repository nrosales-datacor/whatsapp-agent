import assert from "node:assert/strict";
import { test } from "node:test";
import { calcularVentana, VENTANA_24H_MS } from "../../src/whatsapp/ventana";

function hace(ms: number): string {
  return new Date(Date.now() - ms).toISOString();
}

test("calcularVentana: sin mensajes, ventana cerrada y sin fecha", () => {
  const r = calcularVentana([]);
  assert.equal(r.ventanaAbierta, false);
  assert.equal(r.ventanaCierraEn, null);
});

test("calcularVentana: solo mensajes del bot/operador (sin entrante del cliente), cerrada", () => {
  const r = calcularVentana([
    { rol: "assistant", creadoEn: hace(60_000) },
    { rol: "assistant", creadoEn: hace(1_000) },
  ]);
  assert.equal(r.ventanaAbierta, false);
  assert.equal(r.ventanaCierraEn, null);
});

test("calcularVentana: último mensaje del cliente hace 1h, ventana abierta", () => {
  const r = calcularVentana([
    { rol: "user", creadoEn: hace(60 * 60 * 1000) },
    { rol: "assistant", creadoEn: hace(30 * 60 * 1000) },
  ]);
  assert.equal(r.ventanaAbierta, true);
  assert.ok(r.ventanaCierraEn);
  // Cierra ~23h después de ahora (24h desde el mensaje de hace 1h). Límite superior
  // inclusivo: si el test corre lo bastante rápido, `hace()` y este `Date.now()`
  // caen en el mismo milisegundo y el restante da EXACTAMENTE 23h (visto en CI).
  const restanteMs = new Date(r.ventanaCierraEn!).getTime() - Date.now();
  assert.ok(restanteMs > 22 * 60 * 60 * 1000 && restanteMs <= 23 * 60 * 60 * 1000);
});

test("calcularVentana: último mensaje del cliente hace 25h, ventana cerrada", () => {
  const r = calcularVentana([{ rol: "user", creadoEn: hace(25 * 60 * 60 * 1000) }]);
  assert.equal(r.ventanaAbierta, false);
  assert.ok(r.ventanaCierraEn);
  assert.ok(new Date(r.ventanaCierraEn!).getTime() < Date.now());
});

test("calcularVentana: usa el ÚLTIMO mensaje del cliente, no el primero", () => {
  const r = calcularVentana([
    { rol: "user", creadoEn: hace(25 * 60 * 60 * 1000) }, // fuera de ventana
    { rol: "assistant", creadoEn: hace(24 * 60 * 60 * 1000) },
    { rol: "user", creadoEn: hace(60 * 1000) }, // dentro de ventana
  ]);
  assert.equal(r.ventanaAbierta, true);
});

test("calcularVentana: un mensaje del cliente respondido después por un humano sigue contando desde el cliente", () => {
  const r = calcularVentana([
    { rol: "user", creadoEn: hace(2 * 60 * 60 * 1000) },
    { rol: "assistant", creadoEn: hace(1000) }, // el operador respondió recién, pero no abre ventana nueva
  ]);
  assert.equal(r.ventanaAbierta, true);
  const restanteMs = new Date(r.ventanaCierraEn!).getTime() - Date.now();
  assert.ok(restanteMs < VENTANA_24H_MS && restanteMs > 21 * 60 * 60 * 1000);
});
