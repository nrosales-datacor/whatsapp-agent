import { test } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { crearDbEfimera } from "../helpers/pgliteDb";
import { waWebhooksCrudos, waMensajes, waJobs } from "../../src/db/schema";
import { RepositorioDrizzle } from "../../src/booking/drizzleRepository";
import { ingerirEntrante } from "../../src/handleWebhook";
import { reprocesarPendientes } from "../../src/reprocesoWebhooks";
import { _registrarTenantParaTests } from "../../src/config/tenantStore";
import { cuerpoTextoEntrante } from "../helpers/webhookMock";
import { crearTenant } from "../helpers/fixtures";

// ─────────────────────────────────────────────────────────────────────────────
// ROADMAP F3 — "ningún mensaje se pierde": red de seguridad de wa_webhooks_crudos
// contra Postgres efímero (PGlite), mismo ángulo 5 de TESTING.md que
// colaDurable.test.ts. Cubre los dos motivos de descarte ANTES de F3 tiraban el
// mensaje sin dejar rastro (tenant desconocido / payload no parseable), y el
// ciclo completo alta→reproceso→procesado.
// ─────────────────────────────────────────────────────────────────────────────

test("phone_number_id desconocido: no hay Pendiente que responder, pero queda una fila 'pendiente' (no se pierde)", async () => {
  const { db, cerrar } = await crearDbEfimera();
  try {
    const repo = new RepositorioDrizzle(db);
    const pnid = "pnid-f3-desconocido";
    const body = cuerpoTextoEntrante({ phoneNumberId: pnid, clienteWa: "50600001111", texto: "hola", messageId: "wamid.f3.1" });

    const pendiente = await ingerirEntrante(body, repo, db);
    assert.equal(pendiente, null, "sin tenant no hay nada que responder ahora (el server igual contesta 200 a Meta)");

    const filas = await db.select().from(waWebhooksCrudos).where(eq(waWebhooksCrudos.phoneNumberId, pnid));
    assert.equal(filas.length, 1, "el mensaje queda guardado, no se evapora");
    assert.equal(filas[0].estado, "pendiente");
    assert.equal(filas[0].motivo, "tenant_desconocido");
    assert.equal(filas[0].waMessageId, "wamid.f3.1");
    assert.equal(filas[0].intentos, 0);
  } finally {
    await cerrar();
  }
});

test("Meta reintenta el mismo wa_message_id: no duplica la fila cruda (idempotencia)", async () => {
  const { db, cerrar } = await crearDbEfimera();
  try {
    const repo = new RepositorioDrizzle(db);
    const pnid = "pnid-f3-dup";
    const body = cuerpoTextoEntrante({ phoneNumberId: pnid, clienteWa: "50600002222", texto: "hola", messageId: "wamid.f3.dup" });

    await ingerirEntrante(body, repo, db);
    await ingerirEntrante(body, repo, db); // reintento de Meta: mismo wamid

    const filas = await db.select().from(waWebhooksCrudos).where(eq(waWebhooksCrudos.waMessageId, "wamid.f3.dup"));
    assert.equal(filas.length, 1, "el reintento no debe crear una segunda fila");
  } finally {
    await cerrar();
  }
});

test("un status (sin messages) NO genera fila en wa_webhooks_crudos: es ignorable, no un fallo de parseo", async () => {
  const { db, cerrar } = await crearDbEfimera();
  try {
    const repo = new RepositorioDrizzle(db);
    const body = {
      entry: [{ changes: [{ value: { metadata: { phone_number_id: "pnid-status" }, statuses: [{ id: "s1" }] } }] }],
    };

    const pendiente = await ingerirEntrante(body, repo, db);
    assert.equal(pendiente, null);

    const filas = await db.select().from(waWebhooksCrudos);
    assert.equal(filas.length, 0, "un status es alto volumen y no aporta nada para reprocesar: no se guarda");
  } finally {
    await cerrar();
  }
});

test("un payload con una forma que no sabemos leer SÍ genera fila pendiente (motivo no_parseable)", async () => {
  const { db, cerrar } = await crearDbEfimera();
  try {
    const repo = new RepositorioDrizzle(db);
    const body = { esto: "no tiene la forma de un webhook de whatsapp" };

    const pendiente = await ingerirEntrante(body, repo, db);
    assert.equal(pendiente, null);

    const filas = await db.select().from(waWebhooksCrudos).where(eq(waWebhooksCrudos.motivo, "no_parseable"));
    assert.equal(filas.length, 1);
    assert.equal(filas[0].estado, "pendiente");
    assert.equal(filas[0].phoneNumberId, null, "no pudimos ni extraer el phone_number_id");
  } finally {
    await cerrar();
  }
});

test("flujo completo: tenant desconocido → se da de alta → reproceso → el mensaje se procesa (wa_mensajes + wa_jobs) y la fila queda 'procesado'", async () => {
  const { db, cerrar } = await crearDbEfimera();
  try {
    const repo = new RepositorioDrizzle(db);
    const pnid = "pnid-f3-alta";
    const body = cuerpoTextoEntrante({
      phoneNumberId: pnid,
      clienteWa: "50600003333",
      texto: "quiero una cita",
      messageId: "wamid.f3.alta",
    });

    // 1) Llega el mensaje ANTES de que el negocio exista en el caché de tenants.
    const p1 = await ingerirEntrante(body, repo, db);
    assert.equal(p1, null, "todavía no hay tenant: no hay nada que responder");

    let filas = await db.select().from(waWebhooksCrudos).where(eq(waWebhooksCrudos.waMessageId, "wamid.f3.alta"));
    assert.equal(filas.length, 1);
    assert.equal(filas[0].estado, "pendiente");

    // 2) "Se da de alta" el negocio con ESE mismo phone_number_id (en producción esto
    // pasa vía crearTenant() + recargar(); acá se inyecta directo en el caché — ver
    // el comentario de _registrarTenantParaTests).
    _registrarTenantParaTests(crearTenant({ id: "tenant-f3-alta", phoneNumberId: pnid }));

    // 3) Reproceso (en producción lo dispara tenantStore.alRecargar tras recargar()).
    const resultado = await reprocesarPendientes(db, repo);
    assert.equal(resultado.procesados, 1);
    assert.equal(resultado.descartados, 0);

    filas = await db.select().from(waWebhooksCrudos).where(eq(waWebhooksCrudos.waMessageId, "wamid.f3.alta"));
    assert.equal(filas[0].estado, "procesado");

    const mensajes = await db.select().from(waMensajes).where(eq(waMensajes.waMessageId, "wamid.f3.alta"));
    assert.equal(mensajes.length, 1, "el mensaje quedó persistido en wa_mensajes");

    const jobs = await db.select().from(waJobs).where(eq(waJobs.waMessageId, "wamid.f3.alta"));
    assert.equal(jobs.length, 1, "y encolado en wa_jobs para que el worker lo responda");
  } finally {
    await cerrar();
  }
});

test("si el tenant NUNCA se da de alta, se descarta tras agotar los intentos de reproceso", async () => {
  const { db, cerrar } = await crearDbEfimera();
  try {
    const repo = new RepositorioDrizzle(db);
    const pnid = "pnid-f3-nunca";
    const body = cuerpoTextoEntrante({ phoneNumberId: pnid, clienteWa: "50600004444", texto: "hola", messageId: "wamid.f3.nunca" });
    await ingerirEntrante(body, repo, db);

    // Default de WEBHOOKS_CRUDOS_MAX_INTENTOS = 5: cada pasada de reproceso sin que
    // el tenant resuelva cuenta como un intento fallido más.
    let ultimo;
    for (let i = 0; i < 5; i++) {
      ultimo = await reprocesarPendientes(db, repo);
    }
    assert.equal(ultimo?.procesados, 0);
    assert.equal(ultimo?.descartados, 1, "la 5ª pasada agota los intentos y descarta la fila");

    const [fila] = await db.select().from(waWebhooksCrudos).where(eq(waWebhooksCrudos.waMessageId, "wamid.f3.nunca"));
    assert.equal(fila.estado, "descartado");
    assert.equal(fila.intentos, 5);
  } finally {
    await cerrar();
  }
});

test("una fila 'no_parseable' (sin phone_number_id) también se descarta tras agotar los intentos", async () => {
  const { db, cerrar } = await crearDbEfimera();
  try {
    const repo = new RepositorioDrizzle(db);
    const body = { esto: "sigue sin tener forma de whatsapp" };
    await ingerirEntrante(body, repo, db);

    let ultimo;
    for (let i = 0; i < 5; i++) {
      ultimo = await reprocesarPendientes(db, repo);
    }
    assert.equal(ultimo?.descartados, 1);

    const [fila] = await db.select().from(waWebhooksCrudos).where(eq(waWebhooksCrudos.motivo, "no_parseable"));
    assert.equal(fila.estado, "descartado");
    assert.equal(fila.intentos, 5);

    // Ninguna de las pasadas de reproceso debió crear filas nuevas (ver el comentario
    // en reprocesoWebhooks.ts sobre por qué NO se reinyecta un no_parseable sin pnid).
    const todas = await db.select().from(waWebhooksCrudos);
    assert.equal(todas.length, 1, "no se duplicó la fila en cada pasada de reproceso");
  } finally {
    await cerrar();
  }
});
