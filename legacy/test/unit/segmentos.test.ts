import assert from "node:assert/strict";
import { test } from "node:test";
import { calcularSegmento, calcularSegmentoDetalle } from "../../src/campaigns/segmentos";

const HOY = "2026-07-14";
// Consentimiento explícito de marketing (botón "Sí"): sin esto nadie recibe campañas.
const SI = "2026-07-01T00:00:00.000Z";

test("calcularSegmento 'todos': incluye a todo el que escribió y dio consentimiento, tenga o no cita", () => {
  const citas = [{ clienteWa: "a", clienteNombre: "Ana", fecha: "2026-06-01", estado: "completada", servicioId: "lavado" }];
  const conversaciones = [
    { clienteWa: "a", optOutEn: null, marketingConsentimientoEn: SI },
    { clienteWa: "b", optOutEn: null, marketingConsentimientoEn: SI }, // nunca agendó
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
    { clienteWa: "a", optOutEn: "2026-07-01T00:00:00.000Z", marketingConsentimientoEn: SI },
    { clienteWa: "b", optOutEn: null, marketingConsentimientoEn: SI },
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
    { clienteWa: "activo", optOutEn: null, marketingConsentimientoEn: SI },
    { clienteWa: "inactivo", optOutEn: null, marketingConsentimientoEn: SI },
  ];
  const r = calcularSegmento(citas, conversaciones, { tipo: "inactivos", dias: 60 }, HOY);
  assert.deepEqual(r.map((x) => x.clienteWa), ["inactivo"]);
});

test("calcularSegmento 'inactivos': cita cancelada no cuenta como visita", () => {
  const citas = [{ clienteWa: "a", clienteNombre: "A", fecha: "2026-07-10", estado: "cancelada", servicioId: "lavado" }];
  const conversaciones = [{ clienteWa: "a", optOutEn: null, marketingConsentimientoEn: SI }];
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
    { clienteWa: "a", optOutEn: null, marketingConsentimientoEn: SI },
    { clienteWa: "b", optOutEn: null, marketingConsentimientoEn: SI },
    { clienteWa: "c", optOutEn: null, marketingConsentimientoEn: SI },
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
  const conversaciones = [{ clienteWa: "a", optOutEn: null, marketingConsentimientoEn: SI }];
  const r = calcularSegmento(citas, conversaciones, { tipo: "todos" }, HOY);
  assert.equal(r[0].nombre, "Nombre Nuevo");
});

// ── Consentimiento de marketing (filtro OBLIGATORIO en todos los segmentos) ──

test("consentimiento: 'todos' deja AFUERA a quien solo escribió (sin botón 'Sí')", () => {
  const conversaciones = [
    { clienteWa: "con", optOutEn: null, marketingConsentimientoEn: SI },
    { clienteWa: "sin", optOutEn: null, marketingConsentimientoEn: null }, // solo recibió el aviso de bot
  ];
  const d = calcularSegmentoDetalle([], conversaciones, { tipo: "todos" }, HOY);
  assert.deepEqual(d.destinatarios.map((x) => x.clienteWa), ["con"]);
  assert.equal(d.sinConsentimiento, 1);
  assert.equal(d.conBaja, 0);
});

test("consentimiento: también filtra 'inactivos' y 'servicio_antiguo'", () => {
  const citas = [
    { clienteWa: "con", clienteNombre: "Con", fecha: "2026-01-01", estado: "completada", servicioId: "pulido" },
    { clienteWa: "sin", clienteNombre: "Sin", fecha: "2026-01-01", estado: "completada", servicioId: "pulido" },
  ];
  const conversaciones = [
    { clienteWa: "con", optOutEn: null, marketingConsentimientoEn: SI },
    { clienteWa: "sin", optOutEn: null, marketingConsentimientoEn: null },
  ];
  const inactivos = calcularSegmentoDetalle(citas, conversaciones, { tipo: "inactivos", dias: 60 }, HOY);
  assert.deepEqual(inactivos.destinatarios.map((x) => x.clienteWa), ["con"]);
  assert.equal(inactivos.sinConsentimiento, 1);
  const antiguo = calcularSegmento(citas, conversaciones, { tipo: "servicio_antiguo", servicioId: "pulido", meses: 3 }, HOY);
  assert.deepEqual(antiguo.map((x) => x.clienteWa), ["con"]);
});

test("consentimiento: la baja gana aunque haya consentimiento (y se cuenta aparte)", () => {
  const conversaciones = [
    { clienteWa: "a", optOutEn: "2026-07-10T00:00:00.000Z", marketingConsentimientoEn: SI },
    { clienteWa: "b", optOutEn: "2026-07-10T00:00:00.000Z", marketingConsentimientoEn: null },
  ];
  const d = calcularSegmentoDetalle([], conversaciones, { tipo: "todos" }, HOY);
  assert.deepEqual(d.destinatarios, []);
  assert.equal(d.conBaja, 2);
  assert.equal(d.sinConsentimiento, 0);
});

test("consentimiento: un cliente con cita pero sin conversación con consentimiento no recibe", () => {
  const citas = [{ clienteWa: "x", clienteNombre: "X", fecha: "2026-01-01", estado: "completada", servicioId: "lavado" }];
  const d = calcularSegmentoDetalle(citas, [], { tipo: "inactivos", dias: 30 }, HOY);
  assert.deepEqual(d.destinatarios, []);
  assert.equal(d.sinConsentimiento, 1);
});
