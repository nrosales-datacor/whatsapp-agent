import assert from "node:assert/strict";
import { test } from "node:test";
import { ahoraEnTz, espaciosDisponibles } from "../../src/booking/availability";
import { crearCita, crearTenant } from "../helpers/fixtures";

// Reloj fijo para los casos que no prueban el piso temporal: 19/07/2026 a las 06:00 en
// Costa Rica (UTC-6), o sea el día ANTERIOR a las fechas que usan. Sin esto los tests
// dependerían de la fecha real en que se corren: desde que `espaciosDisponibles`
// descarta el pasado (auditoría BLOQ-09), fechas fijas de 2026-07 dejan de ofrecer
// nada en cuanto el calendario las pasa.
const RELOJ = new Date("2026-07-19T12:00:00Z");

test("espaciosDisponibles: devuelve todos los espacios cuando no hay citas", () => {
  const tenant = crearTenant();
  const libres = espaciosDisponibles(tenant, "2026-07-20", "lavado-basico", [], RELOJ);
  assert.equal(libres[0], "07:00");
  assert.equal(libres.at(-1), "16:30"); // último espacio de 30 min antes de cerrar a las 17:00
  assert.equal(libres.length, 20); // (17:00-07:00)*2
});

test("espaciosDisponibles: día cerrado (domingo) devuelve vacío", () => {
  const tenant = crearTenant();
  const libres = espaciosDisponibles(tenant, "2026-07-19", "lavado-basico", [], RELOJ);
  assert.deepEqual(libres, []);
});

test("espaciosDisponibles: servicio inexistente devuelve vacío", () => {
  const tenant = crearTenant();
  const libres = espaciosDisponibles(tenant, "2026-07-20", "no-existe", [], RELOJ);
  assert.deepEqual(libres, []);
});

test("espaciosDisponibles: choque con cita existente excluye el rango ocupado", () => {
  const tenant = crearTenant();
  const citas = [crearCita({ fecha: "2026-07-20", hora: "09:00", servicioId: "lavado-basico" })];
  const libres = espaciosDisponibles(tenant, "2026-07-20", "lavado-basico", citas, RELOJ);
  // La cita de 09:00-09:30 (30 min) bloquea exactamente ese slot.
  assert.ok(!libres.includes("09:00"));
  assert.ok(libres.includes("08:30"));
  assert.ok(libres.includes("09:30"));
});

test("espaciosDisponibles: cita cancelada NO bloquea el horario", () => {
  const tenant = crearTenant();
  const citas = [crearCita({ fecha: "2026-07-20", hora: "09:00", estado: "cancelada" })];
  const libres = espaciosDisponibles(tenant, "2026-07-20", "lavado-basico", citas, RELOJ);
  assert.ok(libres.includes("09:00"));
});

test("espaciosDisponibles: servicio más largo bloquea varios espacios de otro servicio", () => {
  const tenant = crearTenant();
  // Pulido de 90 min a las 09:00 ocupa 09:00-10:30 → bloquea 09:00, 09:30, 10:00.
  const citas = [crearCita({ fecha: "2026-07-20", hora: "09:00", servicioId: "pulido" })];
  const libres = espaciosDisponibles(tenant, "2026-07-20", "lavado-basico", citas, RELOJ);
  assert.ok(!libres.includes("09:00"));
  assert.ok(!libres.includes("09:30"));
  assert.ok(!libres.includes("10:00"));
  assert.ok(libres.includes("10:30"));
});

test("espaciosDisponibles: no ofrece un espacio que terminaría después del cierre", () => {
  const tenant = crearTenant();
  // Sábado cierra a las 13:00; el pulido dura 90 min → 12:00 sería el último válido (12:00-13:30 no cabe).
  const libres = espaciosDisponibles(tenant, "2026-07-25", "pulido", [], RELOJ); // sábado
  assert.ok(!libres.includes("12:00"));
  assert.ok(libres.includes("11:30"));
});

test("espaciosDisponibles: bloqueo puntual (feriado) cierra el día aunque el horario semanal lo tenga abierto", () => {
  const tenant = crearTenant({
    bloqueos: [{ desde: "2026-07-20", hasta: "2026-07-20", motivo: "Feriado" }],
  });
  const libres = espaciosDisponibles(tenant, "2026-07-20", "lavado-basico", [], RELOJ);
  assert.deepEqual(libres, []);
});

test("espaciosDisponibles: bloqueo de rango cubre fechas intermedias", () => {
  const tenant = crearTenant({
    bloqueos: [{ desde: "2026-07-18", hasta: "2026-07-22" }],
  });
  const libres = espaciosDisponibles(tenant, "2026-07-20", "lavado-basico", [], RELOJ);
  assert.deepEqual(libres, []);
});

// ── Piso temporal: no ofrecer el pasado (auditoría BLOQ-09) ──────────────────
// Reproduce exactamente el caso verificado el 2026-07-27 con
// scripts/simulacion/simular.ts: a las 09:24 el bot ofrecía 08:00, 08:30 y 09:00, y al
// tocar "8:00 a.m." la cita se creaba de verdad, hora y veinte en el pasado.

/** Lunes 20/07/2026, 09:24 en Costa Rica (UTC-6). */
const LUNES_0924 = new Date("2026-07-20T15:24:00Z");

test("espaciosDisponibles: para HOY no ofrece horas ya transcurridas", () => {
  const tenant = crearTenant();
  const libres = espaciosDisponibles(tenant, "2026-07-20", "lavado-basico", [], LUNES_0924);
  assert.ok(!libres.includes("08:00"));
  assert.ok(!libres.includes("08:30"));
  assert.ok(!libres.includes("09:00"));
  // 09:24 + 30 min de margen = 09:54 → el primero válido es 10:00.
  assert.equal(libres[0], "10:00");
  assert.equal(libres.at(-1), "16:30"); // el cierre sigue respetándose igual
});

test("espaciosDisponibles: una fecha ya pasada no ofrece nada", () => {
  const tenant = crearTenant();
  const libres = espaciosDisponibles(tenant, "2026-07-17", "lavado-basico", [], LUNES_0924);
  assert.deepEqual(libres, []);
});

test("espaciosDisponibles: el piso solo aplica a HOY, no a los días siguientes", () => {
  const tenant = crearTenant();
  // Martes 21: aunque "ahora" sean las 09:24 del lunes, mañana se ofrece desde la apertura.
  const libres = espaciosDisponibles(tenant, "2026-07-21", "lavado-basico", [], LUNES_0924);
  assert.equal(libres[0], "07:00");
});

test("espaciosDisponibles: el margen de reserva es configurable por .env", () => {
  const tenant = crearTenant();
  const previo = process.env.AGENDA_MARGEN_MINIMO_MIN;
  try {
    // Sin margen, a las 09:24 el primer horario válido pasa a ser 09:30.
    process.env.AGENDA_MARGEN_MINIMO_MIN = "0";
    assert.equal(espaciosDisponibles(tenant, "2026-07-20", "lavado-basico", [], LUNES_0924)[0], "09:30");
    // Con 2 horas de margen (11:24), el primero es 11:30.
    process.env.AGENDA_MARGEN_MINIMO_MIN = "120";
    assert.equal(espaciosDisponibles(tenant, "2026-07-20", "lavado-basico", [], LUNES_0924)[0], "11:30");
  } finally {
    if (previo === undefined) delete process.env.AGENDA_MARGEN_MINIMO_MIN;
    else process.env.AGENDA_MARGEN_MINIMO_MIN = previo;
  }
});

test("ahoraEnTz: fecha y hora salen en la zona del negocio, no del servidor", () => {
  // 20/07/2026 02:30 UTC son las 20:30 del DÍA ANTERIOR en Costa Rica (UTC-6): si la
  // fecha y la hora se calcularan por separado podrían quedar de días distintos.
  const r = ahoraEnTz("America/Costa_Rica", new Date("2026-07-20T02:30:00Z"));
  assert.equal(r.fecha, "2026-07-19");
  assert.equal(r.minutos, 20 * 60 + 30);
});
