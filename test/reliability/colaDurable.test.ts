import { test } from "node:test";
import assert from "node:assert/strict";
import { and, eq } from "drizzle-orm";
import { crearDbEfimera } from "../helpers/pgliteDb";
import { waJobs } from "../../src/db/schema";
import { marcarFalloOReintentar, marcarHecho, reclamarUno, reencolarVencidos } from "../../src/queue/cola";
import { RepositorioDrizzle } from "../../src/booking/drizzleRepository";
import { ingerirEntrante, responderEntrante } from "../../src/handleWebhook";
import { cargarTenants, obtenerTenantPorPhoneNumberId } from "../../src/config/tenantStore";
import { TENANT_FALLBACK_SELYON } from "../../src/config/tenants";
import type { Conversacion, PendienteSerializado } from "../../src/types";
import { cuerpoTextoEntrante, desactivarMockWebhook, instalarMockWebhook } from "../helpers/webhookMock";

// ─────────────────────────────────────────────────────────────────────────────
// Ángulo 5 (TESTING.md) — cola durable wa_jobs (B1) contra Postgres efímero
// (PGlite). Valida el SQL REAL de claim/reaper/reintento, no una copia en memoria.
// ─────────────────────────────────────────────────────────────────────────────

const TENANT = "tenant-rel";

function payloadFalso(conv: Conversacion, texto = "hola"): PendienteSerializado {
  return {
    clase: "texto",
    tenantId: TENANT,
    entrante: {
      phoneNumberId: "pnid-rel",
      clienteWa: conv.clienteWa,
      messageId: conv.mensajes.at(-1)?.waMessageId,
      esTexto: true,
      texto,
    },
    conv,
    primerContacto: false,
  };
}

/** Inserta un job directamente (sin pasar por el mensaje), para probar el claim aislado. */
async function encolarDirecto(
  db: Awaited<ReturnType<typeof crearDbEfimera>>["db"],
  conv: Conversacion,
  extra: Partial<typeof waJobs.$inferInsert> = {},
): Promise<string> {
  const [row] = await db
    .insert(waJobs)
    .values({ tenantId: TENANT, payload: payloadFalso(conv), ...extra })
    .returning({ id: waJobs.id });
  return row.id;
}

const convVacia = (): Conversacion => ({
  id: "conv-x",
  tenantId: TENANT,
  clienteWa: "50600000001",
  optInEn: null,
  optOutEn: null,
  modo: "bot",
  estado: "abierta",
  mensajes: [],
  ventanaAbierta: false,
  ventanaCierraEn: null,
});

test("un job pendiente se reclama exactamente una vez (no se re-entrega)", async () => {
  const { db, cerrar } = await crearDbEfimera();
  try {
    const id = await encolarDirecto(db, convVacia());

    const primero = await reclamarUno(db);
    assert.equal(primero?.id, id, "el primer worker debe reclamar el job");
    assert.equal(primero?.intentos, 1, "el claim incrementa intentos");

    const segundo = await reclamarUno(db);
    assert.equal(segundo, null, "un segundo worker NO vuelve a reclamar el mismo job (ya está 'procesando')");

    await marcarHecho(db, id);
    const [fila] = await db.select().from(waJobs).where(eq(waJobs.id, id));
    assert.equal(fila.estado, "hecho");
    assert.notEqual(fila.finalizadoEn, null);
  } finally {
    await cerrar();
  }
});

test("el reaper reencola un job colgado (crash a mitad del trabajo)", async () => {
  const { db, cerrar } = await crearDbEfimera();
  try {
    // Job que quedó 'procesando' con un lock viejo (worker murió antes de marcarHecho).
    const viejo = new Date(Date.now() - 10 * 60 * 1000); // hace 10 min
    const id = await encolarDirecto(db, convVacia(), { estado: "procesando", lockedAt: viejo });

    assert.equal(await reclamarUno(db), null, "mientras está 'procesando' no se reclama");

    const reencolados = await reencolarVencidos(db, 180); // umbral 3 min < 10 min → vence
    assert.equal(reencolados, 1, "el reaper reencola el job vencido");

    const rescatado = await reclamarUno(db);
    assert.equal(rescatado?.id, id, "tras el reaper, un worker sí puede reclamarlo y procesarlo");
  } finally {
    await cerrar();
  }
});

test("un lock reciente NO lo toca el reaper", async () => {
  const { db, cerrar } = await crearDbEfimera();
  try {
    await encolarDirecto(db, convVacia(), { estado: "procesando", lockedAt: new Date() });
    assert.equal(await reencolarVencidos(db, 180), 0, "un job recién lockeado no está vencido");
  } finally {
    await cerrar();
  }
});

test("al fallar, reencola con backoff (no reclamable de inmediato); al agotar intentos, queda en 'error'", async () => {
  const { db, cerrar } = await crearDbEfimera();
  try {
    const id = await encolarDirecto(db, convVacia());
    const job = await reclamarUno(db);
    assert.equal(job?.intentos, 1);

    // Falla con intentos restantes → vuelve a 'pendiente' pero con ejecutar_despues_de futuro.
    await marcarFalloOReintentar(db, id, "boom", job!.intentos, job!.maxIntentos);
    const [trasFallo] = await db.select().from(waJobs).where(eq(waJobs.id, id));
    assert.equal(trasFallo.estado, "pendiente");
    assert.equal(trasFallo.ultimoError, "boom");
    assert.equal(await reclamarUno(db), null, "el backoff impide reclamarlo antes de ejecutar_despues_de");

    // Falla habiendo agotado los intentos → 'error' definitivo.
    await marcarFalloOReintentar(db, id, "fatal", job!.maxIntentos, job!.maxIntentos);
    const [trasAgotar] = await db.select().from(waJobs).where(eq(waJobs.id, id));
    assert.equal(trasAgotar.estado, "error");
    assert.equal(trasAgotar.ultimoError, "fatal");
  } finally {
    await cerrar();
  }
});

test("guardarEntranteYEncolar es idempotente por wamid: un reintento de Meta NO duplica el job", async () => {
  const { db, cerrar } = await crearDbEfimera();
  try {
    const repo = new RepositorioDrizzle(db);
    const conv = await repo.obtenerOConversacion(TENANT, "50600000002");
    const msg = {
      rol: "user" as const,
      contenido: "quiero un pulido",
      creadoEn: new Date().toISOString(),
      waMessageId: "wamid.dup.1",
    };
    const payload = payloadFalso({ ...conv, mensajes: [msg] });

    const primera = await repo.guardarEntranteYEncolar(conv.id, msg, payload);
    assert.equal(primera, true, "el primer entrante se encola");

    const segunda = await repo.guardarEntranteYEncolar(conv.id, msg, payload);
    assert.equal(segunda, false, "el reenvío con el mismo wamid NO se vuelve a encolar");

    const jobs = await db.select().from(waJobs).where(and(eq(waJobs.tenantId, TENANT), eq(waJobs.waMessageId, "wamid.dup.1")));
    assert.equal(jobs.length, 1, "debe existir exactamente UN job para ese mensaje");
  } finally {
    await cerrar();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// E5-b — ráfaga de mensajes: 3 mensajes de la MISMA conversación entran casi al
// mismo tiempo (3 llamadas reales a la ingesta, cola durable real sobre PGlite).
// Antes del fix, cada uno generaba su propio job y el worker respondía 3 veces por
// separado (incoherente + triplica el aviso de bot). Con el fix, `reclamarUno`
// descarta ("reemplazado") los jobs viejos de la conversación en cuanto encuentra
// uno más nuevo pendiente, así que solo el último termina en `responderEntrante` —
// y ese último ve el historial COMPLETO (E5-a: relee la conversación fresca en vez
// de confiar en el snapshot de la ingesta).
// ─────────────────────────────────────────────────────────────────────────────
test("ráfaga (E5): 3 mensajes casi simultáneos de la misma conversación → UNA sola respuesta, con el historial completo", async () => {
  const mock = instalarMockWebhook();
  const { db, cerrar } = await crearDbEfimera();
  try {
    // Fallback en memoria del tenantStore (no requiere wa_tenants en esta base efímera).
    delete process.env.DATABASE_URL;
    await cargarTenants();
    const tenantFallback = TENANT_FALLBACK_SELYON;
    // El fallback no trae accessToken (nunca se configuró Graph para él); sin uno,
    // enviarTexto lanza ANTES del fetch mockeado y no llega ningún "enviado".
    tenantFallback.accessToken = "test-token";
    const repo = new RepositorioDrizzle(db);
    const cliente = "50699998888";
    const textos = ["Hola", "quiero una cita", "para el viernes"];

    for (let i = 0; i < textos.length; i++) {
      const body = cuerpoTextoEntrante({
        phoneNumberId: tenantFallback.phoneNumberId,
        clienteWa: cliente,
        texto: textos[i],
        messageId: `wamid.rafaga.${i}`,
      });
      const pendiente = await ingerirEntrante(body, repo);
      assert.ok(pendiente, `el mensaje ${i} ("${textos[i]}") debe ingerirse`);
      // Separa los `creado_en` para un orden determinista (evita ties de reloj entre
      // inserts consecutivos demasiado rápidos).
      await new Promise((r) => setTimeout(r, 5));
    }

    mock.programarLLM({ texto: "¡Listo! Te veo el viernes." });

    // Drena la cola como lo haría el worker: reclamarUno YA descarta internamente
    // los jobs "reemplazado" de la ráfaga, así que devuelve directo el único job real.
    const job = await reclamarUno(db);
    assert.ok(job, "debe quedar exactamente un job real para procesar");
    const tenant = obtenerTenantPorPhoneNumberId(job!.payload.entrante.phoneNumberId)!;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await responderEntrante({ ...job!.payload, tenant } as any, repo);
    await marcarHecho(db, job!.id);

    assert.equal(await reclamarUno(db), null, "no debe quedar OTRO job real pendiente en la cola");

    assert.equal(mock.llamadasLLM(), 1, "el agente debe correr UNA sola vez para toda la ráfaga (no 3)");
    assert.equal(mock.enviados.length, 1, "el cliente debe recibir UNA sola respuesta, no 3");

    // El prompt que vio el agente debe reflejar los 3 mensajes (historial completo),
    // no solo el primero: prueba que se releyó la conversación fresca (E5-a).
    const promptPlano = JSON.stringify(mock.solicitudesLLM[0].messages);
    for (const texto of textos) {
      assert.ok(promptPlano.includes(texto), `el prompt del agente debe incluir "${texto}"`);
    }

    // Los 2 mensajes viejos de la ráfaga quedan "reemplazado" (no generaron
    // respuesta, pero tampoco se pierden ni se reintentan como error).
    const filas = await db.select().from(waJobs).where(eq(waJobs.tenantId, tenantFallback.id));
    assert.equal(filas.filter((f) => f.estado === "reemplazado").length, 2, "los 2 mensajes viejos quedan 'reemplazado'");
    assert.equal(filas.filter((f) => f.estado === "hecho").length, 1, "el mensaje más nuevo queda 'hecho'");
  } finally {
    await cerrar();
    desactivarMockWebhook();
    TENANT_FALLBACK_SELYON.accessToken = undefined; // no dejar mutado el singleton compartido
  }
});
