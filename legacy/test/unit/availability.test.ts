import assert from "node:assert/strict";
import { test } from "node:test";
import { ahoraEnTz, espaciosDisponibles, espaciosPorEmpleado } from "../../src/booking/availability";
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

// ── Capacidad simultánea por empleado (ALTO-07) ──────────────────────────────
// Antes, cualquier solape bloqueaba el horario: un negocio con 2 personas atendiendo
// perdía la mitad de su capacidad. Ahora un horario sigue vivo mientras quede alguien
// libre, pero NUNCA se le puede duplicar el horario a una misma persona.

const EQUIPO = [
  { id: "ana", nombre: "Ana", activo: true },
  { id: "marco", nombre: "Marco", activo: true },
];

test("espaciosPorEmpleado: sin equipo cargado se comporta como un solo recurso (legacy)", () => {
  const tenant = crearTenant();
  const citas = [crearCita({ fecha: "2026-07-20", hora: "09:00" })];
  const espacios = espaciosPorEmpleado(tenant, "2026-07-20", "lavado-basico", citas, RELOJ);
  assert.ok(!espacios.some((e) => e.hora === "09:00"));
  // Sin equipo, `empleados` viene vacío: no hay a quién asignar.
  assert.deepEqual(espacios.find((e) => e.hora === "09:30")?.empleados, []);
});

test("dos citas a la misma hora con personas distintas: el horario sigue disponible", () => {
  const tenant = crearTenant({ empleados: EQUIPO });
  const citas = [crearCita({ id: "c1", fecha: "2026-07-20", hora: "09:00", empleadoId: "ana" })];
  const espacios = espaciosPorEmpleado(tenant, "2026-07-20", "lavado-basico", citas, RELOJ);
  const nueve = espacios.find((e) => e.hora === "09:00");
  // Ana está tomada, Marco no → el horario se sigue ofreciendo, pero solo con Marco.
  assert.deepEqual(nueve?.empleados, ["marco"]);
});

test("una misma persona NO puede tener dos citas a la misma hora", () => {
  const tenant = crearTenant({ empleados: EQUIPO });
  const citas = [crearCita({ id: "c1", fecha: "2026-07-20", hora: "09:00", empleadoId: "ana" })];
  const libresAna = espaciosDisponibles(tenant, "2026-07-20", "lavado-basico", citas, RELOJ, "ana");
  const libresMarco = espaciosDisponibles(tenant, "2026-07-20", "lavado-basico", citas, RELOJ, "marco");
  assert.ok(!libresAna.includes("09:00"), "Ana ya tiene cita a las 09:00");
  assert.ok(libresMarco.includes("09:00"), "Marco sigue libre a las 09:00");
});

test("el horario desaparece recién cuando TODO el equipo está ocupado", () => {
  const tenant = crearTenant({ empleados: EQUIPO });
  const citas = [
    crearCita({ id: "c1", fecha: "2026-07-20", hora: "09:00", empleadoId: "ana" }),
    crearCita({ id: "c2", fecha: "2026-07-20", hora: "09:00", empleadoId: "marco" }),
  ];
  const libres = espaciosDisponibles(tenant, "2026-07-20", "lavado-basico", citas, RELOJ);
  assert.ok(!libres.includes("09:00"));
  assert.ok(libres.includes("09:30"));
});

test("un solape parcial bloquea a esa persona en todos los espacios que cruza", () => {
  const tenant = crearTenant({ empleados: EQUIPO });
  // Pulido de 90 min de Ana a las 09:00 → ocupa 09:00-10:30.
  const citas = [crearCita({ id: "c1", fecha: "2026-07-20", hora: "09:00", servicioId: "pulido", empleadoId: "ana" })];
  const libresAna = espaciosDisponibles(tenant, "2026-07-20", "lavado-basico", citas, RELOJ, "ana");
  for (const h of ["09:00", "09:30", "10:00"]) assert.ok(!libresAna.includes(h), `Ana ocupada ${h}`);
  assert.ok(libresAna.includes("10:30"));
  // Marco no se ve afectado en ninguno.
  const libresMarco = espaciosDisponibles(tenant, "2026-07-20", "lavado-basico", citas, RELOJ, "marco");
  for (const h of ["09:00", "09:30", "10:00"]) assert.ok(libresMarco.includes(h), `Marco libre ${h}`);
});

test("solo se ofrece a quien sabe hacer ese servicio", () => {
  const tenant = crearTenant({
    empleados: [
      { id: "ana", nombre: "Ana", activo: true, serviciosIds: ["lavado-basico"] },
      { id: "marco", nombre: "Marco", activo: true }, // sin restricción = hace de todo
    ],
  });
  const pulido = espaciosPorEmpleado(tenant, "2026-07-20", "pulido", [], RELOJ);
  assert.deepEqual(pulido[0]?.empleados, ["marco"], "Ana no hace pulido");
  const lavado = espaciosPorEmpleado(tenant, "2026-07-20", "lavado-basico", [], RELOJ);
  assert.deepEqual(lavado[0]?.empleados, ["ana", "marco"]);
});

test("un empleado inactivo no recibe citas nuevas", () => {
  const tenant = crearTenant({
    empleados: [
      { id: "ana", nombre: "Ana", activo: true },
      { id: "marco", nombre: "Marco", activo: false },
    ],
  });
  const espacios = espaciosPorEmpleado(tenant, "2026-07-20", "lavado-basico", [], RELOJ);
  assert.deepEqual(espacios[0]?.empleados, ["ana"]);
});

test("los días libres de una persona no cierran la agenda del resto", () => {
  const tenant = crearTenant({
    empleados: [
      { id: "ana", nombre: "Ana", activo: true, bloqueos: [{ desde: "2026-07-20", hasta: "2026-07-24" }] },
      { id: "marco", nombre: "Marco", activo: true },
    ],
  });
  const espacios = espaciosPorEmpleado(tenant, "2026-07-20", "lavado-basico", [], RELOJ);
  assert.deepEqual(espacios[0]?.empleados, ["marco"], "Ana está de vacaciones");
  assert.ok(espacios.length > 0, "el negocio sigue abierto con Marco");
});

test("si nadie del equipo puede atender ese servicio, no hay disponibilidad", () => {
  const tenant = crearTenant({
    empleados: [{ id: "ana", nombre: "Ana", activo: true, serviciosIds: ["lavado-basico"] }],
  });
  assert.deepEqual(espaciosDisponibles(tenant, "2026-07-20", "pulido", [], RELOJ), []);
});

test("una cita sin asignar consume un cupo del equipo", () => {
  const tenant = crearTenant({ empleados: EQUIPO });
  // Walk-in anotado a mano sin elegir persona: ocupa a alguien, no sabemos a quién.
  const citas = [crearCita({ id: "c1", fecha: "2026-07-20", hora: "09:00", empleadoId: undefined })];
  const espacios = espaciosPorEmpleado(tenant, "2026-07-20", "lavado-basico", citas, RELOJ);
  // Quedan 2 elegibles - 1 sin asignar = 1 cupo: el horario sigue vivo.
  assert.ok(espacios.some((e) => e.hora === "09:00"));
  // Con dos sin asignar se agota la capacidad, aunque nadie figure "tomado".
  const dos = [...citas, crearCita({ id: "c2", fecha: "2026-07-20", hora: "09:00", empleadoId: undefined })];
  const espacios2 = espaciosPorEmpleado(tenant, "2026-07-20", "lavado-basico", dos, RELOJ);
  assert.ok(!espacios2.some((e) => e.hora === "09:00"));
});

test("el piso temporal y el cierre se siguen respetando con equipo cargado", () => {
  const tenant = crearTenant({ empleados: EQUIPO });
  const libres = espaciosDisponibles(tenant, "2026-07-20", "lavado-basico", [], LUNES_0924);
  assert.equal(libres[0], "10:00"); // 09:24 + 30 min de margen
  assert.equal(libres.at(-1), "16:30");
});

test("ahoraEnTz: fecha y hora salen en la zona del negocio, no del servidor", () => {
  // 20/07/2026 02:30 UTC son las 20:30 del DÍA ANTERIOR en Costa Rica (UTC-6): si la
  // fecha y la hora se calcularan por separado podrían quedar de días distintos.
  const r = ahoraEnTz("America/Costa_Rica", new Date("2026-07-20T02:30:00Z"));
  assert.equal(r.fecha, "2026-07-19");
  assert.equal(r.minutos, 20 * 60 + 30);
});
