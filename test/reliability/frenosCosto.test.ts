import "../helpers/setupEnv"; // PRIMERO: fija OPENAI_API_KEY antes de importar handleWebhook
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { and, eq, like } from "drizzle-orm";
import { crearDbEfimera } from "../helpers/pgliteDb";
import { waMensajes } from "../../src/db/schema";
import { RepositorioDrizzle } from "../../src/booking/drizzleRepository";
import { RepositorioEnMemoria } from "../../src/booking/inMemoryRepository";
import { ingerirEntrante, responderEntrante, type Pendiente } from "../../src/handleWebhook";
import { _registrarTenantParaTests } from "../../src/config/tenantStore";
import { incrementarUso, anioMesActual } from "../../src/observabilidad/uso";
import { _resetParaTests as _resetRateLimitParaTests } from "../../src/red/limiteIngesta";
import { PREFIJO_AVISO_LIMITE } from "../../src/red/limiteCliente";
import { textoCliente } from "../../src/config/textos";
import type { Conversacion, Repositorio, Tenant } from "../../src/types";
import { crearTenant } from "../helpers/fixtures";
import { cuerpoTextoEntrante, desactivarMockWebhook, instalarMockWebhook } from "../helpers/webhookMock";

// ─────────────────────────────────────────────────────────────────────────────
// Techo de costo de OpenAI (revisión pre-venta 2026-10) contra Postgres efímero
// (PGlite), por la misma puerta que usa el worker (`responderEntrante(p, repo, db)`):
//
//   1) límite de turnos del bot por cliente final y por hora: no llama al LLM,
//      avisa UNA sola vez (también con dos réplicas a la vez), es por cliente y la
//      ventana es deslizante;
//   2) bucle bot-a-bot: el mismo texto repetido pausa el bot sin contestarle al
//      otro bot; una ráfaga humana normal no dispara nada;
//   3) tope mensual de gasto de LLM en USD por plan: al 100% no llama al LLM,
//      responde un texto neutro y pasa a humano; el Pro tiene más margen.
// ─────────────────────────────────────────────────────────────────────────────

afterEach(() => desactivarMockWebhook());

const HORA_MS = 60 * 60 * 1000;

function pendiente(tenant: Tenant, conv: Conversacion, clienteWa: string, texto: string, messageId: string): Pendiente {
  return {
    clase: "texto",
    tenant,
    conv,
    primerContacto: false,
    historialPrevio: [],
    entrante: { phoneNumberId: tenant.phoneNumberId, clienteWa, texto, esTexto: true, messageId },
  };
}

/** Simula `n` respuestas YA dadas por el bot (recientes: creado_en = now() de la base). */
async function sembrarTurnosBot(repo: Repositorio, tenant: Tenant, convId: string, n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    await repo.guardarMensaje(tenant.id, convId, { rol: "assistant", contenido: `respuesta ${i}`, creadoEn: new Date().toISOString() });
  }
}

test("límite por cliente: con 30 respuestas del bot en la última hora NO llama al LLM, avisa UNA vez y no cambia el modo", async () => {
  const { db, cerrar } = await crearDbEfimera();
  try {
    const mock = instalarMockWebhook();
    const repo = new RepositorioDrizzle(db);
    const tenant = crearTenant({ id: "tenant-freno-1", phoneNumberId: "pnid-freno-1", accessToken: "test-token" });
    const conv = await repo.obtenerOConversacion(tenant.id, "50600000001");
    await sembrarTurnosBot(repo, tenant, conv.id, 30); // default LIMITE_CLIENTE_MENSAJES_HORA = 30

    await responderEntrante(pendiente(tenant, conv, "50600000001", "hola otra vez", "wamid.freno.1"), repo, db);
    assert.equal(mock.llamadasLLM(), 0, "pasado el límite no se llama al LLM");
    assert.equal(mock.enviados.length, 1, "el cliente recibe el aviso");
    assert.equal(mock.enviados[0].texto, textoCliente(tenant, "limiteCliente"));
    assert.equal(await repo.obtenerModo(tenant.id, conv.id), "bot", "el límite no pasa la conversación a humano");

    // Siguiente mensaje dentro de la misma hora: silencio total (ni LLM ni segundo aviso).
    await responderEntrante(pendiente(tenant, conv, "50600000001", "???", "wamid.freno.2"), repo, db);
    assert.equal(mock.llamadasLLM(), 0);
    assert.equal(mock.enviados.length, 1, "el aviso se manda UNA sola vez");

    const avisos = await db
      .select()
      .from(waMensajes)
      .where(and(eq(waMensajes.conversacionId, conv.id), like(waMensajes.waMessageId, `${PREFIJO_AVISO_LIMITE}%`)));
    assert.equal(avisos.length, 1, "el aviso queda en el historial (visible en el panel) una sola vez");

    // Es POR CLIENTE: otro cliente del mismo negocio sigue atendido por el bot.
    mock.programarLLM({ texto: "¡Hola! ¿En qué te ayudo?" });
    const otra = await repo.obtenerOConversacion(tenant.id, "50600000002");
    await responderEntrante(pendiente(tenant, otra, "50600000002", "hola", "wamid.freno.otro"), repo, db);
    assert.equal(mock.llamadasLLM(), 1);
    assert.equal(mock.enviados.at(-1)?.texto, "¡Hola! ¿En qué te ayudo?");
  } finally {
    await cerrar();
  }
});

test("límite por cliente: dos réplicas procesando a la vez mandan UN solo aviso (reclamo atómico en Postgres)", async () => {
  const { db, cerrar } = await crearDbEfimera();
  try {
    const mock = instalarMockWebhook();
    const repoA = new RepositorioDrizzle(db);
    const repoB = new RepositorioDrizzle(db); // "otra réplica": otro repositorio, misma base
    const tenant = crearTenant({ id: "tenant-freno-2", phoneNumberId: "pnid-freno-2", accessToken: "test-token" });
    const conv = await repoA.obtenerOConversacion(tenant.id, "50600000003");
    await sembrarTurnosBot(repoA, tenant, conv.id, 30);

    await Promise.all([
      responderEntrante(pendiente(tenant, conv, "50600000003", "uno", "wamid.freno.r1"), repoA, db),
      responderEntrante(pendiente(tenant, conv, "50600000003", "dos", "wamid.freno.r2"), repoB, db),
    ]);
    assert.equal(mock.llamadasLLM(), 0);
    assert.equal(mock.enviados.length, 1, "solo la réplica que gana el INSERT del aviso lo manda");
  } finally {
    await cerrar();
  }
});

test("límite por cliente: la ventana es deslizante — respuestas de hace más de una hora no cuentan", async () => {
  const { db, cerrar } = await crearDbEfimera();
  try {
    const mock = instalarMockWebhook();
    mock.programarLLM({ texto: "Claro, te ayudo." });
    const repo = new RepositorioDrizzle(db);
    const tenant = crearTenant({ id: "tenant-freno-3", phoneNumberId: "pnid-freno-3", accessToken: "test-token" });
    const conv = await repo.obtenerOConversacion(tenant.id, "50600000004");
    // 30 respuestas de hace 2 h (ya fuera de la ventana) + 29 recientes: por debajo del límite.
    const viejo = new Date(Date.now() - 2 * HORA_MS);
    await db.insert(waMensajes).values(
      Array.from({ length: 30 }, (_, i) => ({ conversacionId: conv.id, rol: "assistant", contenido: `vieja ${i}`, creadoEn: viejo })),
    );
    await sembrarTurnosBot(repo, tenant, conv.id, 29);

    await responderEntrante(pendiente(tenant, conv, "50600000004", "una consulta", "wamid.freno.3"), repo, db);
    assert.equal(mock.llamadasLLM(), 1, "con 29 en la última hora el bot sigue respondiendo");
    assert.equal(mock.enviados[0].texto, "Claro, te ayudo.");
  } finally {
    await cerrar();
  }
});

test("límite por cliente: sin DB (repositorio en memoria) aplica igual", async () => {
  const mock = instalarMockWebhook();
  const repo = new RepositorioEnMemoria();
  const tenant = crearTenant({ id: "tenant-freno-mem", phoneNumberId: "pnid-freno-mem", accessToken: "test-token" });
  const conv = await repo.obtenerOConversacion(tenant.id, "50600000005");
  await sembrarTurnosBot(repo, tenant, conv.id, 30);

  await responderEntrante(pendiente(tenant, conv, "50600000005", "hola", "wamid.freno.mem.1"), repo);
  await responderEntrante(pendiente(tenant, conv, "50600000005", "hola?", "wamid.freno.mem.2"), repo);
  assert.equal(mock.llamadasLLM(), 0);
  assert.equal(mock.enviados.length, 1);
  assert.equal(mock.enviados[0].texto, textoCliente(tenant, "limiteCliente"));
});

test("bucle bot-a-bot: la misma respuesta automática 5 veces pausa el bot (modo humano) SIN contestarle al otro bot", async () => {
  _resetRateLimitParaTests();
  const { db, cerrar } = await crearDbEfimera();
  try {
    const mock = instalarMockWebhook();
    const repo = new RepositorioDrizzle(db);
    const tenant = crearTenant({ id: "tenant-bucle", phoneNumberId: "pnid-bucle", accessToken: "test-token" });
    _registrarTenantParaTests(tenant);
    const auto = "Gracias por escribir a Repuestos El Sol. Te responderemos a la brevedad.";

    let ultimo: Pendiente | null = null;
    for (let i = 0; i < 5; i++) {
      const body = cuerpoTextoEntrante({ phoneNumberId: tenant.phoneNumberId, clienteWa: "50600000006", texto: auto, messageId: `wamid.bucle.${i}` });
      ultimo = await ingerirEntrante(body, repo, db);
    }
    assert.ok(ultimo);
    await responderEntrante(ultimo, repo, db);

    assert.equal(mock.llamadasLLM(), 0, "no se gasta en el LLM para contestarle a otro bot");
    assert.equal(mock.enviados.length, 0, "no se le manda nada: cualquier mensaje alimentaría el bucle");
    assert.equal(await repo.obtenerModo(tenant.id, ultimo.conv.id), "humano", "el bot queda en pausa en esa conversación");
    const mensajes = await db.select().from(waMensajes).where(eq(waMensajes.conversacionId, ultimo.conv.id));
    assert.equal(mensajes.filter((m) => m.rol === "user").length, 5, "los mensajes igual quedan guardados para el panel");
  } finally {
    await cerrar();
  }
});

test("bucle bot-a-bot: una ráfaga humana normal (3 mensajes seguidos) NO pausa el bot", async () => {
  _resetRateLimitParaTests();
  const { db, cerrar } = await crearDbEfimera();
  try {
    const mock = instalarMockWebhook();
    mock.programarLLM({ texto: "¡Con gusto! ¿Para qué día?" });
    const repo = new RepositorioDrizzle(db);
    const tenant = crearTenant({ id: "tenant-rafaga", phoneNumberId: "pnid-rafaga", accessToken: "test-token" });
    _registrarTenantParaTests(tenant);

    let ultimo: Pendiente | null = null;
    for (const [i, texto] of ["hola", "hola", "quiero agendar un lavado"].entries()) {
      const body = cuerpoTextoEntrante({ phoneNumberId: tenant.phoneNumberId, clienteWa: "50600000007", texto, messageId: `wamid.rafaga.${i}` });
      ultimo = await ingerirEntrante(body, repo, db);
    }
    assert.ok(ultimo);
    await responderEntrante(ultimo, repo, db);

    assert.equal(mock.llamadasLLM(), 1);
    assert.equal(await repo.obtenerModo(tenant.id, ultimo.conv.id), "bot");
    // Primer contacto: lleva el aviso de bot antepuesto; lo que importa es que respondió.
    assert.match(mock.enviados[0].texto ?? "", /¡Con gusto! ¿Para qué día\?$/);
  } finally {
    await cerrar();
  }
});

test("tope de gasto LLM: Básico al 100% del tope en USD → sin LLM, texto neutro y pasa a humano", async () => {
  const { db, cerrar } = await crearDbEfimera();
  try {
    const mock = instalarMockWebhook();
    const repo = new RepositorioDrizzle(db);
    const tenant = crearTenant({ id: "tenant-gasto-b", phoneNumberId: "pnid-gasto-b", plan: "basico", accessToken: "test-token" });
    // USD 15 = tope default de Básico (TOPE_GASTO_LLM_USD_MES en billing/planes.ts), con
    // pocas conversaciones: el tope de conversaciones NO está alcanzado.
    await incrementarUso(db, tenant.id, anioMesActual(), { conversacionesIniciadas: 3, costoEstimadoMillonesimos: 15_000_000 });
    const conv = await repo.obtenerOConversacion(tenant.id, "50600000008");

    await responderEntrante(pendiente(tenant, conv, "50600000008", "hola, ¿precio del pulido?", "wamid.gasto.b"), repo, db);

    assert.equal(mock.llamadasLLM(), 0, "al 100% del gasto el bot deja de llamar al LLM");
    assert.equal(await repo.obtenerModo(tenant.id, conv.id), "humano");
    assert.equal(mock.enviados.length, 1, "nunca silencio: el cliente recibe algo");
    assert.match(mock.enviados[0].texto ?? "", /en un momento te atiende/i);
    assert.doesNotMatch(mock.enviados[0].texto ?? "", /límite|tope|USD/i, "texto neutro: no le habla de límites al cliente final");
  } finally {
    await cerrar();
  }
});

test("tope de gasto LLM: el Pro con el mismo gasto sigue con el bot (su tope es más alto)", async () => {
  const { db, cerrar } = await crearDbEfimera();
  try {
    const mock = instalarMockWebhook();
    mock.programarLLM({ texto: "El pulido cuesta ₡25.000." });
    const repo = new RepositorioDrizzle(db);
    const tenant = crearTenant({ id: "tenant-gasto-p", phoneNumberId: "pnid-gasto-p", plan: "pro", accessToken: "test-token" });
    await incrementarUso(db, tenant.id, anioMesActual(), { costoEstimadoMillonesimos: 15_000_000 });
    const conv = await repo.obtenerOConversacion(tenant.id, "50600000009");

    await responderEntrante(pendiente(tenant, conv, "50600000009", "¿precio del pulido?", "wamid.gasto.p"), repo, db);
    assert.equal(mock.llamadasLLM(), 1);
    assert.equal(await repo.obtenerModo(tenant.id, conv.id), "bot");

    // Al llegar a su propio tope (USD 40) también se corta.
    await incrementarUso(db, tenant.id, anioMesActual(), { costoEstimadoMillonesimos: 25_000_000 });
    await responderEntrante(pendiente(tenant, conv, "50600000009", "¿y el lavado?", "wamid.gasto.p2"), repo, db);
    assert.equal(mock.llamadasLLM(), 1, "con USD 40 el Pro también deja de llamar al LLM");
    assert.equal(await repo.obtenerModo(tenant.id, conv.id), "humano");
  } finally {
    await cerrar();
  }
});
