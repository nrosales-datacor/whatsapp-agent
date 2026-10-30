import "dotenv/config";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DEMO_OWNER_EMAIL, seedDev } from "../../scripts/seedDev";
import { _resetPoolForTests, startLocalDb } from "../../src/platform/db/client";

// ─────────────────────────────────────────────────────────────────────────────
// Arranque del server para el smoke E2E (proyecto "server" de playwright.config.ts): una
// base PGlite NUEVA en una carpeta temporal, el seed de desarrollo (scripts/seedDev.ts:
// negocio demo + usuarios con la clave pública de desarrollo) y recién después el server
// real (src/server.ts) sobre esa MISMA carpeta. Así hay un login de punta a punta contra el
// backend sin tocar código de producción.
//
// PGlite es de un solo proceso: el seed abre la carpeta, siembra y la CIERRA antes de que
// el server la vuelva a abrir (PGLITE_DIR). Se niega a correr con NODE_ENV=production o con
// una DATABASE_URL: este arranque es solo para la base efímera de los tests.
// ─────────────────────────────────────────────────────────────────────────────

if (process.env.NODE_ENV === "production" || process.env.DATABASE_URL || process.env.DATABASE_URL_MIGRATIONS) {
  console.error("❌ seededServer es solo para el E2E sobre PGlite (sin NODE_ENV=production ni DATABASE_URL).");
  process.exit(1);
}

// Carpeta propia por puerto (varios worktrees en paralelo no se pisan) y SIEMPRE desde cero.
const dir = process.env.PGLITE_DIR || path.join(tmpdir(), `selyon-e2e-pglite-${process.env.PORT ?? "3100"}`);
rmSync(dir, { recursive: true, force: true });

const db = await startLocalDb(dir);
try {
  await seedDev(db);
} finally {
  await (db as unknown as { $client: { close: () => Promise<void> } }).$client.close();
  _resetPoolForTests();
}
console.log(`[e2e] base sembrada en ${dir} (usuaria demo: ${DEMO_OWNER_EMAIL}).`);

process.env.PGLITE_DIR = dir;
await import("../../src/server");
