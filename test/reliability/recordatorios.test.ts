import { test } from "node:test";
import assert from "node:assert/strict";
import { crearDbEfimera } from "../helpers/pgliteDb";
import { RepositorioDrizzle } from "../../src/booking/drizzleRepository";
import type { TipoRecordatorio } from "../../src/types";

// ─────────────────────────────────────────────────────────────────────────────
// Ángulo 5 (TESTING.md) — claim atómico de recordatorios (B4) contra Postgres
// efímero (PGlite). El claim es un `UPDATE … SET col=now() WHERE col IS NULL
// RETURNING id`: aunque N instancias corran a la vez, solo UNA pasa la columna de
// NULL a timestamp; las demás obtienen 0 filas → no reenvían. Se prueba el SQL
// real (RepositorioDrizzle), no la copia en memoria.
//
// Nota de fidelidad: PGlite es de una sola conexión, así que las corridas
// "concurrentes" (Promise.all) se serializan. Eso no debilita el invariante que
// importa: la ATOMICIDAD del UPDATE de una fila la garantiza Postgres, y el CAS
// (segundo claim ve la columna ya seteada → 0 filas) se cumple igual en serie.
// La contención real de 2 backends corriendo en paralelo pertenece a un job de
// Postgres dedicado (ver ángulo 7).
// ─────────────────────────────────────────────────────────────────────────────

const TENANT = "tenant-rec";
const TIPOS: TipoRecordatorio[] = ["dia_antes", "mismo_dia", "post_servicio"];

async function crearCita(repo: RepositorioDrizzle, clienteWa: string) {
  return repo.crearCita({
    tenantId: TENANT,
    clienteWa,
    clienteNombre: "Cliente Rel",
    servicioId: "pulido_parabrisas",
    fecha: "2030-01-15",
    hora: "09:00",
  });
}

for (const tipo of TIPOS) {
  test(`claim de recordatorio '${tipo}': exactamente un ganador entre 8 intentos concurrentes`, async () => {
    const { db, cerrar } = await crearDbEfimera();
    try {
      const repo = new RepositorioDrizzle(db);
      const cita = await crearCita(repo, "50611111111");

      const resultados = await Promise.all(
        Array.from({ length: 8 }, () => repo.reclamarRecordatorio(cita.id, tipo)),
      );
      const ganadores = resultados.filter(Boolean).length;
      assert.equal(ganadores, 1, `solo un intento debe ganar el claim de '${tipo}'`);

      // Un claim posterior tampoco puede ganar (la columna ya no es NULL).
      assert.equal(await repo.reclamarRecordatorio(cita.id, tipo), false);
    } finally {
      await cerrar();
    }
  });
}

test("revertir el claim (envío falló) permite volver a reclamarlo", async () => {
  const { db, cerrar } = await crearDbEfimera();
  try {
    const repo = new RepositorioDrizzle(db);
    const cita = await crearCita(repo, "50622222222");

    assert.equal(await repo.reclamarRecordatorio(cita.id, "dia_antes"), true, "primer claim gana");
    assert.equal(await repo.reclamarRecordatorio(cita.id, "dia_antes"), false, "segundo claim pierde");

    await repo.revertirRecordatorio(cita.id, "dia_antes"); // el envío falló → se libera
    assert.equal(await repo.reclamarRecordatorio(cita.id, "dia_antes"), true, "tras revertir, se puede reintentar");
  } finally {
    await cerrar();
  }
});

test("el claim de una cita no bloquea el de otra (keyed por citaId)", async () => {
  const { db, cerrar } = await crearDbEfimera();
  try {
    const repo = new RepositorioDrizzle(db);
    const citaA = await crearCita(repo, "50633333333");
    const citaB = await crearCita(repo, "50644444444");

    const [a, b] = await Promise.all([
      repo.reclamarRecordatorio(citaA.id, "mismo_dia"),
      repo.reclamarRecordatorio(citaB.id, "mismo_dia"),
    ]);
    assert.equal(a, true, "cita A se reclama");
    assert.equal(b, true, "cita B se reclama independientemente");
  } finally {
    await cerrar();
  }
});

test("los tres tipos de recordatorio son independientes en la misma cita", async () => {
  const { db, cerrar } = await crearDbEfimera();
  try {
    const repo = new RepositorioDrizzle(db);
    const cita = await crearCita(repo, "50655555555");
    for (const tipo of TIPOS) {
      assert.equal(await repo.reclamarRecordatorio(cita.id, tipo), true, `${tipo} se puede reclamar`);
    }
    // Y cada uno solo una vez.
    for (const tipo of TIPOS) {
      assert.equal(await repo.reclamarRecordatorio(cita.id, tipo), false, `${tipo} ya no se re-reclama`);
    }
  } finally {
    await cerrar();
  }
});
