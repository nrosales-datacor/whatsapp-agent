import "../helpers/setupEnv"; // PRIMERO: fija OPENAI_API_KEY antes de importar handleWebhook
import { test } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { crearDbEfimera } from "../helpers/pgliteDb";
import { waJobs, waMensajes } from "../../src/db/schema";
import { RepositorioDrizzle } from "../../src/booking/drizzleRepository";
import { ingerirEntrante, responderEntrante, type Pendiente } from "../../src/handleWebhook";
import { _registrarTenantParaTests } from "../../src/config/tenantStore";
import { incrementarUso, anioMesActual } from "../../src/observabilidad/uso";
import { _resetParaTests as _resetRateLimitParaTests } from "../../src/red/limiteIngesta";
import { crearTenant } from "../helpers/fixtures";
import { cuerpoTextoEntrante, desactivarMockWebhook, instalarMockWebhook } from "../helpers/webhookMock";

// ─────────────────────────────────────────────────────────────────────────────
// F10 (PLAN-ESCALA-MULTITENANT.md) contra Postgres efímero (PGlite), mismo ángulo
// 5 de TESTING.md que colaDurable.test.ts/webhooksCrudos.test.ts:
//
//   1) rate limit de ingesta excedido → el mensaje NO se pierde (F3 sigue
//      garantizado): se persiste igual y el job queda con `ejecutar_despues_de`
//      diferido en vez de perderse o rechazarse.
//   2) tope mensual al 100% → el bot deja de llamar al LLM para ese tenant,
//      escala a humano, y el cliente igual recibe un mensaje (nunca silencio).
//   3) el mensaje de tope es configurable por tenant.
//   4) el interruptor por tenant anula el tope aunque el consumo lo supere.
// ─────────────────────────────────────────────────────────────────────────────

test("F10 — rate limit: agotado el burst del tenant, el siguiente mensaje NO se pierde (se persiste y el job queda diferido)", async () => {
  _resetRateLimitParaTests();
  const { db, cerrar } = await crearDbEfimera();
  try {
    const repo = new RepositorioDrizzle(db);
    const pnid = "pnid-f10-rate";
    _registrarTenantParaTests(crearTenant({ id: "tenant-f10-rate", phoneNumberId: pnid, plan: "basico" }));

    // Agota el burst (default RATE_LIMIT_INGESTA_BASICO_CAPACIDAD = 20).
    for (let i = 0; i < 20; i++) {
      const body = cuerpoTextoEntrante({
        phoneNumberId: pnid,
        clienteWa: "50600009999",
        texto: `mensaje ${i}`,
        messageId: `wamid.rate.${i}`,
      });
      const p = await ingerirEntrante(body, repo, db);
      assert.ok(p, `mensaje ${i} debía procesarse dentro del burst`);
    }

    const antes = Date.now();
    const bodyExcedido = cuerpoTextoEntrante({
      phoneNumberId: pnid,
      clienteWa: "50600009999",
      texto: "este mensaje excede el burst",
      messageId: "wamid.rate.excedido",
    });
    await ingerirEntrante(bodyExcedido, repo, db);

    // El mensaje quedó persistido en wa_mensajes: NUNCA se pierde (F3), aunque
    // haya excedido el rate limit.
    const mensajes = await db.select().from(waMensajes).where(eq(waMensajes.waMessageId, "wamid.rate.excedido"));
    assert.equal(mensajes.length, 1, "el mensaje debe quedar persistido aunque exceda el rate limit");

    // El job quedó encolado, pero con ejecutar_despues_de en el FUTURO (diferido):
    // se degrada la latencia, no la entrega.
    const jobs = await db.select().from(waJobs).where(eq(waJobs.waMessageId, "wamid.rate.excedido"));
    assert.equal(jobs.length, 1, "el job debe quedar encolado igual");
    assert.ok(
      jobs[0].ejecutarDespuesDe.getTime() > antes,
      "ejecutar_despues_de debe quedar en el futuro (diferido), no disponible de inmediato para el worker",
    );
  } finally {
    await cerrar();
  }
});

test("F10 — rate limit: un tenant DISTINTO no se ve afectado por el burst agotado de otro", async () => {
  _resetRateLimitParaTests();
  const { db, cerrar } = await crearDbEfimera();
  try {
    const repo = new RepositorioDrizzle(db);
    _registrarTenantParaTests(crearTenant({ id: "tenant-f10-rate-a", phoneNumberId: "pnid-f10-rate-a", plan: "basico" }));
    _registrarTenantParaTests(crearTenant({ id: "tenant-f10-rate-b", phoneNumberId: "pnid-f10-rate-b", plan: "basico" }));

    for (let i = 0; i < 20; i++) {
      const body = cuerpoTextoEntrante({
        phoneNumberId: "pnid-f10-rate-a",
        clienteWa: "50600001111",
        texto: `mensaje ${i}`,
        messageId: `wamid.rate.a.${i}`,
      });
      await ingerirEntrante(body, repo, db);
    }

    const antes = Date.now();
    const bodyB = cuerpoTextoEntrante({
      phoneNumberId: "pnid-f10-rate-b",
      clienteWa: "50600002222",
      texto: "hola",
      messageId: "wamid.rate.b.1",
    });
    await ingerirEntrante(bodyB, repo, db);

    const jobs = await db.select().from(waJobs).where(eq(waJobs.waMessageId, "wamid.rate.b.1"));
    assert.equal(jobs.length, 1);
    assert.ok(
      jobs[0].ejecutarDespuesDe.getTime() <= antes + 50,
      "el job del tenant B no debe quedar diferido: su balde está lleno, el límite es por tenant",
    );
  } finally {
    await cerrar();
  }
});

test("F10 — tope mensual al 100%: el bot NO llama al LLM, escala a humano, y el cliente recibe el mensaje default de tope", async () => {
  const { db, cerrar } = await crearDbEfimera();
  try {
    const mock = instalarMockWebhook();
    const repo = new RepositorioDrizzle(db);
    const tenant = crearTenant({
      id: "tenant-f10-tope",
      phoneNumberId: "pnid-f10-tope",
      plan: "basico",
      accessToken: "test-token",
    });

    // Deja el uso mensual del tenant EXACTO en el tope de Básico (default 500,
    // TOPE_CONVERSACIONES_MES en src/billing/planes.ts).
    await incrementarUso(db, tenant.id, anioMesActual(), { conversacionesIniciadas: 500 });

    const conv = await repo.obtenerOConversacion(tenant.id, "50600001234");
    const pendiente: Pendiente = {
      clase: "texto",
      tenant,
      conv,
      primerContacto: false,
      historialPrevio: [],
      entrante: {
        phoneNumberId: tenant.phoneNumberId,
        clienteWa: "50600001234",
        texto: "hola, una consulta",
        esTexto: true,
        messageId: "wamid.tope.1",
      },
    };

    await responderEntrante(pendiente, repo, db);

    assert.equal(mock.llamadasLLM(), 0, "no debe invocar al LLM: el tenant ya agotó su tope mensual");
    assert.equal(await repo.obtenerModo(tenant.id, conv.id), "humano", "debe escalar la conversación a humano");
    assert.equal(mock.enviados.length, 1, "el cliente SIEMPRE recibe algo (nunca silencio)");
    // Texto neutro: al cliente final no se le menciona el límite del plan del negocio.
    assert.match(mock.enviados[0].texto ?? "", /te atiende alguien del equipo/i);
    assert.doesNotMatch(mock.enviados[0].texto ?? "", /límite/i);
  } finally {
    desactivarMockWebhook();
    await cerrar();
  }
});

test("F10 — tope mensual: el mensaje al cliente es configurable por tenant (mensajeTopeExcedido)", async () => {
  const { db, cerrar } = await crearDbEfimera();
  try {
    const mock = instalarMockWebhook();
    const repo = new RepositorioDrizzle(db);
    const tenant = crearTenant({
      id: "tenant-f10-tope-custom",
      phoneNumberId: "pnid-f10-tope-custom",
      plan: "basico",
      accessToken: "test-token",
      mensajeTopeExcedido: "Estamos a full este mes 🚗 Te escribe alguien del equipo en breve.",
    });
    await incrementarUso(db, tenant.id, anioMesActual(), { conversacionesIniciadas: 500 });

    const conv = await repo.obtenerOConversacion(tenant.id, "50600004321");
    const pendiente: Pendiente = {
      clase: "texto",
      tenant,
      conv,
      primerContacto: false,
      historialPrevio: [],
      entrante: {
        phoneNumberId: tenant.phoneNumberId,
        clienteWa: "50600004321",
        texto: "buenas",
        esTexto: true,
        messageId: "wamid.tope.custom.1",
      },
    };

    await responderEntrante(pendiente, repo, db);

    assert.equal(mock.llamadasLLM(), 0);
    assert.equal(mock.enviados[0].texto, "Estamos a full este mes 🚗 Te escribe alguien del equipo en breve.");
  } finally {
    desactivarMockWebhook();
    await cerrar();
  }
});

test("F10 — interruptor por tenant: aunque supere el tope de su plan, el LLM se sigue llamando (contrato especial)", async () => {
  const { db, cerrar } = await crearDbEfimera();
  try {
    const mock = instalarMockWebhook();
    mock.programarLLM({ texto: "Respuesta normal del bot, sin restricción." });
    const repo = new RepositorioDrizzle(db);
    const tenant = crearTenant({
      id: "tenant-f10-interruptor",
      phoneNumberId: "pnid-f10-interruptor",
      plan: "basico",
      accessToken: "test-token",
      topeConversacionesDesactivado: true,
    });
    // Muy por encima del tope normal de Básico (500) — el interruptor debe anularlo igual.
    await incrementarUso(db, tenant.id, anioMesActual(), { conversacionesIniciadas: 2000 });

    const conv = await repo.obtenerOConversacion(tenant.id, "50600005555");
    const pendiente: Pendiente = {
      clase: "texto",
      tenant,
      conv,
      primerContacto: false,
      historialPrevio: [],
      entrante: {
        phoneNumberId: tenant.phoneNumberId,
        clienteWa: "50600005555",
        texto: "quiero una cita",
        esTexto: true,
        messageId: "wamid.interruptor.1",
      },
    };

    await responderEntrante(pendiente, repo, db);

    assert.equal(mock.llamadasLLM(), 1, "el interruptor debe anular el tope: el bot sigue usando el LLM normalmente");
    assert.equal(await repo.obtenerModo(tenant.id, conv.id), "bot", "no debe escalar a humano: el tope no aplica");
    assert.equal(mock.enviados[0].texto, "Respuesta normal del bot, sin restricción.");
  } finally {
    desactivarMockWebhook();
    await cerrar();
  }
});
