import assert from "node:assert/strict";
import { test } from "node:test";
import { sql } from "drizzle-orm";
import { filasDe } from "../../src/db/filas";
import { crearDbEfimera } from "../helpers/pgliteDb";

// ─────────────────────────────────────────────────────────────────────────────
// Revisión pre-venta 2026-10 (G2): Supabase expone `public` por su Data API con la
// anon key (pública) y les da grants por defecto a `anon`/`authenticated`. Sin RLS,
// cualquiera leía/escribía TODAS las tablas de todos los tenants (incluido
// `wa_usuarios.password_hash`). Estos tests corren las migraciones reales y exigen:
//   1. Toda tabla de `public` tiene RLS activo (una tabla nueva sin `.enableRLS()`
//      rompe este test, no queda expuesta en silencio).
//   2. Un rol SIN BYPASSRLS, aun con GRANT, no ve ni una fila (lo que vería `anon`).
// ─────────────────────────────────────────────────────────────────────────────

test("RLS: todas las tablas de public tienen row level security activo", async () => {
  const { db, cerrar } = await crearDbEfimera();
  try {
    const filas = filasDe<{ relname: string; relrowsecurity: boolean }>(
      await db.execute(sql`
        SELECT c.relname, c.relrowsecurity
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'r'
      `),
    );
    assert.ok(filas.length >= 17, `se esperaban las tablas wa_* (hay ${filas.length})`);
    const sinRls = filas.filter((f) => !f.relrowsecurity).map((f) => f.relname);
    assert.deepEqual(sinRls, [], `tablas sin RLS (agregá .enableRLS() en schema.ts): ${sinRls.join(", ")}`);
  } finally {
    await cerrar();
  }
});

test("RLS: un rol sin BYPASSRLS (como anon de Supabase) no ve filas aunque tenga GRANT", async () => {
  const { db, cerrar } = await crearDbEfimera();
  try {
    await db.execute(sql`INSERT INTO wa_lideres (nombre, titular, vence_en) VALUES ('x', 'y', now())`);
    await db.execute(sql`CREATE ROLE anon_prueba NOLOGIN NOBYPASSRLS`);
    await db.execute(sql`GRANT USAGE ON SCHEMA public TO anon_prueba`);
    await db.execute(sql`GRANT SELECT ON wa_lideres TO anon_prueba`);
    await db.execute(sql`SET ROLE anon_prueba`);
    const [fila] = filasDe<{ n: number }>(await db.execute(sql`SELECT count(*)::int AS n FROM wa_lideres`));
    await db.execute(sql`RESET ROLE`);
    assert.equal(fila.n, 0);
  } finally {
    await cerrar();
  }
});
