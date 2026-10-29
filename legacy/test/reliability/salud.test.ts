import { test } from "node:test";
import assert from "node:assert/strict";
import { crearDbEfimera } from "../helpers/pgliteDb";
import { crearTenant } from "../helpers/fixtures";
import { waJobs } from "../../src/db/schema";
import { chequearSalud, codigoHttpSalud } from "../../src/salud";
import { _forzarFuenteParaTests, _registrarTenantParaTests } from "../../src/config/tenantStore";
import type { Conversacion, PendienteSerializado } from "../../src/types";

/** Payload mínimo pero válido de wa_jobs: acá solo importa CONTAR filas por estado,
 * nunca se reclama/procesa el job, así que no hace falta que sea "real". */
function payloadDeCola(): PendienteSerializado {
  const conv: Conversacion = {
    id: "conv-salud",
    tenantId: "tenant-x",
    clienteWa: "50600000000",
    optInEn: null,
    optOutEn: null,
    modo: "bot",
    estado: "abierta",
    mensajes: [],
    ventanaAbierta: false,
    ventanaCierraEn: null,
  };
  return {
    clase: "texto",
    tenantId: "tenant-x",
    entrante: { phoneNumberId: "pnid-salud", clienteWa: conv.clienteWa, esTexto: true, texto: "hola" },
    conv,
    primerContacto: false,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// ROADMAP E10 / AUDIT.md BLOQUEANTE-11 — el health check ahora verifica algo real:
// DB alcanzable, caché de tenants NO en fallback, y reporta cola + dependencia del
// token global. Se prueba `chequearSalud` DIRECTO (sin levantar server.ts, que
// tiene efectos de lado top-level) contra Postgres efímero (PGlite), mismo patrón
// que el resto de test/reliability/*.
//
// `process.env.DATABASE_URL` se manipula puntualmente en cada test porque
// `hayBaseDeDatos()` (src/config/tenantStore.ts) lo lee al vuelo para decidir si
// "sin DB" (modo memoria, fallback esperado) o "con DB" (fallback = degradación
// real) — se restaura siempre en el `finally` para no ensuciar el resto de la
// suite (los demás archivos corren en su propio proceso, pero los tests DE ESTE
// archivo comparten el módulo).
// ─────────────────────────────────────────────────────────────────────────────

function conDatabaseUrl<T>(valor: string, fn: () => Promise<T>): Promise<T> {
  const previo = process.env.DATABASE_URL;
  process.env.DATABASE_URL = valor;
  return fn().finally(() => {
    if (previo === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previo;
  });
}

test("sin DATABASE_URL (modo memoria): 200, db no configurada, cola sin datos", async () => {
  delete process.env.DATABASE_URL;
  const detalle = await chequearSalud(null);

  assert.equal(detalle.db.configurada, false);
  assert.equal(detalle.db.ok, true, "sin DB no es un fallo: es el modo memoria/dev");
  assert.equal(detalle.cola.pendientes, null, "sin DB no existe wa_jobs que consultar");
  assert.equal(detalle.cola.enError, null);
  assert.equal(detalle.ok, true);
  assert.equal(codigoHttpSalud(detalle), 200);
});

test("con DB alcanzable y caché de tenants fresco ('db'): 200, reporta latencia y profundidad de cola", async () => {
  const { db, cerrar } = await crearDbEfimera();
  try {
    _forzarFuenteParaTests("db");
    await conDatabaseUrl("postgres://fake-para-hayBaseDeDatos-e10", async () => {
      await db.insert(waJobs).values([
        { tenantId: "tenant-x", payload: payloadDeCola(), estado: "pendiente" },
        { tenantId: "tenant-x", payload: payloadDeCola(), estado: "pendiente" },
        { tenantId: "tenant-x", payload: payloadDeCola(), estado: "error" },
        { tenantId: "tenant-x", payload: payloadDeCola(), estado: "hecho" }, // no debe contar
      ]);

      const detalle = await chequearSalud(db);

      assert.equal(detalle.db.configurada, true);
      assert.equal(detalle.db.ok, true);
      assert.equal(typeof detalle.db.latenciaMs, "number");
      assert.ok((detalle.db.latenciaMs ?? -1) >= 0);
      assert.equal(detalle.tenants.fuente, "db");
      assert.equal(detalle.cola.pendientes, 2);
      assert.equal(detalle.cola.enError, 1);
      assert.equal(detalle.ok, true);
      assert.equal(codigoHttpSalud(detalle), 200);

      // Contrato de forma exacto: lo que server.ts manda tal cual con `?detalle=1`.
      const comoJson = JSON.parse(JSON.stringify(detalle));
      assert.deepEqual(Object.keys(comoJson).sort(), ["cola", "db", "ok", "tenants", "tokenGlobal", "uptimeSeg"].sort());
    });
  } finally {
    await cerrar();
  }
});

test("BLOQUEANTE-11: DATABASE_URL configurada pero el caché sigue en fallback → 503 aunque la DB esté viva", async () => {
  const { db, cerrar } = await crearDbEfimera();
  try {
    _forzarFuenteParaTests("fallback");
    await conDatabaseUrl("postgres://fake-para-hayBaseDeDatos-e10", async () => {
      const detalle = await chequearSalud(db);

      assert.equal(detalle.db.ok, true, "la base en sí responde bien");
      assert.equal(detalle.tenants.fuente, "fallback", "el bot está atendiendo con el tenant hardcodeado");
      assert.equal(detalle.ok, false, "eso solo es aceptable SIN DATABASE_URL; acá sí hay una configurada");
      assert.equal(codigoHttpSalud(detalle), 503);
    });
  } finally {
    _forzarFuenteParaTests("db"); // no ensuciar los tests siguientes de este archivo
    await cerrar();
  }
});

test("DB inalcanzable con DATABASE_URL configurada → 503", async () => {
  const { db, cerrar } = await crearDbEfimera();
  _forzarFuenteParaTests("db");
  await cerrar(); // simula la base caída: cualquier query sobre `db` falla desde ahora

  await conDatabaseUrl("postgres://fake-para-hayBaseDeDatos-e10", async () => {
    const detalle = await chequearSalud(db);

    assert.equal(detalle.db.configurada, true);
    assert.equal(detalle.db.ok, false);
    assert.ok(detalle.db.error, "debe explicar por qué falló, para el modo detalle");
    assert.equal(detalle.ok, false);
    assert.equal(codigoHttpSalud(detalle), 503);
  });
});

test("reporta cuántos tenants dependen del token global (F5, dependeDelTokenGlobal)", async () => {
  delete process.env.DATABASE_URL; // sin DB: que el fallback no dispare el 503 acá, es otro chequeo
  const tenantLegado = crearTenant({
    id: "tenant-legado-e10",
    phoneNumberId: "legado-e10-pnid",
    accessToken: undefined,
  });
  _registrarTenantParaTests(tenantLegado);

  const previoTenantId = process.env.WHATSAPP_ACCESS_TOKEN_TENANT_ID;
  const previoToken = process.env.WHATSAPP_ACCESS_TOKEN;
  process.env.WHATSAPP_ACCESS_TOKEN_TENANT_ID = tenantLegado.id;
  process.env.WHATSAPP_ACCESS_TOKEN = "token-compartido-de-prueba";
  try {
    const detalle = await chequearSalud(null);

    assert.ok(detalle.tokenGlobal.dependientes >= 1, "el tenant legado debe contar como dependiente");
    assert.ok(detalle.tokenGlobal.total >= detalle.tokenGlobal.dependientes);
    // Depender del token global es degradación tolerada, no un fallo duro (E10, punto 3).
    assert.equal(detalle.ok, true);
    assert.equal(codigoHttpSalud(detalle), 200);
  } finally {
    if (previoTenantId === undefined) delete process.env.WHATSAPP_ACCESS_TOKEN_TENANT_ID;
    else process.env.WHATSAPP_ACCESS_TOKEN_TENANT_ID = previoTenantId;
    if (previoToken === undefined) delete process.env.WHATSAPP_ACCESS_TOKEN;
    else process.env.WHATSAPP_ACCESS_TOKEN = previoToken;
  }
});
