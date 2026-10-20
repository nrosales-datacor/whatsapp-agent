import { test } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { crearDbEfimera } from "../helpers/pgliteDb";
import { waSeguimientos, waSnapshotReputacion } from "../../src/db/schema";
import { RepositorioDrizzle } from "../../src/booking/drizzleRepository";

// ─────────────────────────────────────────────────────────────────────────────
// Motor de reseñas de Google completo (Carril D, Fase 1 - 1.3) contra Postgres
// efímero (PGlite) — mismo ángulo 5 (TESTING.md) que rescate.test.ts/upsell.test.ts:
// se prueba el SQL real (idempotencia por citaId, upsert del snapshot diario) y las
// transiciones del Repositorio, no una reimplementación en memoria.
// ─────────────────────────────────────────────────────────────────────────────

const TENANT_A = "tenant-resenas-a";
const TENANT_B = "tenant-resenas-b";

async function sembrarCita(repo: RepositorioDrizzle, tenantId: string) {
  return repo.crearCita({
    tenantId,
    clienteWa: "50688887777",
    clienteNombre: "Cliente Demo",
    servicioId: "pulido_sellador",
    fecha: "2026-08-01",
    hora: "09:00",
  });
}

test("crearSeguimiento: idempotente por citaId (el scheduler no duplica si reintenta)", async () => {
  const { db, cerrar } = await crearDbEfimera();
  try {
    const repo = new RepositorioDrizzle(db);
    const cita = await sembrarCita(repo, TENANT_A);

    await repo.crearSeguimiento(TENANT_A, cita.id);
    await repo.crearSeguimiento(TENANT_A, cita.id); // reintento: no debe lanzar ni duplicar

    const filas = await db.select().from(waSeguimientos).where(eq(waSeguimientos.citaId, cita.id));
    assert.equal(filas.length, 1);
    assert.equal(filas[0].sentimiento, null);
    assert.equal(filas[0].resenaSolicitada, false);
  } finally {
    await cerrar();
  }
});

test("registrarRespuestaSeguimiento: actualiza sentimiento/resenaSolicitada/respuestaTexto", async () => {
  const { db, cerrar } = await crearDbEfimera();
  try {
    const repo = new RepositorioDrizzle(db);
    const cita = await sembrarCita(repo, TENANT_A);
    await repo.crearSeguimiento(TENANT_A, cita.id);

    await repo.registrarRespuestaSeguimiento(TENANT_A, cita.id, "positivo", true, "Excelente el servicio 😃");

    const [fila] = await db.select().from(waSeguimientos).where(eq(waSeguimientos.citaId, cita.id));
    assert.equal(fila.sentimiento, "positivo");
    assert.equal(fila.resenaSolicitada, true);
    assert.equal(fila.respuestaTexto, "Excelente el servicio 😃");
  } finally {
    await cerrar();
  }
});

test("registrarRespuestaSeguimiento: no-op si no existe fila (tenant Básico, sin tracking)", async () => {
  const { db, cerrar } = await crearDbEfimera();
  try {
    const repo = new RepositorioDrizzle(db);
    // Nunca se llamó crearSeguimiento (simula el flujo legacy de 2 botones).
    await repo.registrarRespuestaSeguimiento(TENANT_A, "cita-inexistente", "positivo", true, "Todo bien 👍");
    // No lanza. Confirmamos que no se creó nada.
    const filas = await db.select().from(waSeguimientos);
    assert.equal(filas.length, 0);
  } finally {
    await cerrar();
  }
});

test("seguimientosDeTenant: no se cruza entre tenants", async () => {
  const { db, cerrar } = await crearDbEfimera();
  try {
    const repo = new RepositorioDrizzle(db);
    const citaA = await sembrarCita(repo, TENANT_A);
    const citaB = await sembrarCita(repo, TENANT_B);
    await repo.crearSeguimiento(TENANT_A, citaA.id);
    await repo.crearSeguimiento(TENANT_B, citaB.id);

    const deA = await repo.seguimientosDeTenant(TENANT_A);
    const deB = await repo.seguimientosDeTenant(TENANT_B);
    assert.equal(deA.length, 1);
    assert.equal(deB.length, 1);
    assert.equal(deA[0].citaId, citaA.id);
    assert.equal(deB[0].citaId, citaB.id);
  } finally {
    await cerrar();
  }
});

test("guardarSnapshotReputacion: upsert por (tenantId, fecha) — el job no duplica si corre 2 veces el mismo día", async () => {
  const { db, cerrar } = await crearDbEfimera();
  try {
    const repo = new RepositorioDrizzle(db);
    await repo.guardarSnapshotReputacion(TENANT_A, "2026-08-01", 4.3, 40);
    await repo.guardarSnapshotReputacion(TENANT_A, "2026-08-01", 4.4, 41); // mismo día: actualiza, no inserta

    const filas = await db.select().from(waSnapshotReputacion).where(eq(waSnapshotReputacion.tenantId, TENANT_A));
    assert.equal(filas.length, 1);
    assert.equal(filas[0].rating, 4.4);
    assert.equal(filas[0].totalResenas, 41);
  } finally {
    await cerrar();
  }
});

test("historicoReputacion: más reciente primero, respeta el límite, no se cruza entre tenants", async () => {
  const { db, cerrar } = await crearDbEfimera();
  try {
    const repo = new RepositorioDrizzle(db);
    await repo.guardarSnapshotReputacion(TENANT_A, "2026-08-01", 4.3, 40);
    await repo.guardarSnapshotReputacion(TENANT_A, "2026-08-02", 4.4, 42);
    await repo.guardarSnapshotReputacion(TENANT_A, "2026-08-03", 4.5, 45);
    await repo.guardarSnapshotReputacion(TENANT_B, "2026-08-03", 3.9, 10);

    const historico = await repo.historicoReputacion(TENANT_A, 2);
    assert.deepEqual(historico.map((h) => h.fecha), ["2026-08-03", "2026-08-02"]);
    assert.equal((await repo.historicoReputacion(TENANT_B, 10)).length, 1);
  } finally {
    await cerrar();
  }
});

test("metricas: expone reputacion (snapshot más reciente + histórico) solo cuando hay snapshots", async () => {
  const { db, cerrar } = await crearDbEfimera();
  try {
    const repo = new RepositorioDrizzle(db);
    const sinSnapshots = await repo.metricas(TENANT_A);
    assert.equal(sinSnapshots.reputacion, undefined);

    await repo.guardarSnapshotReputacion(TENANT_A, "2026-08-01", 4.3, 40);
    await repo.guardarSnapshotReputacion(TENANT_A, "2026-08-02", 4.5, 45);

    const m = await repo.metricas(TENANT_A);
    assert.ok(m.reputacion);
    assert.equal(m.reputacion?.rating, 4.5);
    assert.equal(m.reputacion?.totalResenas, 45);
    // El histórico expuesto va en orden cronológico (más viejo primero) para graficar.
    assert.deepEqual(m.reputacion?.historico.map((h) => h.fecha), ["2026-08-01", "2026-08-02"]);
  } finally {
    await cerrar();
  }
});
