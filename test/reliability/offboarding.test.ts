import { test } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { crearDbEfimera, type DbEfimera } from "../helpers/pgliteDb";
import {
  waTenants,
  waUsuarios,
  waConversaciones,
  waMensajes,
  waCitas,
  waEventosCalidad,
  waPushSubs,
  waTenantsHistorial,
  waJobs,
  waCampanias,
  waCampaniaEnvios,
  waUsoMensual,
  waCotizaciones,
  waSeguimientos,
  waSnapshotReputacion,
  waWebhooksCrudos,
  waAuditoria,
} from "../../src/db/schema";
import { darDeBajaTenant } from "../../src/config/offboarding";

// ─────────────────────────────────────────────────────────────────────────────
// ROADMAP F16 — offboarding de tenant, contra Postgres efímero (PGlite), mismo
// ángulo 5 de TESTING.md que tenantsHistorial.test.ts/webhooksCrudos.test.ts.
// `darDeBajaTenant` acepta un `db` inyectado (SOLO para tests) para probar el
// export + borrado de punta a punta, en la MISMA transacción, sin mockear nada.
// ─────────────────────────────────────────────────────────────────────────────

const NOMBRE_TENANT = "Lavacar de prueba";

/** Crea un tenant con al menos una fila en CADA tabla del catálogo (más
 * wa_mensajes y wa_usuarios), para poder verificar que el offboarding las toca
 * a todas. `sufijo` distingue los datos de un tenant de los de otro en asserts. */
async function sembrarTenant(db: DbEfimera["db"], tenantId: string, nombre: string, sufijo: string) {
  await db.insert(waTenants).values({
    id: tenantId,
    nombre,
    phoneNumberId: `pnid-${tenantId}`,
    timezone: "America/Costa_Rica",
    moneda: "CRC",
    ubicacion: "San José",
    horario: {},
    servicios: [],
    kb: { faq: [], datos: [], politicas: [] },
  });

  await db.insert(waUsuarios).values({
    usuario: `usuario-${sufijo}`,
    passwordHash: "salt:hash",
    tenantId,
    rol: "dueno",
  });

  const [conv] = await db
    .insert(waConversaciones)
    .values({ tenantId, clienteWa: `506${sufijo}` })
    .returning();
  await db.insert(waMensajes).values({ conversacionId: conv.id, rol: "user", contenido: `hola ${sufijo}` });

  const [cita] = await db
    .insert(waCitas)
    .values({
      tenantId,
      clienteWa: `506${sufijo}`,
      clienteNombre: `Cliente ${sufijo}`,
      servicioId: "lavado-basico",
      fecha: "2026-01-15",
      hora: "10:00",
    })
    .returning();
  await db.insert(waSeguimientos).values({ citaId: cita.id, tenantId });

  await db.insert(waEventosCalidad).values({ tenantId, clienteWa: `506${sufijo}`, tipo: "mensaje_ok" });
  await db.insert(waPushSubs).values({ tenantId, endpoint: `https://push/${sufijo}`, p256dh: "p256dh", auth: "auth" });
  await db.insert(waTenantsHistorial).values({ tenantId, snapshot: { sufijo }, usuarioId: `usuario-${sufijo}` });
  await db.insert(waJobs).values({ tenantId, payload: { tipo: "responder_entrante" } as any });

  const [campania] = await db
    .insert(waCampanias)
    .values({
      tenantId,
      nombre: `Campaña ${sufijo}`,
      mensaje: "Promo",
      segmentoTipo: "todos",
      segmentoParametros: {} as any,
    })
    .returning();
  await db.insert(waCampaniaEnvios).values({ campaniaId: campania.id, tenantId, clienteWa: `506${sufijo}`, clienteNombre: `Cliente ${sufijo}` });

  await db.insert(waUsoMensual).values({ tenantId, anioMes: "2026-01" });
  await db.insert(waCotizaciones).values({ tenantId, clienteWa: `506${sufijo}`, servicioId: "lavado-basico", monto: 5000 });
  await db.insert(waSnapshotReputacion).values({ tenantId, fecha: "2026-01-15", rating: 4.5, totalResenas: 10 });
}

/** Cuenta las filas de un tenant en TODAS las tablas del catálogo (para verificar
 * "cero filas propias" tras la baja, sin repetir el catálogo a mano en cada test). */
async function contarFilasDeTenant(db: DbEfimera["db"], tenantId: string) {
  const conversaciones = await db.select().from(waConversaciones).where(eq(waConversaciones.tenantId, tenantId));
  const idsConv = conversaciones.map((c) => c.id);
  const mensajes = idsConv.length
    ? (await db.select().from(waMensajes)).filter((m) => idsConv.includes(m.conversacionId))
    : [];
  return {
    waTenants: (await db.select().from(waTenants).where(eq(waTenants.id, tenantId))).length,
    waUsuarios: (await db.select().from(waUsuarios).where(eq(waUsuarios.tenantId, tenantId))).length,
    waConversaciones: conversaciones.length,
    waMensajes: mensajes.length,
    waCitas: (await db.select().from(waCitas).where(eq(waCitas.tenantId, tenantId))).length,
    waEventosCalidad: (await db.select().from(waEventosCalidad).where(eq(waEventosCalidad.tenantId, tenantId))).length,
    waPushSubs: (await db.select().from(waPushSubs).where(eq(waPushSubs.tenantId, tenantId))).length,
    waTenantsHistorial: (await db.select().from(waTenantsHistorial).where(eq(waTenantsHistorial.tenantId, tenantId))).length,
    waJobs: (await db.select().from(waJobs).where(eq(waJobs.tenantId, tenantId))).length,
    waCampanias: (await db.select().from(waCampanias).where(eq(waCampanias.tenantId, tenantId))).length,
    waCampaniaEnvios: (await db.select().from(waCampaniaEnvios).where(eq(waCampaniaEnvios.tenantId, tenantId))).length,
    waUsoMensual: (await db.select().from(waUsoMensual).where(eq(waUsoMensual.tenantId, tenantId))).length,
    waCotizaciones: (await db.select().from(waCotizaciones).where(eq(waCotizaciones.tenantId, tenantId))).length,
    waSeguimientos: (await db.select().from(waSeguimientos).where(eq(waSeguimientos.tenantId, tenantId))).length,
    waSnapshotReputacion: (await db.select().from(waSnapshotReputacion).where(eq(waSnapshotReputacion.tenantId, tenantId))).length,
  };
}

function todasEnCero(conteo: Record<string, number>) {
  return Object.values(conteo).every((n) => n === 0);
}

function ningunaEnCero(conteo: Record<string, number>) {
  return Object.values(conteo).every((n) => n > 0);
}

test("dar de baja un tenant deja 0 filas suyas en TODAS las tablas del catálogo", async () => {
  const { db, cerrar } = await crearDbEfimera();
  try {
    const tenantId = "tenant-f16-1";
    await sembrarTenant(db, tenantId, NOMBRE_TENANT, "a");

    const antes = await contarFilasDeTenant(db, tenantId);
    assert.ok(ningunaEnCero(antes), "el seed debe dejar al menos una fila en cada tabla, si no el test no prueba nada");

    await darDeBajaTenant(tenantId, NOMBRE_TENANT, db);

    const despues = await contarFilasDeTenant(db, tenantId);
    assert.ok(todasEnCero(despues), `debían quedar 0 filas en todas las tablas: ${JSON.stringify(despues)}`);
  } finally {
    await cerrar();
  }
});

test("el export devuelto contiene los datos de ANTES del borrado, no vacío", async () => {
  const { db, cerrar } = await crearDbEfimera();
  try {
    const tenantId = "tenant-f16-2";
    await sembrarTenant(db, tenantId, NOMBRE_TENANT, "b");

    const exportado = await darDeBajaTenant(tenantId, NOMBRE_TENANT, db);

    assert.equal(exportado.waTenants.id, tenantId);
    assert.equal(exportado.waTenants.nombre, NOMBRE_TENANT);
    assert.equal(exportado.waUsuarios.length, 1);
    assert.equal(exportado.waConversaciones.length, 1);
    assert.equal(exportado.waMensajes.length, 1);
    assert.equal(exportado.waMensajes[0].contenido, "hola b");
    assert.equal(exportado.waCitas.length, 1);
    assert.equal(exportado.waEventosCalidad.length, 1);
    assert.equal(exportado.waPushSubs.length, 1);
    assert.equal(exportado.waTenantsHistorial.length, 1);
    assert.equal(exportado.waJobs.length, 1);
    assert.equal(exportado.waCampanias.length, 1);
    assert.equal(exportado.waCampaniaEnvios.length, 1);
    assert.equal(exportado.waUsoMensual.length, 1);
    assert.equal(exportado.waCotizaciones.length, 1);
    assert.equal(exportado.waSeguimientos.length, 1);
    assert.equal(exportado.waSnapshotReputacion.length, 1);
  } finally {
    await cerrar();
  }
});

test("sin la confirmación correcta no borra nada (ni siquiera arma el export)", async () => {
  const { db, cerrar } = await crearDbEfimera();
  try {
    const tenantId = "tenant-f16-3";
    await sembrarTenant(db, tenantId, NOMBRE_TENANT, "c");
    const antes = await contarFilasDeTenant(db, tenantId);

    await assert.rejects(
      () => darDeBajaTenant(tenantId, "Nombre incorrecto", db),
      (e: unknown) => e instanceof Error && e.message === "CONFIRMACION_INVALIDA",
    );

    const despues = await contarFilasDeTenant(db, tenantId);
    assert.deepEqual(despues, antes, "nada debía cambiar tras una confirmación inválida");
  } finally {
    await cerrar();
  }
});

test("un tenantId inexistente lanza TENANT_NO_ENCONTRADO sin tocar nada", async () => {
  const { db, cerrar } = await crearDbEfimera();
  try {
    await assert.rejects(
      () => darDeBajaTenant("tenant-que-no-existe", "cualquiera", db),
      (e: unknown) => e instanceof Error && e.message === "TENANT_NO_ENCONTRADO",
    );
  } finally {
    await cerrar();
  }
});

test("dar de baja un tenant NO toca los datos de OTRO tenant", async () => {
  const { db, cerrar } = await crearDbEfimera();
  try {
    const tenantA = "tenant-f16-5a";
    const tenantB = "tenant-f16-5b";
    await sembrarTenant(db, tenantA, "Negocio A", "5a");
    await sembrarTenant(db, tenantB, "Negocio B", "5b");

    const antesB = await contarFilasDeTenant(db, tenantB);
    assert.ok(ningunaEnCero(antesB));

    await darDeBajaTenant(tenantA, "Negocio A", db);

    const despuesA = await contarFilasDeTenant(db, tenantA);
    assert.ok(todasEnCero(despuesA), "A debe quedar en cero");

    const despuesB = await contarFilasDeTenant(db, tenantB);
    assert.deepEqual(despuesB, antesB, "B no debe verse afectado por la baja de A");
  } finally {
    await cerrar();
  }
});

// ── Revisión pre-venta 2026-10: la baja también limpia wa_webhooks_crudos de su
// número y las fotos de Storage, y deja un rastro en wa_auditoria (que NO se borra) ──

test("la baja borra (y exporta) los wa_webhooks_crudos de SU phone_number_id, no los de otro número", async () => {
  const { db, cerrar } = await crearDbEfimera();
  try {
    const tenantId = "tenant-f16-6";
    await sembrarTenant(db, tenantId, NOMBRE_TENANT, "6");
    await db.insert(waWebhooksCrudos).values([
      { payload: { de: "cliente" }, phoneNumberId: `pnid-${tenantId}`, waMessageId: "wamid.6a", motivo: "tenant_desconocido" },
      { payload: { de: "otro" }, phoneNumberId: "pnid-de-otro", waMessageId: "wamid.6b", motivo: "tenant_desconocido" },
    ]);

    const exportado = await darDeBajaTenant(tenantId, NOMBRE_TENANT, db);

    assert.equal(exportado.waWebhooksCrudos.length, 1, "el crudo propio va en el export");
    const restantes = await db.select().from(waWebhooksCrudos);
    assert.deepEqual(restantes.map((r) => r.phoneNumberId), ["pnid-de-otro"]);

    const [aud] = await db.select().from(waAuditoria).where(eq(waAuditoria.tenantId, tenantId));
    assert.equal(aud.accion, "baja_tenant", "queda el rastro de la baja (wa_auditoria no se borra)");
  } finally {
    await cerrar();
  }
});

test("la baja borra el prefijo del tenant en Supabase Storage; si Storage falla, la baja queda hecha y se registra el pendiente", async () => {
  const { db, cerrar } = await crearDbEfimera();
  const fetchOriginal = globalThis.fetch;
  process.env.SUPABASE_URL = "https://storage.test";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-test";
  try {
    const llamadas: { url: string; body: { prefix?: string; prefixes?: string[] } | null; metodo: string }[] = [];
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      llamadas.push({ url: String(url), body, metodo: init?.method ?? "GET" });
      if (String(url).includes("/object/list/")) {
        // Raíz del tenant: una carpeta (conversación); dentro: una foto.
        if (body.prefix === "tenant-f16-7") return new Response(JSON.stringify([{ name: "conv-1", id: null }]), { status: 200 });
        return new Response(JSON.stringify([{ name: "wamid.jpg", id: "obj" }]), { status: 200 });
      }
      return new Response("[]", { status: 200 });
    }) as unknown as typeof fetch;

    await sembrarTenant(db, "tenant-f16-7", NOMBRE_TENANT, "7");
    await darDeBajaTenant("tenant-f16-7", NOMBRE_TENANT, db);
    const borrado = llamadas.find((l) => l.metodo === "DELETE");
    assert.deepEqual(borrado?.body?.prefixes, ["tenant-f16-7/conv-1/wamid.jpg"]);

    // Storage caído: la baja en la base igual se confirma y queda el pendiente auditado.
    globalThis.fetch = (async () => new Response("caído", { status: 503 })) as unknown as typeof fetch;
    await sembrarTenant(db, "tenant-f16-8", "Otro negocio", "8");
    await darDeBajaTenant("tenant-f16-8", "Otro negocio", db);
    assert.equal((await db.select().from(waTenants).where(eq(waTenants.id, "tenant-f16-8"))).length, 0);
    const acciones = (await db.select().from(waAuditoria).where(eq(waAuditoria.tenantId, "tenant-f16-8"))).map((a) => a.accion).sort();
    assert.deepEqual(acciones, ["baja_storage_pendiente", "baja_tenant"]);
  } finally {
    globalThis.fetch = fetchOriginal;
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    await cerrar();
  }
});
