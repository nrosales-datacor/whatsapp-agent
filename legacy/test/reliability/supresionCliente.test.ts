import { test } from "node:test";
import assert from "node:assert/strict";
import { and, eq } from "drizzle-orm";
import { crearDbEfimera, type DbEfimera } from "../helpers/pgliteDb";
import {
  waAuditoria,
  waCampaniaEnvios,
  waCampanias,
  waCitas,
  waConversaciones,
  waCotizaciones,
  waEventosCalidad,
  waJobs,
  waMensajes,
  waSeguimientos,
  waUsoMensual,
  waWebhooksCrudos,
} from "../../src/db/schema";
import { borrarDatosCliente } from "../../src/config/supresionCliente";
import { crearTenant } from "../helpers/fixtures";
import { cuerpoTextoEntrante } from "../helpers/webhookMock";

// ─────────────────────────────────────────────────────────────────────────────
// Derecho de supresión de un cliente final (Ley 8968, revisión pre-venta 2026-10),
// contra Postgres efímero (PGlite). Se siembran DOS negocios con un cliente con el
// MISMO teléfono (caso real: un cliente que va a dos lavacars) más otro cliente en el
// negocio A, y se verifica que borrar al cliente en A no toca nada más.
// ─────────────────────────────────────────────────────────────────────────────

const TEL = "50688887777";
const OTRO_TEL = "50677776666";
const A = crearTenant({ id: "tenant-a", nombre: "Lavacar A", phoneNumberId: "11111" });
const B = crearTenant({ id: "tenant-b", nombre: "Lavacar B", phoneNumberId: "22222" });

/** Siembra un cliente con una fila en cada tabla que guarda algo suyo. Devuelve el id de su conversación. */
async function sembrarCliente(db: DbEfimera["db"], tenantId: string, pnid: string, tel: string, sufijo: string) {
  const [conv] = await db.insert(waConversaciones).values({ tenantId, clienteWa: tel, notas: `notas ${sufijo}` }).returning();
  await db.insert(waMensajes).values([
    { tenantId, conversacionId: conv.id, rol: "user", contenido: `hola ${sufijo}`, waMessageId: `wamid.${sufijo}` },
    { tenantId, conversacionId: conv.id, rol: "user", contenido: "[foto]", mediaUrl: `${tenantId}/${conv.id}/wamid.${sufijo}.jpg`, mediaTipo: "imagen" },
  ]);
  const [cita] = await db
    .insert(waCitas)
    .values({ tenantId, clienteWa: tel, clienteNombre: `Cliente ${sufijo}`, servicioId: "lavado", fecha: "2020-01-15", hora: "10:00" })
    .returning();
  await db.insert(waSeguimientos).values({ citaId: cita.id, tenantId });
  await db.insert(waCotizaciones).values({ tenantId, clienteWa: tel, servicioId: "pulido", monto: 25000 });
  await db.insert(waEventosCalidad).values({ tenantId, clienteWa: tel, tipo: "mensaje_ok" });
  const [camp] = await db
    .insert(waCampanias)
    .values({ tenantId, nombre: `C ${sufijo}`, mensaje: "promo", segmentoTipo: "todos", segmentoParametros: { tipo: "todos" } })
    .returning();
  await db.insert(waCampaniaEnvios).values({ campaniaId: camp.id, tenantId, clienteWa: tel, clienteNombre: `Cliente ${sufijo}` });
  await db.insert(waJobs).values({
    tenantId,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- payload mínimo, solo lo que filtra la supresión
    payload: { clase: "texto", tenantId, entrante: { phoneNumberId: pnid, clienteWa: tel, texto: "hola" }, conv: { id: conv.id } } as any,
    waMessageId: `wamid.job.${sufijo}`,
  });
  await db.insert(waWebhooksCrudos).values({
    payload: cuerpoTextoEntrante({ phoneNumberId: pnid, clienteWa: tel, texto: "hola", messageId: `wamid.crudo.${sufijo}` }),
    phoneNumberId: pnid,
    waMessageId: `wamid.crudo.${sufijo}`,
    motivo: "tenant_desconocido",
  });
  return conv.id;
}

async function filasDeCliente(db: DbEfimera["db"], tenantId: string, pnid: string, tel: string) {
  const convs = await db
    .select()
    .from(waConversaciones)
    .where(and(eq(waConversaciones.tenantId, tenantId), eq(waConversaciones.clienteWa, tel)));
  const mensajes = convs.length ? await db.select().from(waMensajes).where(eq(waMensajes.conversacionId, convs[0].id)) : [];
  const porTenantTel = async (t: typeof waCitas | typeof waCotizaciones | typeof waEventosCalidad | typeof waCampaniaEnvios) =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- las 4 tablas tienen tenantId + clienteWa
    (await db.select().from(t as any).where(and(eq((t as any).tenantId, tenantId), eq((t as any).clienteWa, tel)))).length;
  const jobs = (await db.select().from(waJobs).where(eq(waJobs.tenantId, tenantId))).filter(
    (j) => (j.payload as { entrante?: { clienteWa?: string } }).entrante?.clienteWa === tel,
  ).length;
  const crudos = (await db.select().from(waWebhooksCrudos).where(eq(waWebhooksCrudos.phoneNumberId, pnid))).filter((c) =>
    JSON.stringify(c.payload).includes(tel),
  ).length;
  return {
    conversaciones: convs.length,
    mensajes: mensajes.length,
    citas: await porTenantTel(waCitas),
    cotizaciones: await porTenantTel(waCotizaciones),
    eventosCalidad: await porTenantTel(waEventosCalidad),
    enviosCampania: await porTenantTel(waCampaniaEnvios),
    jobs,
    crudos,
  };
}

const todoEnCero = (o: Record<string, number>) => Object.values(o).every((n) => n === 0);
const nadaEnCero = (o: Record<string, number>) => Object.values(o).every((n) => n > 0);

async function sembrarEscenario(db: DbEfimera["db"]) {
  const convA = await sembrarCliente(db, A.id, A.phoneNumberId, TEL, "a1");
  await sembrarCliente(db, A.id, A.phoneNumberId, OTRO_TEL, "a2");
  const convB = await sembrarCliente(db, B.id, B.phoneNumberId, TEL, "b1");
  await db.insert(waUsoMensual).values({ tenantId: A.id, anioMes: "2026-10", conversacionesIniciadas: 3 });
  return { convA, convB };
}

test("borrar un cliente deja 0 filas suyas en todas las tablas, y no toca a otro cliente ni al mismo teléfono en otro negocio", async () => {
  const { db, cerrar } = await crearDbEfimera();
  try {
    const { convA } = await sembrarEscenario(db);
    assert.ok(nadaEnCero(await filasDeCliente(db, A.id, A.phoneNumberId, TEL)), "el seed debe cubrir todas las tablas");

    const r = await borrarDatosCliente({ tenant: A, conversacionId: convA, actor: "usuario:dueno-a", db });

    assert.ok(todoEnCero(await filasDeCliente(db, A.id, A.phoneNumberId, TEL)), "no debe quedar nada del cliente en A");
    assert.equal((await db.select().from(waSeguimientos).where(eq(waSeguimientos.tenantId, A.id))).length, 1, "solo queda el seguimiento del otro cliente");
    assert.deepEqual(r.conteos, {
      mensajes: 2,
      conversaciones: 1,
      citas: 1,
      seguimientos: 1,
      cotizaciones: 1,
      eventosCalidad: 1,
      enviosCampania: 1,
      jobs: 1,
      webhooksCrudos: 1,
    });

    assert.ok(nadaEnCero(await filasDeCliente(db, A.id, A.phoneNumberId, OTRO_TEL)), "el otro cliente de A queda intacto");
    assert.ok(nadaEnCero(await filasDeCliente(db, B.id, B.phoneNumberId, TEL)), "el mismo teléfono en B queda intacto");
    assert.equal((await db.select().from(waUsoMensual)).length, 1, "los contadores agregados no se tocan");

    const [aud] = await db.select().from(waAuditoria).where(eq(waAuditoria.tenantId, A.id));
    assert.equal(aud.accion, "borrar_cliente");
    assert.equal(aud.actor, "usuario:dueno-a");
    const detalle = JSON.stringify(aud.detalle);
    assert.ok(!detalle.includes(TEL) && !detalle.includes("hola") && !detalle.includes("Cliente"), "el registro no guarda datos personales");
  } finally {
    await cerrar();
  }
});

test("aislamiento: con el tenant A y la conversación de B no se borra nada (CLIENTE_NO_ENCONTRADO)", async () => {
  const { db, cerrar } = await crearDbEfimera();
  try {
    const { convB } = await sembrarEscenario(db);
    const antesB = await filasDeCliente(db, B.id, B.phoneNumberId, TEL);
    const antesA = await filasDeCliente(db, A.id, A.phoneNumberId, TEL);

    await assert.rejects(
      () => borrarDatosCliente({ tenant: A, conversacionId: convB, actor: "usuario:dueno-a", db }),
      (e: unknown) => e instanceof Error && e.message === "CLIENTE_NO_ENCONTRADO",
    );

    assert.deepEqual(await filasDeCliente(db, B.id, B.phoneNumberId, TEL), antesB);
    assert.deepEqual(await filasDeCliente(db, A.id, A.phoneNumberId, TEL), antesA);
    assert.equal((await db.select().from(waAuditoria)).length, 0);
  } finally {
    await cerrar();
  }
});

test("por teléfono (superadmin): borra también a un cliente que solo tenía citas manuales, sin conversación", async () => {
  const { db, cerrar } = await crearDbEfimera();
  try {
    await db
      .insert(waCitas)
      .values({ tenantId: A.id, clienteWa: "50655554444", clienteNombre: "Manual", servicioId: "lavado", fecha: "2020-02-01", hora: "09:00", origen: "manual" });
    const r = await borrarDatosCliente({ tenant: A, clienteWa: "+506 5555-4444", actor: "superadmin:admin", db });
    assert.equal(r.conversacionId, null);
    assert.equal(r.conteos.citas, 1);
    assert.equal((await db.select().from(waCitas)).length, 0);

    await assert.rejects(
      () => borrarDatosCliente({ tenant: A, clienteWa: "50600000000", actor: "superadmin:admin", db }),
      (e: unknown) => e instanceof Error && e.message === "CLIENTE_NO_ENCONTRADO",
    );
  } finally {
    await cerrar();
  }
});

test("Storage: borra el prefijo tenant/conversación del cliente (y nada de otro negocio)", async () => {
  const { db, cerrar } = await crearDbEfimera();
  const fetchOriginal = globalThis.fetch;
  process.env.SUPABASE_URL = "https://storage.test";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-test";
  const llamadas: { url: string; metodo: string; body: unknown }[] = [];
  try {
    const { convA } = await sembrarEscenario(db);
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      llamadas.push({ url: String(url), metodo: init?.method ?? "GET", body });
      if (String(url).includes("/object/list/")) {
        return new Response(JSON.stringify([{ name: "wamid.a1.jpg", id: "obj-1" }]), { status: 200 });
      }
      return new Response("[]", { status: 200 });
    }) as typeof fetch;

    const r = await borrarDatosCliente({ tenant: A, conversacionId: convA, actor: "usuario:dueno-a", db });

    assert.equal(r.archivosStorage, 1);
    const listado = llamadas.find((l) => l.url.includes("/object/list/"));
    assert.equal((listado?.body as { prefix: string }).prefix, `${A.id}/${convA}`);
    const borrado = llamadas.find((l) => l.metodo === "DELETE");
    assert.deepEqual((borrado?.body as { prefixes: string[] }).prefixes, [`${A.id}/${convA}/wamid.a1.jpg`]);
  } finally {
    globalThis.fetch = fetchOriginal;
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    await cerrar();
  }
});

test("si Storage falla, se aborta SIN tocar la base (se puede reintentar)", async () => {
  const { db, cerrar } = await crearDbEfimera();
  const fetchOriginal = globalThis.fetch;
  process.env.SUPABASE_URL = "https://storage.test";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-test";
  try {
    const { convA } = await sembrarEscenario(db);
    const antes = await filasDeCliente(db, A.id, A.phoneNumberId, TEL);
    globalThis.fetch = (async () => new Response("caído", { status: 500 })) as unknown as typeof fetch;

    await assert.rejects(
      () => borrarDatosCliente({ tenant: A, conversacionId: convA, actor: "usuario:dueno-a", db }),
      (e: unknown) => e instanceof Error && e.message === "STORAGE_FALLO",
    );
    assert.deepEqual(await filasDeCliente(db, A.id, A.phoneNumberId, TEL), antes);
  } finally {
    globalThis.fetch = fetchOriginal;
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    await cerrar();
  }
});

test("si Google Calendar falla al borrar el evento de una cita futura, se aborta SIN tocar la base", async () => {
  const { db, cerrar } = await crearDbEfimera();
  process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL = "sa@test.iam.gserviceaccount.com";
  process.env.GOOGLE_PRIVATE_KEY = "no-es-una-llave"; // firmar el JWT lanza → simula a Google caído
  try {
    const tenantCal = { ...A, googleCalendarId: "cal-a@group.calendar.google.com" };
    await db
      .insert(waCitas)
      .values({ tenantId: A.id, clienteWa: TEL, clienteNombre: "X", servicioId: "lavado", fecha: "2099-01-01", hora: "09:00", gcalEventId: "evt-1" });

    await assert.rejects(
      () => borrarDatosCliente({ tenant: tenantCal, clienteWa: TEL, actor: "superadmin:admin", db }),
      (e: unknown) => e instanceof Error && e.message === "CALENDARIO_FALLO",
    );
    assert.equal((await db.select().from(waCitas)).length, 1, "la cita sigue: nada se borró");
  } finally {
    delete process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
    delete process.env.GOOGLE_PRIVATE_KEY;
    await cerrar();
  }
});
