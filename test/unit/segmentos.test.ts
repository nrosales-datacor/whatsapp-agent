import assert from "node:assert/strict";
import { test } from "node:test";
import { calcularSegmento } from "../../src/campaigns/segmentos";

const HOY = "2026-07-14";

test("calcularSegmento 'todos': incluye a todo el que escribió, tenga o no cita", () => {
  const citas = [{ clienteWa: "a", clienteNombre: "Ana", fecha: "2026-06-01", estado: "completada", servicioId: "lavado" }];
  const conversaciones = [
    { clienteWa: "a", optOutEn: null },
    { clienteWa: "b", optOutEn: null }, // nunca agendó
  ];
  const r = calcularSegmento(citas, conversaciones, { tipo: "todos" }, HOY);
  assert.equal(r.length, 2);
  const b = r.find((x) => x.clienteWa === "b");
  assert.equal(b?.nombre, "estimado cliente");
  assert.equal(b?.ultimaVisita, null);
});

test("calcularSegmento 'todos': excluye SIEMPRE a quien pidió baja (opt-out)", () => {
  const citas: any[] = [];
  const conversaciones = [
    { clienteWa: "a", optOutEn: "2026-07-01T00:00:00.000Z" },
    { clienteWa: "b", optOutEn: null },
  ];
  const r = calcularSegmento(citas, conversaciones, { tipo: "todos" }, HOY);
  assert.deepEqual(r.map((x) => x.clienteWa), ["b"]);
});

test("calcularSegmento 'inactivos': solo clientes cuya última visita fue hace >= N días", () => {
  const citas = [
    { clienteWa: "activo", clienteNombre: "Reciente", fecha: "2026-07-10", estado: "completada", servicioId: "lavado" },
    { clienteWa: "inactivo", clienteNombre: "Hace rato", fecha: "2026-05-01", estado: "completada", servicioId: "lavado" },
  ];
  const conversaciones = [
    { clienteWa: "activo", optOutEn: null },
    { clienteWa: "inactivo", optOutEn: null },
  ];
  const r = calcularSegmento(citas, conversaciones, { tipo: "inactivos", dias: 60 }, HOY);
  assert.deepEqual(r.map((x) => x.clienteWa), ["inactivo"]);
});

test("calcularSegmento 'inactivos': cita cancelada no cuenta como visita", () => {
  const citas = [{ clienteWa: "a", clienteNombre: "A", fecha: "2026-07-10", estado: "cancelada", servicioId: "lavado" }];
  const conversaciones = [{ clienteWa: "a", optOutEn: null }];
  // Sin visitas reales, "a" nunca calificó como inactivo (ultimaVisita null se excluye).
  const r = calcularSegmento(citas, conversaciones, { tipo: "inactivos", dias: 1 }, HOY);
  assert.deepEqual(r, []);
});

test("calcularSegmento 'servicio_antiguo': última cita COMPLETADA de ese servicio hace >= N meses", () => {
  const citas = [
    { clienteWa: "a", clienteNombre: "A", fecha: "2026-01-01", estado: "completada", servicioId: "pulido" },
    { clienteWa: "b", clienteNombre: "B", fecha: "2026-07-01", estado: "completada", servicioId: "pulido" },
    { clienteWa: "c", clienteNombre: "C", fecha: "2026-01-01", estado: "agendada", servicioId: "pulido" }, // no completada, no cuenta
  ];
  const conversaciones = [
    { clienteWa: "a", optOutEn: null },
    { clienteWa: "b", optOutEn: null },
    { clienteWa: "c", optOutEn: null },
  ];
  const r = calcularSegmento(citas, conversaciones, { tipo: "servicio_antiguo", servicioId: "pulido", meses: 6 }, HOY);
  assert.deepEqual(r.map((x) => x.clienteWa), ["a"]);
});

test("calcularSegmento 'servicio_antiguo': sin servicioId devuelve vacío", () => {
  const r = calcularSegmento([], [], { tipo: "servicio_antiguo" }, HOY);
  assert.deepEqual(r, []);
});

test("calcularSegmento: se queda con el nombre de la cita más reciente del cliente", () => {
  const citas = [
    { clienteWa: "a", clienteNombre: "Nombre Viejo", fecha: "2026-01-01", estado: "completada", servicioId: "lavado" },
    { clienteWa: "a", clienteNombre: "Nombre Nuevo", fecha: "2026-06-01", estado: "completada", servicioId: "lavado" },
  ];
  const conversaciones = [{ clienteWa: "a", optOutEn: null }];
  const r = calcularSegmento(citas, conversaciones, { tipo: "todos" }, HOY);
  assert.equal(r[0].nombre, "Nombre Nuevo");
});
