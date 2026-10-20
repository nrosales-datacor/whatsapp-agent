import "../helpers/setupEnv";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { detectarBucle, normalizarParaBucle, type EntranteReciente } from "../../src/red/limiteCliente";
import { calcularEstadoCuotasDelMes, calcularEstadoGastoLlm } from "../../src/observabilidad/cuotas";
import { topeGastoLlmUsd } from "../../src/billing/planes";
import { detalleVision } from "../../src/agent/runAgent";
import { crearTenant } from "../helpers/fixtures";

// ─────────────────────────────────────────────────────────────────────────────
// Techo de costo de OpenAI (revisión pre-venta 2026-10) — cálculos puros:
//   • detección de bucle bot-a-bot (sin falsos positivos con ráfagas humanas);
//   • tope mensual de gasto en USD por plan + override por tenant;
//   • nivel de detalle de las fotos que van a visión.
// La parte con Postgres (límite por cliente, aviso una sola vez entre réplicas,
// enforcement en responderEntrante) está en test/reliability/frenosCosto.test.ts.
// ─────────────────────────────────────────────────────────────────────────────

const ENV_TOCADAS = ["TOPE_GASTO_LLM_USD_MES_POR_TENANT", "OPENAI_VISION_DETALLE"];
afterEach(() => {
  for (const k of ENV_TOCADAS) delete process.env[k];
});

function entrantes(...textos: string[]): EntranteReciente[] {
  const base = Date.now();
  return textos.map((contenido, i) => ({ contenido, creadoEn: new Date(base + i * 1000) }));
}

// ── Bucle bot-a-bot ──

test("bucle: una ráfaga humana normal (2-3 mensajes distintos) NO es bucle", () => {
  assert.equal(detectarBucle(entrantes("hola", "quiero una cita", "para mañana en la tarde"), 5), null);
});

test("bucle: 3 'hola' seguidos (cliente impaciente) NO es bucle", () => {
  assert.equal(detectarBucle(entrantes("hola", "Hola", "hola!", "?"), 5), null);
});

test("bucle: la misma respuesta automática repetida 5 veces SÍ es bucle", () => {
  const auto = "Gracias por comunicarte con Ferretería X. En este momento no estamos disponibles.";
  const r = detectarBucle(entrantes(auto, auto, auto, auto, auto), 5);
  assert.ok(r);
  assert.equal(r.repeticiones, 5);
});

test("bucle: variaciones solo de números/tildes/mayúsculas cuentan como el mismo texto", () => {
  assert.equal(normalizarParaBucle("Ticket #1234 RECIBIDO, gracias"), normalizarParaBucle("ticket #98 recibido, grácias"));
  const r = detectarBucle(
    entrantes("Ticket #1 recibido", "Ticket #2 recibido", "Ticket #3 recibido", "Ticket #4 recibido", "Ticket #5 recibido"),
    5,
  );
  assert.ok(r, "un autorespondedor que numera sus mensajes también es bucle");
});

test("bucle: un álbum de 10 fotos o varias notas de voz NO es bucle (marcadores de multimedia)", () => {
  const fotos = entrantes(...Array.from({ length: 10 }, () => "[foto]"));
  const audios = entrantes(...Array.from({ length: 6 }, () => "[audio]"));
  assert.equal(detectarBucle([...fotos, ...audios], 5), null);
});

test("bucle: con la detección desactivada (0) nunca dispara", () => {
  const auto = "respuesta automática";
  assert.equal(detectarBucle(entrantes(auto, auto, auto, auto, auto, auto), 0), null);
});

// ── Tope mensual de gasto de LLM ──

test("gasto LLM: Básico y Pro tienen tope por defecto, Pro más alto", () => {
  const basico = topeGastoLlmUsd(crearTenant({ plan: "basico" }));
  const pro = topeGastoLlmUsd(crearTenant({ plan: "pro" }));
  assert.equal(basico, 15);
  assert.equal(pro, 40);
  assert.ok(pro! > basico!);
});

test("gasto LLM: por debajo, al 80% y al 100% del tope del plan", () => {
  const t = crearTenant({ plan: "basico" }); // USD 15
  const bajo = calcularEstadoGastoLlm(t, 3_000_000); // USD 3
  assert.equal(bajo.porcentaje, 20);
  assert.equal(bajo.alcanzo80, false);
  assert.equal(bajo.excedido, false);

  const aviso = calcularEstadoGastoLlm(t, 12_000_000); // USD 12 = 80%
  assert.equal(aviso.alcanzo80, true);
  assert.equal(aviso.excedido, false);

  const tope = calcularEstadoGastoLlm(t, 15_000_000); // USD 15 = 100%
  assert.equal(tope.gastoUsd, 15);
  assert.equal(tope.porcentaje, 100);
  assert.equal(tope.excedido, true);
});

test("gasto LLM: el Pro con USD 15 gastados NO está excedido (su tope es más alto)", () => {
  const e = calcularEstadoGastoLlm(crearTenant({ plan: "pro" }), 15_000_000);
  assert.equal(e.topeUsd, 40);
  assert.equal(e.excedido, false);
});

test("gasto LLM: override por tenant (env) sube el tope solo para ese tenant", () => {
  process.env.TOPE_GASTO_LLM_USD_MES_POR_TENANT = "otro=5, lavacar-especial=60";
  const especial = crearTenant({ id: "lavacar-especial", plan: "basico" });
  const comun = crearTenant({ id: "lavacar-comun", plan: "basico" });
  assert.equal(topeGastoLlmUsd(especial), 60);
  assert.equal(topeGastoLlmUsd(comun), 15, "un tenant sin override conserva el tope de su plan");
  assert.equal(calcularEstadoGastoLlm(especial, 20_000_000).excedido, false);
});

test("gasto LLM: override en 0 = sin tope; un override mal formado cae al tope del plan", () => {
  process.env.TOPE_GASTO_LLM_USD_MES_POR_TENANT = "sin-tope=0,roto=abc";
  const sinTope = calcularEstadoGastoLlm(crearTenant({ id: "sin-tope", plan: "basico" }), 999_000_000);
  assert.equal(sinTope.topeUsd, null);
  assert.equal(sinTope.excedido, false);
  assert.equal(topeGastoLlmUsd(crearTenant({ id: "roto", plan: "basico" })), 15);
});

test("gasto LLM: el estado combinado sale de UNA fila de uso (lo que expone GET /me)", () => {
  const t = crearTenant({ plan: "basico" });
  const e = calcularEstadoCuotasDelMes(t, {
    conversacionesIniciadas: 10,
    mensajesEntrantes: 0,
    mensajesSalientes: 0,
    plantillasMarketing: 0,
    plantillasUtilidad: 0,
    tokensEntrada: 0,
    tokensSalida: 0,
    costoEstimadoMillonesimos: 16_500_000,
  });
  assert.equal(e.conversaciones.excedido, false, "las conversaciones van bien…");
  assert.equal(e.gastoLlm.excedido, true, "…pero el gasto ya pasó el tope");
  assert.equal(e.gastoLlm.porcentaje, 110);
  // Sin actividad todavía este mes: todo en cero.
  const vacio = calcularEstadoCuotasDelMes(t, null);
  assert.equal(vacio.gastoLlm.gastoUsd, 0);
  assert.equal(vacio.gastoLlm.excedido, false);
});

// ── Visión ──

test("visión: las fotos van con detail 'low' por defecto; configurable por env", () => {
  assert.equal(detalleVision(), "low");
  process.env.OPENAI_VISION_DETALLE = "HIGH";
  assert.equal(detalleVision(), "high");
  process.env.OPENAI_VISION_DETALLE = "auto";
  assert.equal(detalleVision(), "auto");
  process.env.OPENAI_VISION_DETALLE = "cualquier-cosa";
  assert.equal(detalleVision(), "low", "un valor inválido cae al default barato");
});
