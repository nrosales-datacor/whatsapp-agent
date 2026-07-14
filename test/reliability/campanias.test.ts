import { test } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { crearDbEfimera } from "../helpers/pgliteDb";
import { waCampanias, waCampaniaEnvios } from "../../src/db/schema";
import { marcarEnviado, quedanPendientes, reclamarEnvio } from "../../src/campaigns/cola";
import { elegirEsperaMs } from "../../src/campaigns/worker";
import type { EstadoCampania } from "../../src/types";

// ─────────────────────────────────────────────────────────────────────────────
// Ángulo 5 (TESTING.md) — mini-cola de envíos de campaña (C3.2) contra Postgres
// efímero (PGlite). Mismo patrón de claim que wa_jobs, con el candado extra de
// que la CAMPAÑA padre siga 'enviando'. Se prueba el SQL real.
// ─────────────────────────────────────────────────────────────────────────────

const TENANT = "tenant-camp";
type Db = Awaited<ReturnType<typeof crearDbEfimera>>["db"];

async function crearCampania(db: Db, estado: EstadoCampania): Promise<string> {
  const [c] = await db
    .insert(waCampanias)
    .values({
      tenantId: TENANT,
      nombre: "Promo lluvia",
      mensaje: "20% en pulido este mes",
      segmentoTipo: "todos",
      segmentoParametros: { tipo: "todos" },
      estado,
    })
    .returning({ id: waCampanias.id });
  return c.id;
}

async function sembrarEnvios(db: Db, campaniaId: string, n: number): Promise<void> {
  await db.insert(waCampaniaEnvios).values(
    Array.from({ length: n }, (_, i) => ({
      campaniaId,
      tenantId: TENANT,
      clienteWa: `5067000000${i}`,
      clienteNombre: `Cliente ${i}`,
    })),
  );
}

test("cada envío se reclama una sola vez: sin duplicados aunque se drene toda la cola", async () => {
  const { db, cerrar } = await crearDbEfimera();
  try {
    const campaniaId = await crearCampania(db, "enviando");
    await sembrarEnvios(db, campaniaId, 5);

    const vistos: string[] = [];
    for (let i = 0; i < 10; i++) {
      const envio = await reclamarEnvio(db);
      if (!envio) break;
      vistos.push(envio.id);
      await marcarEnviado(db, envio.id);
    }

    assert.equal(vistos.length, 5, "se reclaman los 5 envíos");
    assert.equal(new Set(vistos).size, 5, "ninguno se reclamó dos veces");
    assert.equal(await reclamarEnvio(db), null, "no quedan envíos por reclamar");
    assert.equal(await quedanPendientes(db, campaniaId), false, "la campaña ya no tiene pendientes");
  } finally {
    await cerrar();
  }
});

test("intentos concurrentes de claim reparten los envíos sin repetir", async () => {
  const { db, cerrar } = await crearDbEfimera();
  try {
    const campaniaId = await crearCampania(db, "enviando");
    await sembrarEnvios(db, campaniaId, 4);

    const reclamados = (await Promise.all(Array.from({ length: 4 }, () => reclamarEnvio(db)))).filter(Boolean);
    const ids = reclamados.map((e) => e!.id);
    assert.equal(ids.length, 4);
    assert.equal(new Set(ids).size, 4, "cada envío fue reclamado por un solo 'worker'");
  } finally {
    await cerrar();
  }
});

test("no se reclama si la campaña NO está 'enviando' (cancelada a mitad)", async () => {
  const { db, cerrar } = await crearDbEfimera();
  try {
    const campaniaId = await crearCampania(db, "cancelada");
    await sembrarEnvios(db, campaniaId, 3);

    assert.equal(await reclamarEnvio(db), null, "una campaña cancelada no deja reclamar sus envíos pendientes");

    // Al reactivarla, sus envíos vuelven a estar disponibles.
    await db.update(waCampanias).set({ estado: "enviando" }).where(eq(waCampanias.id, campaniaId));
    assert.notEqual(await reclamarEnvio(db), null, "reactivada, sí se reclama");
  } finally {
    await cerrar();
  }
});

test("throttle: espera el intervalo de envío tras procesar, y el poll cuando no hubo nada", () => {
  const intervalo = 1200;
  const poll = 2000;
  assert.equal(elegirEsperaMs(true, intervalo, poll), intervalo, "tras un envío respeta CAMPANIA_ENVIO_INTERVALO_MS");
  assert.equal(elegirEsperaMs(false, intervalo, poll), poll, "sin envíos usa el poll normal");
});
