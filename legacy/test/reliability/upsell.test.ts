import { test } from "node:test";
import assert from "node:assert/strict";
import { crearDbEfimera } from "../helpers/pgliteDb";
import { RepositorioDrizzle } from "../../src/booking/drizzleRepository";

// ─────────────────────────────────────────────────────────────────────────────
// Upsell inteligente al agendar (Carril D, 1.2) contra Postgres efímero (PGlite) —
// mismo ángulo 5 (TESTING.md) que rescate.test.ts: se prueba el round-trip real de
// las columnas jsonb (wa_citas.addons, wa_conversaciones.upsells_rechazados) y la
// ventana de 60 días para no volver a ofrecer un add-on rechazado.
// ─────────────────────────────────────────────────────────────────────────────

const TENANT = "tenant-upsell";

test("agregarAddonACita: agrega el add-on y es idempotente (no lo duplica)", async () => {
  const { db, cerrar } = await crearDbEfimera();
  try {
    const repo = new RepositorioDrizzle(db);
    const cita = await repo.crearCita({
      tenantId: TENANT,
      clienteWa: "50688881111",
      clienteNombre: "Cliente Uno",
      servicioId: "lavado_pulido_sellador",
      fecha: "2026-08-01",
      hora: "09:00",
      precio: 20000,
    });
    assert.deepEqual(cita.addons, []);

    const a1 = await repo.agregarAddonACita(TENANT, cita.id, { servicioId: "pulido_focos", precio: 8000 });
    assert.deepEqual(a1?.addons, [{ servicioId: "pulido_focos", precio: 8000 }]);

    // Repetir el mismo add-on no lo duplica.
    const a2 = await repo.agregarAddonACita(TENANT, cita.id, { servicioId: "pulido_focos", precio: 8000 });
    assert.equal(a2?.addons?.length, 1);
  } finally {
    await cerrar();
  }
});

test("agregarAddonACita: tenant ajeno o cita inexistente devuelve null", async () => {
  const { db, cerrar } = await crearDbEfimera();
  try {
    const repo = new RepositorioDrizzle(db);
    const cita = await repo.crearCita({
      tenantId: TENANT,
      clienteWa: "50688882222",
      clienteNombre: "Cliente Dos",
      servicioId: "lavado_pulido_sellador",
      fecha: "2026-08-01",
      hora: "10:00",
    });
    assert.equal(await repo.agregarAddonACita("otro-tenant", cita.id, { servicioId: "x", precio: 1000 }), null);
    assert.equal(await repo.agregarAddonACita(TENANT, "no-existe", { servicioId: "x", precio: 1000 }), null);
  } finally {
    await cerrar();
  }
});

test("registrarRechazoAddon + fueRechazadoAddonRecientemente: respeta la ventana de 60 días", async () => {
  const { db, cerrar } = await crearDbEfimera();
  try {
    const repo = new RepositorioDrizzle(db);
    const clienteWa = "50688883333";
    await repo.obtenerOConversacion(TENANT, clienteWa); // crea la conversación primero

    // Sin ningún rechazo previo: no está bloqueado.
    assert.equal(await repo.fueRechazadoAddonRecientemente(TENANT, clienteWa, "pulido_focos", "2026-08-10"), false);

    await repo.registrarRechazoAddon(TENANT, clienteWa, "pulido_focos");

    // El mismo día del rechazo: sigue bloqueado.
    const hoyDelRechazo = new Date().toISOString().slice(0, 10);
    assert.equal(await repo.fueRechazadoAddonRecientemente(TENANT, clienteWa, "pulido_focos", hoyDelRechazo), true);

    // Muy en el futuro (más de 60 días): ya no bloquea.
    const lejos = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    assert.equal(await repo.fueRechazadoAddonRecientemente(TENANT, clienteWa, "pulido_focos", lejos), false);

    // Un add-on DISTINTO nunca fue rechazado: no bloquea.
    assert.equal(await repo.fueRechazadoAddonRecientemente(TENANT, clienteWa, "cera", hoyDelRechazo), false);
  } finally {
    await cerrar();
  }
});

test("fueRechazadoAddonRecientemente: cliente sin conversación (nunca escribió) no bloquea", async () => {
  const { db, cerrar } = await crearDbEfimera();
  try {
    const repo = new RepositorioDrizzle(db);
    assert.equal(await repo.fueRechazadoAddonRecientemente(TENANT, "50699990000", "x", "2026-08-10"), false);
  } finally {
    await cerrar();
  }
});
