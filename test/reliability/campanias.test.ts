import { test } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { crearDbEfimera } from "../helpers/pgliteDb";
import { waCampanias, waCampaniaEnvios } from "../../src/db/schema";
import { marcarEnviado, purgarEnviosFinalizados, quedanPendientes, reclamarEnvio } from "../../src/campaigns/cola";
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

// ─────────────────────────────────────────────────────────────────────────────
// Purga por retención (ROADMAP F11): purgarEnviosFinalizados solo borra envíos
// de campañas PADRE ya 'completada'/'cancelada' y viejas.
// ─────────────────────────────────────────────────────────────────────────────

const diasAtras = (d: number) => new Date(Date.now() - d * 24 * 60 * 60 * 1000);

test("purgarEnviosFinalizados: borra envíos de una campaña 'completada' vieja, respeta el corte de días", async () => {
  const { db, cerrar } = await crearDbEfimera();
  try {
    const vieja = await crearCampania(db, "completada");
    await db.update(waCampanias).set({ completadaEn: diasAtras(10) }).where(eq(waCampanias.id, vieja));
    await sembrarEnvios(db, vieja, 3);

    const reciente = await crearCampania(db, "completada");
    await db.update(waCampanias).set({ completadaEn: diasAtras(1) }).where(eq(waCampanias.id, reciente));
    await sembrarEnvios(db, reciente, 2);

    const borrados = await purgarEnviosFinalizados(db, 7);
    assert.equal(borrados, 3, "solo los envíos de la campaña completada hace 10 días cruzan el corte de 7");

    assert.equal(await quedanPendientes(db, vieja), false, "sin filas propias, no hay 'pendiente' para la vieja");
    const restantesReciente = await db.select().from(waCampaniaEnvios).where(eq(waCampaniaEnvios.campaniaId, reciente));
    assert.equal(restantesReciente.length, 2, "los envíos de la campaña reciente no se tocan");
  } finally {
    await cerrar();
  }
});

test("purgarEnviosFinalizados: NO toca envíos de una campaña 'enviando' (en curso) sin importar la antigüedad", async () => {
  const { db, cerrar } = await crearDbEfimera();
  try {
    const campaniaId = await crearCampania(db, "enviando");
    await db.update(waCampanias).set({ iniciadaEn: diasAtras(30) }).where(eq(waCampanias.id, campaniaId));
    await sembrarEnvios(db, campaniaId, 4);

    const borrados = await purgarEnviosFinalizados(db, 7);
    assert.equal(borrados, 0, "'enviando' no es un estado final: la purga no la toca aunque sea vieja");

    const restantes = await db.select().from(waCampaniaEnvios).where(eq(waCampaniaEnvios.campaniaId, campaniaId));
    assert.equal(restantes.length, 4);
  } finally {
    await cerrar();
  }
});

test("purgarEnviosFinalizados: campaña 'cancelada' usa creada_en como corte (no tiene completada_en)", async () => {
  const { db, cerrar } = await crearDbEfimera();
  try {
    const campaniaId = await crearCampania(db, "cancelada");
    await db.update(waCampanias).set({ creadaEn: diasAtras(10) }).where(eq(waCampanias.id, campaniaId));
    await sembrarEnvios(db, campaniaId, 2);

    const borrados = await purgarEnviosFinalizados(db, 7);
    assert.equal(borrados, 2, "cancelada hace 10 días (por creada_en, sin completada_en) cruza el corte de 7");
  } finally {
    await cerrar();
  }
});

test("purgarEnviosFinalizados: borra por lotes y termina (no loop infinito)", async () => {
  const { db, cerrar } = await crearDbEfimera();
  try {
    const campaniaId = await crearCampania(db, "completada");
    await db.update(waCampanias).set({ completadaEn: diasAtras(10) }).where(eq(waCampanias.id, campaniaId));
    await sembrarEnvios(db, campaniaId, 5);

    const borrados = await purgarEnviosFinalizados(db, 7, 2); // lote de 2, con 5 filas → 3 vueltas
    assert.equal(borrados, 5);

    const restantes = await db.select().from(waCampaniaEnvios).where(eq(waCampaniaEnvios.campaniaId, campaniaId));
    assert.equal(restantes.length, 0);
  } finally {
    await cerrar();
  }
});
