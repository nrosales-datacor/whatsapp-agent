import { test } from "node:test";
import assert from "node:assert/strict";
import { crearDbEfimera } from "../helpers/pgliteDb";
import { RepositorioDrizzle } from "../../src/booking/drizzleRepository";
import { esChoqueDeEmpleado } from "../../src/booking/errores";

// ─────────────────────────────────────────────────────────────────────────────
// Ángulo 5 (TESTING.md) — el índice único `wa_citas_empleado_slot_uq` (ALTO-07)
// contra Postgres real (PGlite), con las migraciones de ./drizzle aplicadas igual
// que en el deploy.
//
// Es la RED DE ÚLTIMO RECURSO contra la doble reserva: `espaciosDisponibles` lee y
// decide fuera de la transacción, así que dos clientes que tocan el mismo horario en
// el mismo instante pasan los dos el chequeo de aplicación. Probarlo en memoria no
// serviría de nada — la garantía la da Postgres, no el TypeScript.
// ─────────────────────────────────────────────────────────────────────────────

const TENANT = "tenant-emp";
const FECHA = "2026-09-14";

function cita(extra: Record<string, unknown> = {}) {
  return {
    tenantId: TENANT,
    clienteWa: "50688887777",
    clienteNombre: "Cliente",
    servicioId: "lavado-basico",
    fecha: FECHA,
    hora: "09:00",
    ...extra,
  } as Parameters<RepositorioDrizzle["crearCita"]>[0];
}

test("dos citas a la misma hora con personas distintas: la base las acepta", async () => {
  const { db, cerrar } = await crearDbEfimera();
  try {
    const repo = new RepositorioDrizzle(db);
    await repo.crearCita(cita({ empleadoId: "ana" }));
    await repo.crearCita(cita({ empleadoId: "marco" }));
    assert.equal((await repo.citasPorFecha(TENANT, FECHA)).length, 2);
  } finally {
    await cerrar();
  }
});

test("la base RECHAZA dos citas de la misma persona en el mismo horario", async () => {
  const { db, cerrar } = await crearDbEfimera();
  try {
    const repo = new RepositorioDrizzle(db);
    await repo.crearCita(cita({ empleadoId: "ana" }));
    await assert.rejects(
      () => repo.crearCita(cita({ empleadoId: "ana", clienteWa: "50611112222" })),
      (e: unknown) => {
        // El caller lo traduce a "ese horario ya no está disponible", no a un 500.
        assert.ok(esChoqueDeEmpleado(e), `esChoqueDeEmpleado no reconoció: ${JSON.stringify(e)}`);
        return true;
      },
    );
    assert.equal((await repo.citasPorFecha(TENANT, FECHA)).length, 1);
  } finally {
    await cerrar();
  }
});

test("cancelar libera el horario de esa persona (el índice es parcial por estado)", async () => {
  const { db, cerrar } = await crearDbEfimera();
  try {
    const repo = new RepositorioDrizzle(db);
    const primera = await repo.crearCita(cita({ empleadoId: "ana" }));
    await repo.cancelarCita(TENANT, primera.id);
    // Sin el `WHERE estado = 'agendada'` del índice, esta inserción fallaría.
    const segunda = await repo.crearCita(cita({ empleadoId: "ana", clienteWa: "50611112222" }));
    assert.equal(segunda.empleadoId, "ana");
  } finally {
    await cerrar();
  }
});

test("varias citas SIN asignar a la misma hora siguen permitidas (comportamiento previo)", async () => {
  const { db, cerrar } = await crearDbEfimera();
  try {
    const repo = new RepositorioDrizzle(db);
    // El índice excluye empleado_id NULL a propósito: un negocio sin equipo cargado
    // (o el panel anotando walk-ins) tiene que poder encimar citas como siempre.
    await repo.crearCita(cita());
    await repo.crearCita(cita({ clienteWa: "50611112222" }));
    assert.equal((await repo.citasPorFecha(TENANT, FECHA)).length, 2);
  } finally {
    await cerrar();
  }
});

test("reasignar a alguien que ya está ocupado a esa hora también lo frena la base", async () => {
  const { db, cerrar } = await crearDbEfimera();
  try {
    const repo = new RepositorioDrizzle(db);
    await repo.crearCita(cita({ empleadoId: "ana" }));
    const deMarco = await repo.crearCita(cita({ empleadoId: "marco", clienteWa: "50611112222" }));
    await assert.rejects(
      () => repo.reasignarCita(TENANT, deMarco.id, "ana"),
      (e: unknown) => esChoqueDeEmpleado(e),
    );
  } finally {
    await cerrar();
  }
});

test("reasignar a null (sin asignar) siempre se puede", async () => {
  const { db, cerrar } = await crearDbEfimera();
  try {
    const repo = new RepositorioDrizzle(db);
    const c = await repo.crearCita(cita({ empleadoId: "ana" }));
    const suelta = await repo.reasignarCita(TENANT, c.id, null);
    assert.equal(suelta?.empleadoId, undefined);
  } finally {
    await cerrar();
  }
});

test("obtenerCitaPorId está scopeada por tenant", async () => {
  const { db, cerrar } = await crearDbEfimera();
  try {
    const repo = new RepositorioDrizzle(db);
    const c = await repo.crearCita(cita({ empleadoId: "ana" }));
    assert.equal((await repo.obtenerCitaPorId(TENANT, c.id))?.id, c.id);
    assert.equal(await repo.obtenerCitaPorId("otro-tenant", c.id), null);
  } finally {
    await cerrar();
  }
});
