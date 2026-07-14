import assert from "node:assert/strict";
import { test } from "node:test";
import { calcularMetricas, formatDelta } from "../../src/panel/metricas";

test("formatDelta: sin período previo devuelve undefined (o +∞ si hubo actividad nueva)", () => {
  assert.equal(formatDelta(0, 0), undefined);
  assert.equal(formatDelta(5, 0), "+∞");
});

test("formatDelta: calcula porcentaje con signo", () => {
  assert.equal(formatDelta(12, 10), "+20%");
  assert.equal(formatDelta(8, 10), "-20%");
  assert.equal(formatDelta(10, 10), "+0%");
});

test("calcularMetricas: cuenta exacta de conteos con dataset armado a mano", () => {
  const citas = [
    { estado: "completada", precio: 5000, servicioId: "lavado", fecha: "2026-07-01", hora: "09:00", clienteWa: "a" },
    { estado: "completada", precio: 5000, servicioId: "lavado", fecha: "2026-07-02", hora: "09:00", clienteWa: "a" },
    { estado: "cancelada", precio: 5000, servicioId: "lavado", fecha: "2026-07-03", hora: "10:00", clienteWa: "b" },
    { estado: "no_show", precio: 25000, servicioId: "pulido", fecha: "2026-07-04", hora: "10:00", clienteWa: "c" },
    { estado: "agendada", precio: 25000, servicioId: "pulido", fecha: "2026-07-05", hora: "11:00", clienteWa: "d", origen: "manual" },
  ];

  const m = calcularMetricas(10, 3, 4, citas);

  // Activas = todo menos cancelada/no_show → completada x2 + agendada x1 = 3.
  assert.equal(m.totalCitas, 3);
  assert.equal(m.ingresosEstimados, 5000 + 5000 + 25000);
  assert.equal(m.conversionPct, 30); // 3/10

  // Resueltas = completada(2) + no_show(1) = 3; no-show = 1 → 33%.
  assert.equal(m.noShowPct, 33);

  // Bot vs manual sobre activas: cliente "d" es manual, el resto (a, a, sin no_show) son bot.
  assert.equal(m.citasBot, 2);
  assert.equal(m.citasManuales, 1);

  // Fidelización sobre TODA la historia (incluye cancelada/no_show): a=2 (recurrente), b=1, c=1, d=1.
  assert.equal(m.clientesRecurrentes, 1);
  assert.equal(m.clientesNuevos, 3);

  assert.equal(m.ahorroBotPct, 40); // 4/10
  assert.equal(m.enModoHumano, 3);
});

test("calcularMetricas: sin citas resueltas, noShowPct queda undefined", () => {
  const citas = [{ estado: "agendada", servicioId: "lavado", fecha: "2026-07-01", hora: "09:00", clienteWa: "a" }];
  const m = calcularMetricas(1, 0, 1, citas);
  assert.equal(m.noShowPct, undefined);
});

test("calcularMetricas: sin conversaciones, conversionPct y ahorroBotPct son 0 (no NaN)", () => {
  const m = calcularMetricas(0, 0, 0, []);
  assert.equal(m.conversionPct, 0);
  assert.equal(m.ahorroBotPct, 0);
  assert.equal(m.totalCitas, 0);
  assert.equal(m.ingresosEstimados, 0);
});

test("calcularMetricas: serviciosTop y citasPorDia respetan topes (6 y 14) y orden", () => {
  const citas = Array.from({ length: 20 }, (_, i) => ({
    estado: "completada" as const,
    servicioId: `s${i % 8}`, // 8 servicios distintos
    fecha: `2026-07-${String((i % 20) + 1).padStart(2, "0")}`,
    hora: "09:00",
    clienteWa: `cliente-${i}`,
  }));
  const m = calcularMetricas(20, 0, 0, citas);
  assert.ok(m.serviciosTop.length <= 6);
  assert.ok(m.citasPorDia.length <= 14);
  // citasPorDia debe venir ordenado ascendente por fecha.
  const fechas = m.citasPorDia.map((c) => c.fecha);
  assert.deepEqual(fechas, [...fechas].sort());
});
