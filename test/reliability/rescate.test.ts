import { test } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { crearDbEfimera } from "../helpers/pgliteDb";
import { waCotizaciones } from "../../src/db/schema";
import { purgarCotizacionesFinalizadas, reclamarToque1, reclamarToque2 } from "../../src/rescate/cola";
import { RepositorioDrizzle } from "../../src/booking/drizzleRepository";

// ─────────────────────────────────────────────────────────────────────────────
// Rescate de cotizaciones abandonadas (Carril D, 1.1) contra Postgres efímero
// (PGlite) — mismo ángulo 5 (TESTING.md) que campanias.test.ts: se prueba el SQL
// real de la mini-cola (FOR UPDATE SKIP LOCKED) y las transiciones de estado del
// Repositorio (registrar/cerrar por cita).
// ─────────────────────────────────────────────────────────────────────────────

const TENANT = "tenant-rescate";
type Db = Awaited<ReturnType<typeof crearDbEfimera>>["db"];

async function sembrarCotizacion(
  db: Db,
  overrides: Partial<typeof waCotizaciones.$inferInsert> = {},
): Promise<string> {
  const [c] = await db
    .insert(waCotizaciones)
    .values({
      tenantId: TENANT,
      clienteWa: "50688887777",
      servicioId: "pulido_sellador",
      monto: 15000,
      ...overrides,
    })
    .returning({ id: waCotizaciones.id });
  return c.id;
}

const horasAtras = (h: number) => new Date(Date.now() - h * 60 * 60 * 1000);

test("reclamarToque1: solo reclama cotizaciones 'pendiente' más viejas que el corte", async () => {
  const { db, cerrar } = await crearDbEfimera();
  try {
    const vieja = await sembrarCotizacion(db, { clienteWa: "50688880001" });
    await db.update(waCotizaciones).set({ creadaEn: horasAtras(5) }).where(eq(waCotizaciones.id, vieja));
    await sembrarCotizacion(db, { clienteWa: "50688880002" }); // recién creada: no toca todavía

    const antesDe = horasAtras(3); // corte: cotizaciones de hace 3+ horas
    const c1 = await reclamarToque1(db, TENANT, antesDe);
    assert.equal(c1?.id, vieja);
    assert.equal(await reclamarToque1(db, TENANT, antesDe), null, "la reciente no califica todavía");
  } finally {
    await cerrar();
  }
});

test("reclamarToque1: intentos concurrentes no reclaman la misma cotización dos veces", async () => {
  const { db, cerrar } = await crearDbEfimera();
  try {
    const ids = await Promise.all(
      Array.from({ length: 4 }, (_, i) => sembrarCotizacion(db, { clienteWa: `5068888100${i}` })),
    );
    for (const id of ids) {
      await db.update(waCotizaciones).set({ creadaEn: horasAtras(5) }).where(eq(waCotizaciones.id, id));
    }

    const antesDe = horasAtras(3);
    const reclamados = (await Promise.all(Array.from({ length: 4 }, () => reclamarToque1(db, TENANT, antesDe)))).filter(Boolean);
    const vistos = reclamados.map((r) => r!.id);
    assert.equal(vistos.length, 4);
    assert.equal(new Set(vistos).size, 4, "ninguna se reclamó dos veces");
  } finally {
    await cerrar();
  }
});

test("reclamarToque2: solo reclama 'toque1' cuyo primer toque ya pasó el corte", async () => {
  const { db, cerrar } = await crearDbEfimera();
  try {
    const lista = await sembrarCotizacion(db, { clienteWa: "50688881234" });
    await db
      .update(waCotizaciones)
      .set({ estado: "toque1", toque1En: horasAtras(30) })
      .where(eq(waCotizaciones.id, lista));
    await sembrarCotizacion(db, { clienteWa: "50688885678" }); // sigue "pendiente": no aplica a toque2

    const antesDe = horasAtras(24);
    const cand = await reclamarToque2(db, TENANT, antesDe);
    assert.equal(cand?.id, lista);
    assert.equal(await reclamarToque2(db, TENANT, antesDe), null);
  } finally {
    await cerrar();
  }
});

test("Repositorio.registrarCotizacion: no permite dos rescates activos al mismo teléfono", async () => {
  const { db, cerrar } = await crearDbEfimera();
  try {
    const repo = new RepositorioDrizzle(db);
    const a = await repo.registrarCotizacion(TENANT, "50688889999", "pulido_sellador", 15000);
    assert.ok(a);
    const b = await repo.registrarCotizacion(TENANT, "50688889999", "pulido_focos", 12000);
    assert.equal(b, null, "ya hay una cotización activa para ese teléfono");
  } finally {
    await cerrar();
  }
});

test("Repositorio.actualizarCotizacionPorCita: sin toques previos → 'agendada'; con un toque → 'recuperada'", async () => {
  const { db, cerrar } = await crearDbEfimera();
  try {
    const repo = new RepositorioDrizzle(db);

    // Caso 1: el cliente agendó ANTES de que saliera ningún toque.
    await repo.registrarCotizacion(TENANT, "50688881111", "pulido_sellador", 15000);
    await repo.actualizarCotizacionPorCita(TENANT, "50688881111", "pulido_sellador", "cita-1", 15000);
    const [f1] = await db.select().from(waCotizaciones).where(eq(waCotizaciones.clienteWa, "50688881111"));
    assert.equal(f1.estado, "agendada");
    assert.equal(f1.montoRecuperado, null);

    // Caso 2: ya se le mandó el toque1, después agendó → "recuperada".
    const idB = await sembrarCotizacion(db, { clienteWa: "50688882222", monto: 18000 });
    await db.update(waCotizaciones).set({ estado: "toque1", toque1En: new Date() }).where(eq(waCotizaciones.id, idB));
    await repo.actualizarCotizacionPorCita(TENANT, "50688882222", "pulido_sellador", "cita-2", 18000);
    const [f2] = await db.select().from(waCotizaciones).where(eq(waCotizaciones.id, idB));
    assert.equal(f2.estado, "recuperada");
    assert.equal(f2.montoRecuperado, 18000);
  } finally {
    await cerrar();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Purga por retención (ROADMAP F11): purgarCotizacionesFinalizadas solo borra
// estados finales viejos; deja vivos los estados que el rescate sigue tocando.
// ─────────────────────────────────────────────────────────────────────────────

test("purgarCotizacionesFinalizadas: borra estados finales viejos, respeta el corte de días", async () => {
  const { db, cerrar } = await crearDbEfimera();
  try {
    const vieja = await sembrarCotizacion(db, { clienteWa: "50688890001", estado: "agendada" });
    await db.update(waCotizaciones).set({ creadaEn: horasAtras(24 * 10) }).where(eq(waCotizaciones.id, vieja));

    const reciente = await sembrarCotizacion(db, { clienteWa: "50688890002", estado: "recuperada" });
    await db.update(waCotizaciones).set({ creadaEn: horasAtras(24 * 2) }).where(eq(waCotizaciones.id, reciente));

    const borrados = await purgarCotizacionesFinalizadas(db, 7);
    assert.equal(borrados, 1, "solo la de hace 10 días cruza el corte de 7");

    const restantes = await db.select({ id: waCotizaciones.id }).from(waCotizaciones);
    assert.deepEqual(restantes.map((r) => r.id).sort(), [reciente].sort());
  } finally {
    await cerrar();
  }
});

test("purgarCotizacionesFinalizadas: NO toca 'pendiente'/'toque1'/'toque2' sin importar la antigüedad", async () => {
  const { db, cerrar } = await crearDbEfimera();
  try {
    const pendiente = await sembrarCotizacion(db, { clienteWa: "50688891001" });
    await db.update(waCotizaciones).set({ creadaEn: horasAtras(24 * 30) }).where(eq(waCotizaciones.id, pendiente));

    const toque1 = await sembrarCotizacion(db, { clienteWa: "50688891002", estado: "toque1", toque1En: horasAtras(24 * 30) });
    await db.update(waCotizaciones).set({ creadaEn: horasAtras(24 * 30) }).where(eq(waCotizaciones.id, toque1));

    const toque2 = await sembrarCotizacion(db, { clienteWa: "50688891003", estado: "toque2", toque2En: horasAtras(24 * 30) });
    await db.update(waCotizaciones).set({ creadaEn: horasAtras(24 * 30) }).where(eq(waCotizaciones.id, toque2));

    const borrados = await purgarCotizacionesFinalizadas(db, 7);
    assert.equal(borrados, 0, "ninguno de los tres es un estado final: la purga no toca nada");

    const restantes = await db.select({ id: waCotizaciones.id }).from(waCotizaciones);
    assert.equal(restantes.length, 3);
  } finally {
    await cerrar();
  }
});

test("purgarCotizacionesFinalizadas: borra por lotes y termina (no loop infinito)", async () => {
  const { db, cerrar } = await crearDbEfimera();
  try {
    const ids = await Promise.all(
      Array.from({ length: 5 }, (_, i) => sembrarCotizacion(db, { clienteWa: `506888920${i}`, estado: "opt_out" })),
    );
    for (const id of ids) {
      await db.update(waCotizaciones).set({ creadaEn: horasAtras(24 * 10) }).where(eq(waCotizaciones.id, id));
    }

    const borrados = await purgarCotizacionesFinalizadas(db, 7, 2); // lote de 2, con 5 filas → 3 vueltas
    assert.equal(borrados, 5);

    const restantes = await db.select({ id: waCotizaciones.id }).from(waCotizaciones);
    assert.equal(restantes.length, 0);
  } finally {
    await cerrar();
  }
});
