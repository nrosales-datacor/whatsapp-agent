import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { crearDbEfimera, type DbEfimera } from "../helpers/pgliteDb";
import { RepositorioDrizzle } from "../../src/booking/drizzleRepository";
import { HorarioOcupadoError, esChoqueDeEmpleado } from "../../src/booking/errores";
import { ejecutarTool } from "../../src/agent/runAgent";
import type { Repositorio, Tenant } from "../../src/types";
import { crearTenant } from "../helpers/fixtures";

// ─────────────────────────────────────────────────────────────────────────────
// Doble reserva (revisión pre-venta 2026-10). `agendar_cita` chequeaba la
// disponibilidad y DESPUÉS insertaba, en pasos separados; el índice único de
// wa_citas excluye `empleado_id IS NULL` (modo recurso único, el más común) y solo ve
// la hora exacta. Con el worker concurrente (E7) dos clientes distintos sí corren en
// paralelo, así que dos "sí, a las 9" simultáneos dejaban DOS citas en un negocio de
// un solo recurso. Ahora el repo re-chequea atómicamente con la escritura (advisory
// lock por tenant+fecha en Postgres) y lanza `HorarioOcupadoError`.
//
// Se corre contra Postgres real (PGlite): el mismo SQL y los mismos locks que producción.
// ─────────────────────────────────────────────────────────────────────────────

/** Un lunes futuro (el tenant de prueba abre lunes a sábado). */
function proximoLunes(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 7);
  while (d.getUTCDay() !== 1) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}
const LUNES = proximoLunes();

let base: DbEfimera;
before(async () => {
  base = await crearDbEfimera();
});
after(async () => {
  await base.cerrar();
});

async function agendar(tenant: Tenant, repo: Repositorio, clienteWa: string, args: Record<string, unknown>) {
  const salida = await ejecutarTool(
    "agendar_cita",
    { nombre: "Cliente", servicioId: "lavado-basico", fecha: LUNES, ...args },
    { tenant, repo, clienteWa },
    {},
  );
  return JSON.parse(salida);
}

const implementaciones: { nombre: string; crear: () => Repositorio }[] = [
  { nombre: "Drizzle (PGlite)", crear: () => new RepositorioDrizzle(base.db) },
];

for (const impl of implementaciones) {
  test(`[${impl.nombre}] dos clientes reservan el MISMO horario a la vez (recurso único) → una sola cita`, async () => {
    const tenant = crearTenant({ id: `t-unico-${impl.nombre}` });
    const repo = impl.crear();

    const [a, b] = await Promise.all([
      agendar(tenant, repo, "50611110001", { hora: "09:00" }),
      agendar(tenant, repo, "50611110002", { hora: "09:00" }),
    ]);

    assert.equal([a, b].filter((r) => r.ok === true).length, 1, "exactamente una reserva gana");
    const perdedora = a.ok ? b : a;
    assert.equal(perdedora.ok, false);
    assert.match(perdedora.motivo, /ocupar|disponible/, "la perdedora recibe un 'ya no está disponible', no un error");
    const citas = (await repo.citasPorFecha(tenant.id, LUNES)).filter((c) => c.estado === "agendada");
    assert.equal(citas.length, 1, "en la base queda UNA sola cita a esa hora");
  });

  test(`[${impl.nombre}] solape por duración: un pulido de 90 min a las 09:00 bloquea un lavado a las 10:00 reservado a la vez`, async () => {
    const tenant = crearTenant({ id: `t-solape-${impl.nombre}` });
    const repo = impl.crear();

    const [a, b] = await Promise.all([
      agendar(tenant, repo, "50622220001", { servicioId: "pulido", hora: "09:00" }),
      agendar(tenant, repo, "50622220002", { hora: "10:00" }),
    ]);
    assert.equal([a, b].filter((r) => r.ok === true).length, 1, "las dos se encimarían: solo una puede quedar");
    assert.equal((await repo.citasPorFecha(tenant.id, LUNES)).length, 1);
  });

  test(`[${impl.nombre}] reprogramar a un horario que otra reserva ocupó en paralelo → rechazado, no encimado`, async () => {
    const tenant = crearTenant({ id: `t-repro-${impl.nombre}` });
    const repo = impl.crear();
    const cliente = "50633330001";
    const previa = await agendar(tenant, repo, cliente, { hora: "08:00" });
    assert.equal(previa.ok, true);

    const [repro, nueva] = await Promise.all([
      ejecutarTool("reprogramar_cita", { fecha: LUNES, hora: "11:00" }, { tenant, repo, clienteWa: cliente }, {}).then(JSON.parse),
      agendar(tenant, repo, "50633330002", { hora: "11:00" }),
    ]);
    assert.equal([repro, nueva].filter((r) => r.ok === true).length, 1, "solo uno se queda con las 11:00");
    const aLas11 = (await repo.citasPorFecha(tenant.id, LUNES)).filter((c) => c.hora === "11:00" && c.estado === "agendada");
    assert.equal(aLas11.length, 1);
  });

  test(`[${impl.nombre}] sin 'verificar' (alta manual del panel) se sigue pudiendo encimar un walk-in`, async () => {
    const repo = impl.crear();
    const cita = {
      tenantId: `t-panel-${impl.nombre}`,
      clienteWa: "50644440001",
      clienteNombre: "Walk-in",
      servicioId: "lavado-basico",
      fecha: LUNES,
      hora: "09:00",
      origen: "manual" as const,
    };
    await repo.crearCita(cita);
    await repo.crearCita({ ...cita, clienteWa: "50644440002" });
    assert.equal((await repo.citasPorFecha(cita.tenantId, LUNES)).length, 2);

    // Con `verificar` que dice "ocupado", el repo NO inserta y lanza el error tipado,
    // que los callers ya traducen igual que el choque del índice único.
    await assert.rejects(
      () => repo.crearCita({ ...cita, clienteWa: "50644440003" }, () => false),
      (e) => e instanceof HorarioOcupadoError && esChoqueDeEmpleado(e),
    );
    assert.equal((await repo.citasPorFecha(cita.tenantId, LUNES)).length, 2);
  });
}
