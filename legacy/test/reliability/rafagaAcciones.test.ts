import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { eq, sql } from "drizzle-orm";
import { crearDbEfimera, type DbEfimera } from "../helpers/pgliteDb";
import { waJobs } from "../../src/db/schema";
import { marcarHecho, reclamarUno } from "../../src/queue/cola";
import { RepositorioDrizzle } from "../../src/booking/drizzleRepository";
import { ingerirEntrante } from "../../src/handleWebhook";
import { cargarTenants } from "../../src/config/tenantStore";
import { TENANT_FALLBACK_SELYON } from "../../src/config/tenants";
import { cuerpoTextoEntrante } from "../helpers/webhookMock";

// ─────────────────────────────────────────────────────────────────────────────
// Ráfagas con acciones y media (regla 3 de src/queue/cola.ts). Antes, CUALQUIER job
// viejo de una conversación cedía ante uno más nuevo: una foto seguida de un texto
// nunca se descargaba, y un "BAJA" o un "Confirmo" seguidos de otro mensaje se perdían.
// Se prueba por el camino real: ingesta → wa_jobs → claim, sobre Postgres (PGlite).
// ─────────────────────────────────────────────────────────────────────────────

let base: DbEfimera;
let repo: RepositorioDrizzle;
const PNID = TENANT_FALLBACK_SELYON.phoneNumberId;
let secuencia = 0;

before(async () => {
  base = await crearDbEfimera();
  repo = new RepositorioDrizzle(base.db);
  delete process.env.DATABASE_URL; // caché de tenants en fallback (no necesita wa_tenants)
  await cargarTenants();
});
after(async () => {
  await base.cerrar();
});
beforeEach(async () => {
  await base.db.execute(sql`DELETE FROM wa_jobs`);
});

function cuerpo(clienteWa: string, mensaje: Record<string, unknown>): unknown {
  return {
    entry: [{ changes: [{ value: { metadata: { phone_number_id: PNID }, messages: [{ from: clienteWa, ...mensaje }] } }] }],
  };
}

const texto = (clienteWa: string, t: string) =>
  cuerpoTextoEntrante({ phoneNumberId: PNID, clienteWa, texto: t, messageId: `wamid.r.${++secuencia}` });
const foto = (clienteWa: string) => cuerpo(clienteWa, { id: `wamid.r.${++secuencia}`, type: "image", image: { id: "media-1" } });
const botonConfirmar = (clienteWa: string) =>
  cuerpo(clienteWa, {
    id: `wamid.r.${++secuencia}`,
    type: "interactive",
    interactive: { type: "button_reply", button_reply: { id: "confirmar|cita-1", title: "Confirmo" } },
  });

/** Ingiere en orden, separando los creado_en para que el orden de llegada sea determinista. */
async function ingerir(...cuerpos: unknown[]): Promise<void> {
  for (const c of cuerpos) {
    assert.ok(await ingerirEntrante(c, repo), "el mensaje debe ingerirse");
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** Drena la cola como el worker y devuelve lo que se procesó (clase + texto), en orden. */
async function drenar(): Promise<string[]> {
  const procesados: string[] = [];
  for (let job = await reclamarUno(base.db); job; job = await reclamarUno(base.db)) {
    procesados.push(`${job.payload.clase}:${job.payload.entrante.texto}`);
    await marcarHecho(base.db, job.id);
  }
  return procesados;
}

async function reemplazados(): Promise<number> {
  return (await base.db.select().from(waJobs).where(eq(waJobs.estado, "reemplazado"))).length;
}

test("foto seguida de texto: la foto se procesa (no la absorbe el texto)", async () => {
  await ingerir(foto("50610000001"), texto("50610000001", "¿cuánto me cobran por esto?"));
  assert.deepEqual(await drenar(), ["imagen:", "texto:¿cuánto me cobran por esto?"]);
  assert.equal(await reemplazados(), 0);
});

test("BAJA seguida de otro texto: la baja se procesa igual", async () => {
  await ingerir(texto("50610000002", "BAJA"), texto("50610000002", "gracias"));
  assert.deepEqual(await drenar(), ["texto:BAJA", "texto:gracias"]);
  assert.equal(await reemplazados(), 0);
});

test("botón «Confirmo» seguido de un texto: la confirmación se procesa igual", async () => {
  await ingerir(botonConfirmar("50610000003"), texto("50610000003", "nos vemos mañana"));
  const procesados = await drenar();
  assert.equal(procesados.length, 2, "ni la confirmación ni el texto se pierden");
  assert.equal(await reemplazados(), 0);
});

test("texto seguido de BAJA: el texto no cede ante una acción directa (que no relee el historial)", async () => {
  await ingerir(texto("50610000004", "quiero una cita"), texto("50610000004", "BAJA"));
  assert.deepEqual(await drenar(), ["texto:quiero una cita", "texto:BAJA"]);
  assert.equal(await reemplazados(), 0);
});

test("texto seguido de foto: el texto sí cede (la foto es un turno del agente que lo lee como contexto)", async () => {
  await ingerir(texto("50610000005", "mirá cómo quedó"), foto("50610000005"));
  assert.deepEqual(await drenar(), ["imagen:"]);
  assert.equal(await reemplazados(), 1);
});

test("dos textos comunes: se agrupan como antes (un solo turno)", async () => {
  await ingerir(texto("50610000006", "hola"), texto("50610000006", "quiero cita"));
  assert.deepEqual(await drenar(), ["texto:quiero cita"]);
  assert.equal(await reemplazados(), 1);
});

test("jobs encolados por una versión anterior (sin flags): nunca se reemplazan", async () => {
  await ingerir(texto("50610000007", "hola"), texto("50610000007", "quiero cita"));
  await base.db.execute(sql`UPDATE wa_jobs SET payload = payload - 'agrupable' - 'releeHistorial'`);
  assert.equal((await drenar()).length, 2);
  assert.equal(await reemplazados(), 0);
});
