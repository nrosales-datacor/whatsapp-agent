import assert from "node:assert/strict";
import { test } from "node:test";
import { calcularEstadoCuota } from "../../src/observabilidad/cuotas";
import { crearTenant } from "../helpers/fixtures";

// ─────────────────────────────────────────────────────────────────────────────
// F10 — cálculo puro del estado de cuota mensual (80% aviso / 100% enforcement /
// interruptor por tenant / plan sin tope). Es la MISMA función que arma el payload
// de GET /me y admin/tenants (router.ts) y la que usa handleWebhook.ts para
// decidir si el bot deja de llamar al LLM — probarla acá cubre ambos consumidores
// sin necesidad de levantar el router HTTP.
// ─────────────────────────────────────────────────────────────────────────────

test("plan básico bien por debajo del tope: sin aviso, sin excedido", () => {
  const tenant = crearTenant({ plan: "basico" });
  const cuota = calcularEstadoCuota(tenant, 10);
  assert.equal(cuota.tope, 500);
  assert.equal(cuota.usados, 10);
  assert.equal(cuota.alcanzo80, false);
  assert.equal(cuota.excedido, false);
});

test("plan básico al 80% del tope: aviso visible, todavía no excedido", () => {
  const tenant = crearTenant({ plan: "basico" });
  const cuota = calcularEstadoCuota(tenant, 400); // 400/500 = 80%
  assert.equal(cuota.porcentaje, 80);
  assert.equal(cuota.alcanzo80, true);
  assert.equal(cuota.excedido, false);
});

test("plan básico al 100% del tope: excedido (el bot debe dejar de llamar al LLM)", () => {
  const tenant = crearTenant({ plan: "basico" });
  const cuota = calcularEstadoCuota(tenant, 500);
  assert.equal(cuota.alcanzo80, true);
  assert.equal(cuota.excedido, true);
});

test("plan básico por encima del tope: sigue excedido (no se resetea hasta el próximo mes)", () => {
  const tenant = crearTenant({ plan: "basico" });
  const cuota = calcularEstadoCuota(tenant, 650);
  assert.equal(cuota.excedido, true);
  assert.ok((cuota.porcentaje ?? 0) > 100);
});

test("plan pro: sin tope (nunca excedido, sin importar el consumo)", () => {
  const tenant = crearTenant({ plan: "pro" });
  const cuota = calcularEstadoCuota(tenant, 999_999);
  assert.equal(cuota.tope, null);
  assert.equal(cuota.porcentaje, null);
  assert.equal(cuota.alcanzo80, false);
  assert.equal(cuota.excedido, false);
});

test("interruptor activado (contrato especial): un básico por encima del tope NO se ve afectado", () => {
  const tenant = crearTenant({ plan: "basico", topeConversacionesDesactivado: true });
  const cuota = calcularEstadoCuota(tenant, 10_000); // muy por encima del tope normal
  assert.equal(cuota.tope, null);
  assert.equal(cuota.excedido, false, "el interruptor debe anular el tope aunque el consumo lo supere ampliamente");
});
