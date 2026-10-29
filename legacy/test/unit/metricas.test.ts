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

test("calcularMetricas: rescate de cotizaciones (Carril D, 1.1) — cuenta enviados/recuperados/monto", () => {
  const cotizaciones = [
    { estado: "pendiente" }, // aún sin toque: no cuenta como "enviado"
    { estado: "toque1" }, // se le mandó un toque, sin cita todavía: enviado, no recuperado
    { estado: "recuperada", montoRecuperado: 15000 },
    { estado: "recuperada", montoRecuperado: 20000 },
    { estado: "agendada" }, // agendó ANTES de cualquier toque: el rescate no hizo nada
    { estado: "opt_out" },
  ];
  const m = calcularMetricas(10, 0, 10, [], cotizaciones);
  assert.equal(m.rescateEnviados, 3); // toque1 + 2 recuperadas
  assert.equal(m.rescateRecuperados, 2);
  assert.equal(m.rescateTasaPct, 67); // 2/3
  assert.equal(m.rescateMontoRecuperado, 35000);
});

test("calcularMetricas: upsell (Carril D, 1.2) — ticket promedio, monto extra y tasa de aceptación", () => {
  const citas = [
    { estado: "completada", precio: 20000, servicioId: "lavado", fecha: "2026-07-01", hora: "09:00", clienteWa: "a", addons: [{ servicioId: "focos", precio: 8000 }] },
    { estado: "completada", precio: 15000, servicioId: "pulido", fecha: "2026-07-02", hora: "10:00", clienteWa: "b" }, // sin add-on
    { estado: "cancelada", precio: 15000, servicioId: "pulido", fecha: "2026-07-03", hora: "10:00", clienteWa: "c", addons: [{ servicioId: "focos", precio: 8000 }] }, // cancelada: no cuenta
  ];
  // 2 rechazos de add-on registrados (tenant-wide) además de la 1 cita con add-on aceptado.
  const m = calcularMetricas(5, 0, 5, citas, [], 2);
  // Activas: la de 20000+8000 y la de 15000 (la cancelada queda fuera). Total = 43000/2 = 21500.
  assert.equal(m.ticketPromedio, 21500);
  assert.equal(m.upsellMontoExtra, 8000); // solo el add-on de la cita ACTIVA
  assert.equal(m.upsellTasaPct, 33); // 1 aceptado / (1 aceptado + 2 rechazados)
});

test("calcularMetricas: sin citas ni rechazos, upsell queda en cero/undefined sin NaN", () => {
  const m = calcularMetricas(0, 0, 0, []);
  assert.equal(m.ticketPromedio, 0);
  assert.equal(m.upsellMontoExtra, 0);
  assert.equal(m.upsellTasaPct, undefined);
});

test("calcularMetricas: sin cotizaciones (o repo que no las pasa), rescate queda en cero sin NaN", () => {
  const m = calcularMetricas(5, 0, 5, []);
  assert.equal(m.rescateEnviados, 0);
  assert.equal(m.rescateRecuperados, 0);
  assert.equal(m.rescateTasaPct, undefined);
  assert.equal(m.rescateMontoRecuperado, 0);
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

test("calcularMetricas: motor de reseñas (Carril D, 1.3) — cuenta solicitudes vs. no solicitadas", () => {
  const seguimientos = [
    { sentimiento: "positivo" }, // Excelente: recibió el link
    { sentimiento: "positivo" },
    { sentimiento: "neutral" }, // Bien: NO recibió el link
    { sentimiento: "negativo" }, // Mal: NO recibió el link
    { sentimiento: null }, // recién enviado, todavía sin responder: no cuenta para ninguno
  ];
  const m = calcularMetricas(10, 0, 10, [], [], 0, seguimientos);
  assert.equal(m.resenasSolicitadas, 2);
  assert.equal(m.resenasNoSolicitadas, 2);
});

test("calcularMetricas: sin seguimientos (o repo que no los pasa), el contador de reseñas queda en cero", () => {
  const m = calcularMetricas(5, 0, 5, []);
  assert.equal(m.resenasSolicitadas, 0);
  assert.equal(m.resenasNoSolicitadas, 0);
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
