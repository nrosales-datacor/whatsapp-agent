import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { eq, sql } from "drizzle-orm";
import { crearDbEfimera, type DbEfimera } from "../helpers/pgliteDb";
import { waJobs } from "../../src/db/schema";
import { marcarHecho, reclamarUno } from "../../src/queue/cola";
import { concurrenciaWorker } from "../../src/queue/worker";
import { filasDe } from "../../src/db/filas";
import type { Conversacion, PendienteSerializado } from "../../src/types";

// ─────────────────────────────────────────────────────────────────────────────
// E7 — worker concurrente: las garantías del claim (`reclamarUno`) contra Postgres
// real (PGlite). Son las que hacen seguro correr N slots y N réplicas:
//   1) nunca dos jobs "procesando" de la misma conversación;
//   2) conversaciones distintas sí se procesan a la vez;
//   3) reparto por tenant (el que tiene menos jobs en vuelo va primero);
//   4) un reintento que llega tarde cede ante un mensaje más nuevo ya respondido.
// Una sola base para todo el archivo (crearla cuesta ~15 s); cada test vacía wa_jobs.
// ─────────────────────────────────────────────────────────────────────────────

let base: DbEfimera;
before(async () => {
  base = await crearDbEfimera();
});
after(async () => {
  await base.cerrar();
});
beforeEach(async () => {
  await base.db.execute(sql`DELETE FROM wa_jobs`);
});

const conv = (id: string, tenantId = "tenant-a"): Conversacion => ({
  id,
  tenantId,
  clienteWa: `506${id}`,
  optInEn: null,
  optOutEn: null,
  modo: "bot",
  estado: "abierta",
  mensajes: [],
  ventanaAbierta: false,
  ventanaCierraEn: null,
});

function payload(c: Conversacion): PendienteSerializado {
  return {
    clase: "texto",
    tenantId: c.tenantId,
    entrante: { phoneNumberId: "pnid", clienteWa: c.clienteWa, esTexto: true, texto: "hola" },
    conv: c,
    primerContacto: false,
  };
}

/** Encola un job a mano; `haceSeg` lo fecha en el pasado para fijar el orden de llegada. */
async function encolar(
  c: Conversacion,
  haceSeg: number,
  extra: Partial<typeof waJobs.$inferInsert> = {},
): Promise<string> {
  const cuando = new Date(Date.now() - haceSeg * 1000);
  const [row] = await base.db
    .insert(waJobs)
    .values({ tenantId: c.tenantId, payload: payload(c), creadoEn: cuando, ejecutarDespuesDe: cuando, ...extra })
    .returning({ id: waJobs.id });
  return row.id;
}

async function enVueloPorConversacion(): Promise<Map<string, number>> {
  const filas = filasDe<{ conv: string; n: number }>(
    await base.db.execute(sql`
      SELECT payload->'conv'->>'id' AS conv, count(*)::int AS n
        FROM wa_jobs WHERE estado = 'procesando' GROUP BY 1
    `),
  );
  return new Map(filas.map((f) => [f.conv, Number(f.n)]));
}

test("misma conversación: con un job 'procesando', el siguiente de esa conversación NO se reclama hasta que termine", async () => {
  const enCurso = await encolar(conv("c1"), 30, { estado: "procesando", lockedAt: new Date(), intentos: 1 });
  const siguiente = await encolar(conv("c1"), 5);

  assert.equal(await reclamarUno(base.db), null, "no debe tomar un 2º job de una conversación que ya tiene uno en curso");

  await marcarHecho(base.db, enCurso);
  const job = await reclamarUno(base.db);
  assert.equal(job?.id, siguiente, "al terminar el primero, el siguiente de la conversación ya se puede reclamar");
});

test("varios slots reclamando a la vez: conversaciones distintas en paralelo, nunca dos de la misma", async () => {
  await encolar(conv("a"), 40);
  await encolar(conv("a"), 30); // ráfaga de la misma conversación
  await encolar(conv("b"), 20);
  await encolar(conv("c"), 10);

  // 4 "slots" reclaman al mismo tiempo, como lo hace iniciarWorker con WORKER_CONCURRENCIA=4.
  const reclamados = (await Promise.all([1, 2, 3, 4].map(() => reclamarUno(base.db)))).filter((j) => j !== null);

  const convs = reclamados.map((j) => j!.payload.conv.id).sort();
  assert.deepEqual(convs, ["a", "b", "c"], "un job en vuelo por cada conversación distinta, todos a la vez");

  for (const [c, n] of await enVueloPorConversacion()) {
    assert.equal(n, 1, `la conversación ${c} no puede tener más de un job 'procesando'`);
  }
  // Una 5ª vuelta no encuentra nada más: el job restante de "a" es el viejo de la
  // ráfaga (quedó "reemplazado", E5-b) — no un segundo job en vuelo de "a".
  assert.equal(await reclamarUno(base.db), null);
});

test("reparto por tenant: el que llega con 1 mensaje no espera a que se vacíe la cola de otro tenant", async () => {
  for (let i = 0; i < 6; i++) await encolar(conv(`g${i}`, "tenant-grande"), 60 - i);
  await encolar(conv("ch", "tenant-chico"), 1); // el más NUEVO de todos

  const primero = await reclamarUno(base.db);
  const segundo = await reclamarUno(base.db);
  assert.equal(primero?.tenantId, "tenant-grande", "empate en vuelo (0 y 0): gana el más viejo");
  assert.equal(segundo?.tenantId, "tenant-chico", "con el grande ya en vuelo, el chico pasa delante de los otros 5");
});

test("un reintento que llega tarde cede ante un mensaje más nuevo de su conversación ya respondido", async () => {
  // El job viejo falló (intentos=1) y quedó en backoff; mientras, el cliente escribió
  // de nuevo y ese turno —que releyó el historial con el mensaje viejo adentro— ya se
  // respondió. Contestar el viejo ahora sería una respuesta tardía y fuera de orden.
  const reintento = await encolar(conv("r"), 30, { intentos: 1 });
  await encolar(conv("r"), 10, { estado: "hecho", finalizadoEn: new Date() });

  assert.equal(await reclamarUno(base.db), null);
  const [fila] = await base.db.select().from(waJobs).where(eq(waJobs.id, reintento));
  assert.equal(fila.estado, "reemplazado");

  // Un job FRESCO (o reencolado a mano desde el DLQ: intentos=0) no entra en esa regla.
  const delDlq = await encolar(conv("d"), 30, { intentos: 0 });
  await encolar(conv("d"), 10, { estado: "hecho", finalizadoEn: new Date() });
  assert.equal((await reclamarUno(base.db))?.id, delDlq);
});

test("WORKER_CONCURRENCIA: default 4; valores inválidos caen al default", () => {
  const previo = process.env.WORKER_CONCURRENCIA;
  try {
    delete process.env.WORKER_CONCURRENCIA;
    assert.equal(concurrenciaWorker(), 4);
    process.env.WORKER_CONCURRENCIA = "8";
    assert.equal(concurrenciaWorker(), 8);
    for (const malo of ["0", "-2", "abc", "2.5"]) {
      process.env.WORKER_CONCURRENCIA = malo;
      assert.equal(concurrenciaWorker(), 4, `"${malo}" no es válido`);
    }
  } finally {
    if (previo === undefined) delete process.env.WORKER_CONCURRENCIA;
    else process.env.WORKER_CONCURRENCIA = previo;
  }
});
