import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { is, sql } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import { rowsOf } from "../../src/platform/db/rows";
import { APP_ROLE } from "../../src/platform/db/rls";
import { schema } from "../../src/platform/db/schemaRegistry";
import { createEphemeralDb } from "../helpers/pgliteDb";

// ─────────────────────────────────────────────────────────────────────────────
// Row Level Security. Supabase expone `public` por su Data API con la anon key (pública)
// y les da grants por defecto a `anon`/`authenticated`: sin RLS, cualquiera leería y
// escribiría TODAS las tablas de todos los negocios. Estos tests exigen:
//   1. Toda tabla definida en un src/**/schema.ts tiene RLS activo y una política para
//      el rol de la app (tenantPolicy/systemOnlyPolicy de src/platform/db/rls.ts), y está
//      en el registro de esquemas — una tabla nueva sin eso rompe acá, no queda expuesta.
//   2. Con las migraciones reales: toda tabla de public tiene RLS, política y GRANT para
//      `app_runtime`, y el rol no tiene BYPASSRLS.
//   3. Un rol SIN BYPASSRLS, aun con GRANT, no ve ni una fila (lo que vería `anon`).
// ─────────────────────────────────────────────────────────────────────────────

const SRC_ROOT = fileURLToPath(new URL("../../src/", import.meta.url));

function* schemaFiles(dir: string): Generator<string> {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* schemaFiles(p);
    else if (e.name === "schema.ts") yield p;
  }
}

/** Todas las tablas exportadas por los src/**\/schema.ts, con el archivo de origen. */
async function declaredTables(): Promise<{ file: string; table: PgTable }[]> {
  const out: { file: string; table: PgTable }[] = [];
  for (const file of schemaFiles(SRC_ROOT)) {
    const mod = (await import(pathToFileURL(file).href)) as Record<string, unknown>;
    for (const value of Object.values(mod)) {
      if (is(value, PgTable)) out.push({ file: path.relative(SRC_ROOT, file).replace(/\\/g, "/"), table: value });
    }
  }
  return out;
}

function roleName(r: unknown): string {
  return typeof r === "string" ? r : ((r as { name?: string })?.name ?? "");
}

test("RLS (código): toda tabla de src/**/schema.ts tiene .enableRLS(), política para app_runtime y está registrada", async () => {
  const tables = await declaredTables();
  assert.ok(tables.length >= 2, "se esperaban al menos las tablas de plataforma (leader_leases, audit_log)");
  const registered = new Set<unknown>(Object.values(schema).filter((v) => is(v, PgTable)));
  const problems: string[] = [];
  for (const { file, table } of tables) {
    const cfg = getTableConfig(table);
    if (!cfg.enableRLS) problems.push(`${file} → ${cfg.name}: falta .enableRLS()`);
    const withAppRole = cfg.policies.filter((p) => {
      const to = Array.isArray(p.to) ? p.to : [p.to];
      return to.some((r) => roleName(r) === APP_ROLE);
    });
    if (withAppRole.length === 0) problems.push(`${file} → ${cfg.name}: sin política para ${APP_ROLE} (tenantPolicy/systemOnlyPolicy)`);
    if (!registered.has(table)) problems.push(`${file} → ${cfg.name}: no está en src/platform/db/schemaRegistry.ts`);
  }
  assert.deepEqual(problems, []);
});

test("RLS (base): toda tabla de public tiene RLS, política y GRANT para app_runtime; el rol no tiene BYPASSRLS", async () => {
  const { db, close } = await createEphemeralDb();
  try {
    const tables = rowsOf<{ relname: string; relrowsecurity: boolean }>(
      await db.execute(sql`
        SELECT c.relname, c.relrowsecurity
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'r'
      `),
    );
    assert.ok(tables.length >= 2, `se esperaban las tablas de plataforma (hay ${tables.length})`);
    const withoutRls = tables.filter((t) => !t.relrowsecurity).map((t) => t.relname);
    assert.deepEqual(withoutRls, [], `tablas sin RLS: ${withoutRls.join(", ")}`);

    const withPolicy = new Set(
      rowsOf<{ tablename: string }>(
        await db.execute(sql`SELECT tablename FROM pg_policies WHERE schemaname = 'public' AND ${APP_ROLE} = ANY(roles)`),
      ).map((r) => r.tablename),
    );
    const withoutPolicy = tables.map((t) => t.relname).filter((t) => !withPolicy.has(t));
    assert.deepEqual(withoutPolicy, [], `tablas sin política para ${APP_ROLE}: ${withoutPolicy.join(", ")}`);

    const withoutGrant: string[] = [];
    for (const { relname } of tables) {
      const [r] = rowsOf<{ ok: boolean }>(
        await db.execute(sql`SELECT has_table_privilege(${APP_ROLE}, ${relname}, 'SELECT,INSERT,UPDATE,DELETE') AS ok`),
      );
      if (!r.ok) withoutGrant.push(relname);
    }
    assert.deepEqual(withoutGrant, [], `tablas sin GRANT para ${APP_ROLE}: ${withoutGrant.join(", ")}`);

    const [role] = rowsOf<{ bypass: boolean; login: boolean }>(
      await db.execute(sql`SELECT rolbypassrls AS bypass, rolcanlogin AS login FROM pg_roles WHERE rolname = ${APP_ROLE}`),
    );
    assert.equal(role.bypass, false, `${APP_ROLE} no puede tener BYPASSRLS`);
    assert.equal(role.login, false, "la migración lo crea NOLOGIN: el login se le da a mano");
  } finally {
    await close();
  }
});

test("RLS (base): una tabla creada por una migración posterior nace con GRANT para app_runtime", async () => {
  const { db, close } = await createEphemeralDb();
  try {
    await db.execute(sql`CREATE TABLE future_module_table (id uuid PRIMARY KEY)`);
    const [r] = rowsOf<{ ok: boolean }>(
      await db.execute(sql`SELECT has_table_privilege(${APP_ROLE}, 'future_module_table', 'SELECT,INSERT,UPDATE,DELETE') AS ok`),
    );
    assert.equal(r.ok, true, "ALTER DEFAULT PRIVILEGES de la migración base");
  } finally {
    await close();
  }
});

test("RLS (base): un rol sin BYPASSRLS (como anon de Supabase) no ve filas aunque tenga GRANT", async () => {
  const { db, close } = await createEphemeralDb();
  try {
    await db.execute(sql`INSERT INTO leader_leases (name, holder, expires_at) VALUES ('x', 'y', now())`);
    await db.execute(sql`CREATE ROLE anon_test NOLOGIN NOBYPASSRLS`);
    await db.execute(sql`GRANT USAGE ON SCHEMA public TO anon_test`);
    await db.execute(sql`GRANT SELECT ON leader_leases TO anon_test`);
    await db.execute(sql`SET ROLE anon_test`);
    const [row] = rowsOf<{ n: number }>(await db.execute(sql`SELECT count(*)::int AS n FROM leader_leases`));
    await db.execute(sql`RESET ROLE`);
    assert.equal(row.n, 0);
  } finally {
    await close();
  }
});
