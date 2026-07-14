import assert from "node:assert/strict";
import { test } from "node:test";
import { espaciosDisponibles } from "../../src/booking/availability";
import { crearCita, crearTenant } from "../helpers/fixtures";

test("espaciosDisponibles: devuelve todos los espacios cuando no hay citas", () => {
  const tenant = crearTenant();
  const libres = espaciosDisponibles(tenant, "2026-07-20", "lavado-basico", []);
  assert.equal(libres[0], "07:00");
  assert.equal(libres.at(-1), "16:30"); // último espacio de 30 min antes de cerrar a las 17:00
  assert.equal(libres.length, 20); // (17:00-07:00)*2
});

test("espaciosDisponibles: día cerrado (domingo) devuelve vacío", () => {
  const tenant = crearTenant();
  const libres = espaciosDisponibles(tenant, "2026-07-19", "lavado-basico", []);
  assert.deepEqual(libres, []);
});

test("espaciosDisponibles: servicio inexistente devuelve vacío", () => {
  const tenant = crearTenant();
  const libres = espaciosDisponibles(tenant, "2026-07-20", "no-existe", []);
  assert.deepEqual(libres, []);
});

test("espaciosDisponibles: choque con cita existente excluye el rango ocupado", () => {
  const tenant = crearTenant();
  const citas = [crearCita({ fecha: "2026-07-20", hora: "09:00", servicioId: "lavado-basico" })];
  const libres = espaciosDisponibles(tenant, "2026-07-20", "lavado-basico", citas);
  // La cita de 09:00-09:30 (30 min) bloquea exactamente ese slot.
  assert.ok(!libres.includes("09:00"));
  assert.ok(libres.includes("08:30"));
  assert.ok(libres.includes("09:30"));
});

test("espaciosDisponibles: cita cancelada NO bloquea el horario", () => {
  const tenant = crearTenant();
  const citas = [crearCita({ fecha: "2026-07-20", hora: "09:00", estado: "cancelada" })];
  const libres = espaciosDisponibles(tenant, "2026-07-20", "lavado-basico", citas);
  assert.ok(libres.includes("09:00"));
});

test("espaciosDisponibles: servicio más largo bloquea varios espacios de otro servicio", () => {
  const tenant = crearTenant();
  // Pulido de 90 min a las 09:00 ocupa 09:00-10:30 → bloquea 09:00, 09:30, 10:00.
  const citas = [crearCita({ fecha: "2026-07-20", hora: "09:00", servicioId: "pulido" })];
  const libres = espaciosDisponibles(tenant, "2026-07-20", "lavado-basico", citas);
  assert.ok(!libres.includes("09:00"));
  assert.ok(!libres.includes("09:30"));
  assert.ok(!libres.includes("10:00"));
  assert.ok(libres.includes("10:30"));
});

test("espaciosDisponibles: no ofrece un espacio que terminaría después del cierre", () => {
  const tenant = crearTenant();
  // Sábado cierra a las 13:00; el pulido dura 90 min → 12:00 sería el último válido (12:00-13:30 no cabe).
  const libres = espaciosDisponibles(tenant, "2026-07-25", "pulido", []); // sábado
  assert.ok(!libres.includes("12:00"));
  assert.ok(libres.includes("11:30"));
});

test("espaciosDisponibles: bloqueo puntual (feriado) cierra el día aunque el horario semanal lo tenga abierto", () => {
  const tenant = crearTenant({
    bloqueos: [{ desde: "2026-07-20", hasta: "2026-07-20", motivo: "Feriado" }],
  });
  const libres = espaciosDisponibles(tenant, "2026-07-20", "lavado-basico", []);
  assert.deepEqual(libres, []);
});

test("espaciosDisponibles: bloqueo de rango cubre fechas intermedias", () => {
  const tenant = crearTenant({
    bloqueos: [{ desde: "2026-07-18", hasta: "2026-07-22" }],
  });
  const libres = espaciosDisponibles(tenant, "2026-07-20", "lavado-basico", []);
  assert.deepEqual(libres, []);
});
