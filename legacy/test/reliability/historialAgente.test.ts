import { test } from "node:test";
import assert from "node:assert/strict";
import { crearDbEfimera } from "../helpers/pgliteDb";
import { RepositorioDrizzle } from "../../src/booking/drizzleRepository";

// ─────────────────────────────────────────────────────────────────────────────
// `mensajesRecientes` (revisión pre-venta 2026-10) contra Postgres efímero (PGlite):
// la lectura liviana del historial del agente devuelve los N MÁS RECIENTES en orden
// cronológico y respeta la frontera de tenant (wa_mensajes no tiene tenant_id: la
// aplica el JOIN con la conversación).
// ─────────────────────────────────────────────────────────────────────────────

const TENANT = "tenant-historial";

test("mensajesRecientes: los últimos N, en orden cronológico, con waMessageId", async () => {
  const { db, cerrar } = await crearDbEfimera();
  try {
    const repo = new RepositorioDrizzle(db);
    const conv = await repo.obtenerOConversacion(TENANT, "50688880000");
    const base = Date.now() - 60 * 60_000;
    for (let i = 0; i < 8; i++) {
      await repo.guardarMensaje(TENANT, conv.id, {
        rol: i % 2 ? "assistant" : "user",
        contenido: `m${i}`,
        creadoEn: new Date(base + i * 60_000).toISOString(),
        waMessageId: `wamid.h.${i}`,
      });
    }
    const r = await repo.mensajesRecientes(TENANT, conv.id, 3);
    assert.deepEqual(
      r.map((m) => m.contenido),
      ["m5", "m6", "m7"],
    );
    assert.equal(r[2].waMessageId, "wamid.h.7");
    assert.equal(r[1].rol, "user");
    assert.equal(r[2].porHumano, false);
  } finally {
    await cerrar();
  }
});

test("mensajesRecientes: conversación de OTRO tenant o inexistente → []", async () => {
  const { db, cerrar } = await crearDbEfimera();
  try {
    const repo = new RepositorioDrizzle(db);
    const conv = await repo.obtenerOConversacion(TENANT, "50688881111");
    await repo.guardarMensaje(TENANT, conv.id, { rol: "user", contenido: "hola", creadoEn: new Date().toISOString() });
    assert.equal((await repo.mensajesRecientes(TENANT, conv.id, 20)).length, 1);
    assert.deepEqual(await repo.mensajesRecientes("otro-tenant", conv.id, 20), []);
    assert.deepEqual(await repo.mensajesRecientes(TENANT, "00000000-0000-0000-0000-000000000000", 20), []);
  } finally {
    await cerrar();
  }
});
