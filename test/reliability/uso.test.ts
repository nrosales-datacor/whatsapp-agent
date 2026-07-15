import { test } from "node:test";
import assert from "node:assert/strict";
import { and, eq } from "drizzle-orm";
import { crearDbEfimera } from "../helpers/pgliteDb";
import { waUsoMensual } from "../../src/db/schema";
import { incrementarUso } from "../../src/observabilidad/uso";

// ─────────────────────────────────────────────────────────────────────────────
// Ángulo 5 (TESTING.md) — contadores de uso mensual por tenant (Carril D, 0.2)
// contra Postgres efímero (PGlite): se prueba el UPSERT atómico real
// (INSERT ... ON CONFLICT DO UPDATE SET x = x + n), no una reimplementación en
// memoria — igual que las colas (B1/campañas) y el claim de recordatorios (B4).
// ─────────────────────────────────────────────────────────────────────────────

const TENANT = "tenant-uso";
const MES = "2026-07";

type Db = Awaited<ReturnType<typeof crearDbEfimera>>["db"];

async function leerFila(db: Db) {
  const [fila] = await db
    .select()
    .from(waUsoMensual)
    .where(and(eq(waUsoMensual.tenantId, TENANT), eq(waUsoMensual.anioMes, MES)));
  return fila ?? null;
}

test("primer incremento crea la fila del mes; incrementos siguientes suman sin pisar los otros contadores", async () => {
  const { db, cerrar } = await crearDbEfimera();
  try {
    await incrementarUso(db, TENANT, MES, { mensajesEntrantes: 1, conversacionesIniciadas: 1 });
    let fila = await leerFila(db);
    assert.equal(fila?.mensajesEntrantes, 1);
    assert.equal(fila?.conversacionesIniciadas, 1);
    assert.equal(fila?.mensajesSalientes, 0);

    await incrementarUso(db, TENANT, MES, { mensajesEntrantes: 1 }); // NO reinicia conversacionesIniciadas
    await incrementarUso(db, TENANT, MES, { mensajesSalientes: 1, plantillasMarketing: 1 });

    fila = await leerFila(db);
    assert.equal(fila?.mensajesEntrantes, 2);
    assert.equal(fila?.conversacionesIniciadas, 1);
    assert.equal(fila?.mensajesSalientes, 1);
    assert.equal(fila?.plantillasMarketing, 1);
    assert.equal(fila?.plantillasUtilidad, 0);
  } finally {
    await cerrar();
  }
});

test("dos meses del mismo tenant son contadores independientes", async () => {
  const { db, cerrar } = await crearDbEfimera();
  try {
    await incrementarUso(db, TENANT, "2026-06", { mensajesEntrantes: 5 });
    await incrementarUso(db, TENANT, MES, { mensajesEntrantes: 1 });

    const filaJunio = await db
      .select()
      .from(waUsoMensual)
      .where(and(eq(waUsoMensual.tenantId, TENANT), eq(waUsoMensual.anioMes, "2026-06")));
    const filaJulio = await leerFila(db);
    assert.equal(filaJunio[0]?.mensajesEntrantes, 5);
    assert.equal(filaJulio?.mensajesEntrantes, 1);
  } finally {
    await cerrar();
  }
});

test("incrementos concurrentes (misma fila) no se pisan: la suma final es exacta", async () => {
  const { db, cerrar } = await crearDbEfimera();
  try {
    const N = 20;
    await Promise.all(
      Array.from({ length: N }, () => incrementarUso(db, TENANT, MES, { mensajesEntrantes: 1 })),
    );
    const fila = await leerFila(db);
    assert.equal(fila?.mensajesEntrantes, N, "ninguna escritura concurrente se perdió");
  } finally {
    await cerrar();
  }
});
