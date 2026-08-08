import { test } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { crearDbEfimera } from "../helpers/pgliteDb";
import { waTenants, waTenantsHistorial } from "../../src/db/schema";
import {
  actualizarConfigTenant,
  listarHistorialConfigTenant,
  restaurarVersionConfigTenant,
  type ConfigTenantPatch,
} from "../../src/config/tenantStore";

// ─────────────────────────────────────────────────────────────────────────────
// ROADMAP F15 — config del tenant versionada y auditada, contra Postgres efímero
// (PGlite), mismo ángulo 5 de TESTING.md que webhooksCrudos.test.ts/colaDurable.test.ts.
// `actualizarConfigTenant` acepta un `db` inyectado (SOLO para tests: en producción
// siempre usa el pool singleton de obtenerDb(), que no puede apuntar a PGlite) para
// poder probar el UPDATE + INSERT de historial de punta a punta, en la MISMA
// transacción, sin mockear nada.
// ─────────────────────────────────────────────────────────────────────────────

function patchBase(overrides: Partial<ConfigTenantPatch> = {}): ConfigTenantPatch {
  return {
    horario: {},
    servicios: [],
    kb: { faq: [], datos: [], politicas: [] },
    bloqueos: [],
    empleados: [],
    linkResenas: null,
    plantillaMarketing: null,
    plantillaReapertura: null,
    plantillaRecordatorio: null,
    plantillaIdioma: null,
    colorAcento: null,
    colorHeader: null,
    logoUrl: null,
    rescateActivo: false,
    rescateHorasEspera: 3,
    rescateToque1Texto: null,
    rescateToque2Texto: null,
    rescatePlantilla: null,
    googlePlaceId: null,
    googleCalendarId: null,
    tipoNegocio: null,
    pais: null,
    formasPago: null,
    registro: null,
    tono: null,
    instrucciones: null,
    mensajeTopeExcedido: null,
    ...overrides,
  };
}

async function insertarTenant(db: Awaited<ReturnType<typeof crearDbEfimera>>["db"], id: string) {
  await db.insert(waTenants).values({
    id,
    nombre: "Lavacar de prueba",
    phoneNumberId: `pnid-${id}`,
    timezone: "America/Costa_Rica",
    moneda: "CRC",
    ubicacion: "San José",
    horario: {},
    servicios: [],
    kb: { faq: [], datos: [], politicas: [] },
  });
}

test("guardar config crea una versión en el historial con el usuario correcto", async () => {
  const { db, cerrar } = await crearDbEfimera();
  try {
    const tenantId = "tenant-f15-1";
    await insertarTenant(db, tenantId);

    await actualizarConfigTenant(tenantId, patchBase({ instrucciones: "primera versión" }), "usuario-abc", db);

    const filas = await db.select().from(waTenantsHistorial).where(eq(waTenantsHistorial.tenantId, tenantId));
    assert.equal(filas.length, 1, "el guardado debe dejar exactamente una versión nueva");
    assert.equal(filas[0].usuarioId, "usuario-abc");
    assert.equal((filas[0].snapshot as ConfigTenantPatch).instrucciones, "primera versión");

    // El UPDATE a wa_tenants también se aplicó (misma transacción).
    const [tenant] = await db.select().from(waTenants).where(eq(waTenants.id, tenantId));
    assert.equal(tenant.instrucciones, "primera versión");
  } finally {
    await cerrar();
  }
});

test("el historial lista versiones MÁS RECIENTE PRIMERO", async () => {
  const { db, cerrar } = await crearDbEfimera();
  try {
    const tenantId = "tenant-f15-2";
    await insertarTenant(db, tenantId);

    await actualizarConfigTenant(tenantId, patchBase({ instrucciones: "v1" }), "usuario-a", db);
    await new Promise((r) => setTimeout(r, 5)); // separa creado_en (evita ties de reloj)
    await actualizarConfigTenant(tenantId, patchBase({ instrucciones: "v2" }), "usuario-b", db);
    await new Promise((r) => setTimeout(r, 5));
    await actualizarConfigTenant(tenantId, patchBase({ instrucciones: "v3" }), "usuario-c", db);

    const historial = await listarHistorialConfigTenant(tenantId, undefined, db);
    assert.equal(historial.length, 3);
    assert.deepEqual(
      historial.map((h) => (h.snapshot as ConfigTenantPatch).instrucciones),
      ["v3", "v2", "v1"],
      "más reciente primero",
    );
    assert.deepEqual(historial.map((h) => h.usuarioId), ["usuario-c", "usuario-b", "usuario-a"]);
  } finally {
    await cerrar();
  }
});

test("restaurar una versión vieja aplica esa config Y crea una versión NUEVA (no borra ni reescribe la anterior)", async () => {
  const { db, cerrar } = await crearDbEfimera();
  try {
    const tenantId = "tenant-f15-3";
    await insertarTenant(db, tenantId);

    await actualizarConfigTenant(tenantId, patchBase({ instrucciones: "original" }), "usuario-a", db);
    await new Promise((r) => setTimeout(r, 5));
    await actualizarConfigTenant(tenantId, patchBase({ instrucciones: "cambio malo" }), "usuario-b", db);

    let historial = await listarHistorialConfigTenant(tenantId, undefined, db);
    assert.equal(historial.length, 2);
    const versionOriginal = historial[1]; // la más vieja de las dos
    assert.equal((versionOriginal.snapshot as ConfigTenantPatch).instrucciones, "original");

    await new Promise((r) => setTimeout(r, 5));
    const restaurado = await restaurarVersionConfigTenant(tenantId, versionOriginal.id, "usuario-c", db);
    assert.equal(restaurado, true);

    // La config vigente vuelve a ser la de la versión restaurada.
    const [tenant] = await db.select().from(waTenants).where(eq(waTenants.id, tenantId));
    assert.equal(tenant.instrucciones, "original");

    // El historial creció (3 versiones): no se borró ni se reescribió ninguna de las
    // dos anteriores, la restauración quedó como una fila NUEVA arriba.
    historial = await listarHistorialConfigTenant(tenantId, undefined, db);
    assert.equal(historial.length, 3, "restaurar agrega una versión, no reescribe el historial");
    assert.equal((historial[0].snapshot as ConfigTenantPatch).instrucciones, "original", "la versión más nueva es la restauración");
    assert.equal(historial[0].usuarioId, "usuario-c", "quedó registrado quién restauró");
    assert.equal((historial[1].snapshot as ConfigTenantPatch).instrucciones, "cambio malo", "la versión intermedia sigue intacta");
    assert.equal((historial[2].snapshot as ConfigTenantPatch).instrucciones, "original", "la versión original original sigue intacta");
  } finally {
    await cerrar();
  }
});

test("restaurar un historialId que no existe o es de otro tenant devuelve false sin tocar nada", async () => {
  const { db, cerrar } = await crearDbEfimera();
  try {
    const tenantA = "tenant-f15-4a";
    const tenantB = "tenant-f15-4b";
    await insertarTenant(db, tenantA);
    await insertarTenant(db, tenantB);

    await actualizarConfigTenant(tenantA, patchBase({ instrucciones: "de A" }), "usuario-a", db);
    const [{ id: historialIdDeA }] = await db.select().from(waTenantsHistorial).where(eq(waTenantsHistorial.tenantId, tenantA));

    // Id inexistente.
    assert.equal(await restaurarVersionConfigTenant(tenantA, "id-que-no-existe", "usuario-x", db), false);

    // Id que existe pero es de OTRO tenant: tenantB no puede restaurar una versión de A.
    assert.equal(await restaurarVersionConfigTenant(tenantB, historialIdDeA, "usuario-x", db), false);

    const historialB = await listarHistorialConfigTenant(tenantB, undefined, db);
    assert.equal(historialB.length, 0, "el intento fallido no debe haber creado nada para B");
  } finally {
    await cerrar();
  }
});

test("la retención poda versiones viejas más allá del límite N", async () => {
  const { db, cerrar } = await crearDbEfimera();
  try {
    const tenantId = "tenant-f15-5";
    await insertarTenant(db, tenantId);

    // RETENCION_VERSIONES_CONFIG = 30 (src/config/tenantsHistorial.ts): escribimos 33
    // versiones y verificamos que solo sobreviven las 30 más recientes.
    const TOTAL = 33;
    for (let i = 1; i <= TOTAL; i++) {
      await actualizarConfigTenant(tenantId, patchBase({ instrucciones: `v${i}` }), `usuario-${i}`, db);
    }

    const filas = await db.select().from(waTenantsHistorial).where(eq(waTenantsHistorial.tenantId, tenantId));
    assert.equal(filas.length, 30, "se podan las versiones más allá del límite de retención");

    const historial = await listarHistorialConfigTenant(tenantId, 100, db);
    assert.equal(historial.length, 30);
    // Sobreviven las últimas 30 (v4..v33): se podaron v1, v2 y v3.
    assert.equal((historial[0].snapshot as ConfigTenantPatch).instrucciones, "v33", "la más reciente sigue presente");
    assert.equal((historial[29].snapshot as ConfigTenantPatch).instrucciones, "v4", "la más vieja que sobrevive es v4");
    const instrucciones = historial.map((h) => (h.snapshot as ConfigTenantPatch).instrucciones);
    assert.ok(!instrucciones.includes("v1"), "v1 se podó");
    assert.ok(!instrucciones.includes("v2"), "v2 se podó");
    assert.ok(!instrucciones.includes("v3"), "v3 se podó");
  } finally {
    await cerrar();
  }
});

test("la config de un tenant no se mezcla con la de otro (aislamiento por tenant_id)", async () => {
  const { db, cerrar } = await crearDbEfimera();
  try {
    const tenantA = "tenant-f15-6a";
    const tenantB = "tenant-f15-6b";
    await insertarTenant(db, tenantA);
    await insertarTenant(db, tenantB);

    await actualizarConfigTenant(tenantA, patchBase({ instrucciones: "de A" }), "usuario-a", db);
    await actualizarConfigTenant(tenantB, patchBase({ instrucciones: "de B" }), "usuario-b", db);

    const historialA = await listarHistorialConfigTenant(tenantA, undefined, db);
    const historialB = await listarHistorialConfigTenant(tenantB, undefined, db);
    assert.equal(historialA.length, 1);
    assert.equal(historialB.length, 1);
    assert.equal((historialA[0].snapshot as ConfigTenantPatch).instrucciones, "de A");
    assert.equal((historialB[0].snapshot as ConfigTenantPatch).instrucciones, "de B");
  } finally {
    await cerrar();
  }
});
