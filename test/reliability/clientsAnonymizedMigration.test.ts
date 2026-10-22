import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { MIGRATIONS_FOLDER } from "../../src/platform/db/client";

// ─────────────────────────────────────────────────────────────────────────────
// Migración 0006_clients_crm: la columna `clients.anonymized_at` reemplaza la marca
// provisoria `custom_data.$anonymizedAt` de I1-I2, con backfill. Se migra una base hasta
// 0005 (el esquema de antes), se cargan clientes con la marca vieja y se aplica el resto:
// la marca pasa a la columna y desaparece de custom_data, sin tocar los demás valores.
// ─────────────────────────────────────────────────────────────────────────────

const TARGET = "0006_clients_crm";
const work = mkdtempSync(join(tmpdir(), "selyon-mig-"));
after(() => rmSync(work, { recursive: true, force: true }));

/** Copia de las migraciones hasta ANTES de `tag` (journal recortado). */
function migrationsBefore(tag: string): string {
  const journal = JSON.parse(readFileSync(join(MIGRATIONS_FOLDER, "meta", "_journal.json"), "utf8")) as { entries: { tag: string; idx: number }[] };
  const index = journal.entries.findIndex((e) => e.tag === tag);
  assert.ok(index > 0, `no encontré la migración ${tag}`);
  const dir = join(work, "before");
  mkdirSync(join(dir, "meta"), { recursive: true });
  const entries = journal.entries.slice(0, index);
  for (const e of entries) copyFileSync(join(MIGRATIONS_FOLDER, `${e.tag}.sql`), join(dir, `${e.tag}.sql`));
  writeFileSync(join(dir, "meta", "_journal.json"), JSON.stringify({ ...journal, entries }));
  return dir;
}

test("0006: la marca $anonymizedAt pasa a anonymized_at y sale de custom_data (los demás valores quedan)", async () => {
  const client = new PGlite({ extensions: { btree_gist } });
  try {
    const db = drizzle(client);
    await migrate(db, { migrationsFolder: migrationsBefore(TARGET) });
    const cols = await client.query<{ column_name: string }>("SELECT column_name FROM information_schema.columns WHERE table_name = 'clients' AND column_name = 'anonymized_at'");
    assert.equal(cols.rows.length, 0, "antes de 0006 no existe la columna");

    const businessId = randomUUID();
    await client.query("INSERT INTO businesses (id, slug, name) VALUES ($1, $2, 'Negocio')", [businessId, `neg-${businessId.slice(0, 8)}`]);
    const insert = async (name: string, customData: unknown, updatedAt = "2026-09-01T10:00:00Z") => {
      const { rows } = await client.query<{ id: string }>(
        "INSERT INTO clients (business_id, name, custom_data, updated_at) VALUES ($1, $2, $3::jsonb, $4::timestamptz) RETURNING id",
        [businessId, name, JSON.stringify(customData), updatedAt],
      );
      return rows[0].id;
    };
    const anonymized = await insert("Cliente eliminado", { $anonymizedAt: "2026-08-15T12:34:56.789Z" });
    const weird = await insert("Cliente eliminado", { $anonymizedAt: "ayer" }, "2026-07-01T00:00:00Z");
    const normal = await insert("Normal", { alergias: "Látex" });

    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });

    const { rows } = await client.query<{ id: string; anonymized_at: Date | null; custom_data: Record<string, unknown> }>(
      "SELECT id, anonymized_at, custom_data FROM clients WHERE business_id = $1",
      [businessId],
    );
    const byId = new Map(rows.map((r) => [r.id, r]));
    assert.equal(byId.get(anonymized)?.anonymized_at?.toISOString(), "2026-08-15T12:34:56.789Z");
    assert.deepEqual(byId.get(anonymized)?.custom_data, {});
    assert.equal(byId.get(weird)?.anonymized_at?.toISOString(), "2026-07-01T00:00:00.000Z", "marca ilegible → updated_at");
    assert.deepEqual(byId.get(weird)?.custom_data, {});
    assert.equal(byId.get(normal)?.anonymized_at, null);
    assert.deepEqual(byId.get(normal)?.custom_data, { alergias: "Látex" }, "los campos personalizados no se tocan");

    const index = await client.query("SELECT 1 FROM pg_indexes WHERE indexname = 'clients_tags_idx'");
    assert.equal(index.rows.length, 1, "índice GIN de etiquetas");
  } finally {
    await client.close();
  }
});
