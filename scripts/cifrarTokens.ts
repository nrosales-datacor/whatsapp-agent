import "dotenv/config";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { cifrar } from "../src/config/secretos";
import { waTenants } from "../src/db/schema";

// ─────────────────────────────────────────────────────────────────────────────
// Migración ROADMAP F2: cifra en la base cualquier `wa_tenants.access_token` que
// haya quedado en texto plano (guardado antes de este cambio).
//
// IDEMPOTENTE — se puede correr las veces que haga falta sin dañar nada: cada fila
// se cifra UNA sola vez porque el criterio para tocarla es "no empieza con v1:";
// una vez cifrada, la siguiente corrida la deja intacta.
//
//   Ejecutar:  npx tsx scripts/cifrarTokens.ts
//
// Nunca imprime el valor de un token (ni en claro ni cifrado) — solo conteos e ids
// de tenant, para poder auditar el log sin que el log mismo sea un secreto.
// ─────────────────────────────────────────────────────────────────────────────

const PREFIJO = "v1:";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("❌ Falta DATABASE_URL en el .env");
  process.exit(1);
}

const esSupabase = /supabase\.(co|com)/.test(url);
const sql = esSupabase ? postgres(url, { ssl: "require", prepare: false, max: 1 }) : postgres(url, { max: 1 });

try {
  const db = drizzle(sql);
  console.log("Buscando tokens sin cifrar…");

  const filas = await db.select({ id: waTenants.id, accessToken: waTenants.accessToken }).from(waTenants);

  let cifrados = 0;
  let yaCifrados = 0;
  let sinToken = 0;

  for (const fila of filas) {
    if (!fila.accessToken) {
      sinToken++;
      continue;
    }
    if (fila.accessToken.startsWith(PREFIJO)) {
      yaCifrados++;
      continue;
    }
    // Si TOKENS_ENCRYPTION_KEY falta o es inválida, `secretos.ts` ya lanzó al cargarse
    // (fail-closed) y el script ni llega a este punto — no hay forma de cifrar "a medias".
    const nuevoValor = cifrar(fila.accessToken);
    await db.update(waTenants).set({ accessToken: nuevoValor }).where(eq(waTenants.id, fila.id));
    cifrados++;
  }

  console.log(
    `✅ Listo. Cifrados ahora: ${cifrados} · ya estaban cifrados: ${yaCifrados} · sin token (null): ${sinToken} · total: ${filas.length}`,
  );
  console.log("Corré este script de nuevo cuando quieras: es idempotente, no vuelve a tocar lo ya cifrado.");
} catch (e) {
  console.error("❌ Error:", e instanceof Error ? e.message : e);
  if (e instanceof Error && e.cause instanceof Error) {
    console.error("   causa:", e.cause.message);
  }
  process.exitCode = 1;
} finally {
  await sql.end();
}
