import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { eq, sql } from "drizzle-orm";
import { crearDbEfimera, type DbEfimera } from "../helpers/pgliteDb";
import { waCitas, waJobs } from "../../src/db/schema";
import { reclamarUno } from "../../src/queue/cola";
import { procesarJob } from "../../src/queue/worker";
import { RepositorioDrizzle } from "../../src/booking/drizzleRepository";
import { ingerirEntrante } from "../../src/handleWebhook";
import { cargarTenants } from "../../src/config/tenantStore";
import { TENANT_FALLBACK_SELYON } from "../../src/config/tenants";
import { cuerpoTextoEntrante, desactivarMockWebhook, instalarMockWebhook } from "../helpers/webhookMock";

// ─────────────────────────────────────────────────────────────────────────────
// E7 — reintentos ante errores TRANSITORIOS de OpenAI/Graph, de punta a punta:
// ingesta real → cola durable real (PGlite) → `procesarJob` del worker (el mismo
// que corren los slots) → `responderEntrante`. Antes, cualquier excepción del turno
// terminaba en "Disculpá, tuvimos un problemita" y el job quedaba "hecho": el backoff
// de la cola nunca corría. Ahora la disculpa + aviso al operador son solo para el
// ÚLTIMO intento; los anteriores relanzan y la cola reintenta.
// ─────────────────────────────────────────────────────────────────────────────

let base: DbEfimera;
let repo: RepositorioDrizzle;
const tenant = TENANT_FALLBACK_SELYON;
let n = 0;

before(async () => {
  base = await crearDbEfimera();
  repo = new RepositorioDrizzle(base.db);
  delete process.env.DATABASE_URL;
  await cargarTenants(); // fallback en memoria del tenantStore
  tenant.accessToken = "test-token"; // sin token, enviarTexto lanza antes del fetch mockeado
});
after(async () => {
  tenant.accessToken = undefined; // no dejar mutado el singleton compartido
  desactivarMockWebhook();
  await base.cerrar();
});

/** Ingiere un mensaje de un cliente nuevo y deja su job listo con `maxIntentos` intentos. */
async function encolarMensaje(texto: string, maxIntentos: number): Promise<string> {
  n++;
  const pendiente = await ingerirEntrante(
    cuerpoTextoEntrante({ phoneNumberId: tenant.phoneNumberId, clienteWa: `5067000000${n}`, texto, messageId: `wamid.reint.${n}` }),
    repo,
  );
  assert.ok(pendiente, "el mensaje debe ingerirse");
  await base.db.execute(sql`UPDATE wa_jobs SET max_intentos = ${maxIntentos} WHERE estado = 'pendiente'`);
  const [fila] = await base.db.select().from(waJobs).where(eq(waJobs.waMessageId, `wamid.reint.${n}`));
  return fila.id;
}

/** Corre un intento como lo haría un slot del worker: reclama y procesa. */
async function correrIntento(): Promise<void> {
  // El backoff deja el job en el futuro; el test no espera esos segundos.
  await base.db.execute(sql`UPDATE wa_jobs SET ejecutar_despues_de = now() WHERE estado = 'pendiente'`);
  const job = await reclamarUno(base.db);
  assert.ok(job, "debe haber un job para reclamar");
  await procesarJob(job!, repo, base.db);
}

async function fila(id: string) {
  const [f] = await base.db.select().from(waJobs).where(eq(waJobs.id, id));
  return f;
}

const esDisculpa = (t?: string) => !!t && /problemita/.test(t);

test("503 de OpenAI con intentos restantes → el job vuelve a la cola (sin disculpa); en el ÚLTIMO intento recién se disculpa", async () => {
  const mock = instalarMockWebhook();
  const id = await encolarMensaje("¿cuánto cuesta?", 2);

  mock.programarLLM({ errorHttp: 503 });
  await correrIntento();
  let f = await fila(id);
  assert.equal(f.estado, "pendiente", "intento 1 de 2: la cola lo reintenta con backoff");
  assert.match(f.ultimoError ?? "", /503/);
  assert.ok(f.ejecutarDespuesDe.getTime() > Date.now(), "con backoff (ejecutar_despues_de en el futuro)");
  assert.equal(mock.enviados.length, 0, "en un intento intermedio el cliente NO recibe la disculpa");

  mock.programarLLM({ errorHttp: 503 });
  await correrIntento();
  f = await fila(id);
  assert.equal(f.estado, "hecho", "en el último intento el turno se cierra (no va al DLQ)");
  assert.equal(mock.enviados.length, 1);
  assert.ok(esDisculpa(mock.enviados[0].texto), "recién en el último intento llega la disculpa");
});

test("429 transitorio y después OK → el cliente recibe la respuesta normal, nunca la disculpa", async () => {
  const mock = instalarMockWebhook();
  const id = await encolarMensaje("hola", 5);

  mock.programarLLM({ errorHttp: 429 });
  await correrIntento();
  assert.equal((await fila(id)).estado, "pendiente");

  mock.programarLLM({ texto: "¡Hola! ¿En qué te ayudo?" });
  await correrIntento();
  assert.equal((await fila(id)).estado, "hecho");
  assert.equal(mock.enviados.length, 1);
  assert.ok(mock.enviados[0].texto?.includes("¿En qué te ayudo?"));
  assert.equal(mock.llamadasLLM(), 2);
});

test("error PERMANENTE (400) → no se reintenta: disculpa en el primer intento, como siempre", async () => {
  const mock = instalarMockWebhook();
  const id = await encolarMensaje("hola de nuevo", 5);

  mock.programarLLM({ errorHttp: 400 });
  await correrIntento();
  assert.equal((await fila(id)).estado, "hecho");
  assert.equal(mock.enviados.length, 1);
  assert.ok(esDisculpa(mock.enviados[0].texto));
});

test("cita ya guardada y después 503 → NO se reintenta (duplicaría la cita): se confirma con texto fijo (G5)", async () => {
  const mock = instalarMockWebhook();
  const id = await encolarMensaje("agendame el demo", 5);

  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 7);
  while (d.getUTCDay() !== 1) d.setUTCDate(d.getUTCDate() + 1); // un lunes (el tenant abre de lunes a viernes)
  const fecha = d.toISOString().slice(0, 10);

  mock.programarLLM(
    { tool: "agendar_cita", args: { nombre: "Ana", servicioId: "demo", fecha, hora: "10:00" } },
    { errorHttp: 503 },
  );
  await correrIntento();

  assert.equal((await fila(id)).estado, "hecho", "el turno ya tuvo efectos: no vuelve a la cola");
  const citas = await base.db.select().from(waCitas).where(eq(waCitas.fecha, fecha));
  assert.equal(citas.length, 1, "exactamente una cita");
  assert.equal(mock.enviados.length, 1);
  assert.match(mock.enviados[0].texto ?? "", /quedó agendada/);
});
