import "dotenv/config";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { TENANT_FALLBACK_ROSALES } from "../src/config/tenants";
import { waTenants, waUsuarios } from "../src/db/schema";

// ─────────────────────────────────────────────────────────────────────────────
// Siembra (o actualiza) en la base el tenant inicial "lavacar-rosales" y su usuario
// de panel, a partir de la config hardcodeada (TENANT_FALLBACK_ROSALES). IDEMPOTENTE
// (upsert): se puede correr en cada deploy sin duplicar ni romper. (ROADMAP B2)
//
//   Ejecutar:  npx tsx scripts/seedTenants.ts
//
// Va en el deploy DESPUÉS de migrar.ts y ANTES del pm2 restart, para que al reiniciar
// el bot ya encuentre al tenant en la base (ver DEPLOY.md).
// ─────────────────────────────────────────────────────────────────────────────

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("❌ Falta DATABASE_URL en el .env");
  process.exit(1);
}

const hash = process.env.PANEL_PASSWORD_HASH_ROSALES;
if (!hash) {
  console.error(
    "❌ Falta PANEL_PASSWORD_HASH_ROSALES en el .env (es la contraseña del panel del negocio). " +
      'Generala con: npx tsx scripts/hashPassword.ts "TU_CLAVE"',
  );
  process.exit(1);
}

const esSupabase = /supabase\.(co|com)/.test(url);
const sql = esSupabase ? postgres(url, { ssl: "require", prepare: false, max: 1 }) : postgres(url, { max: 1 });

try {
  const db = drizzle(sql);
  const t = TENANT_FALLBACK_ROSALES;

  // El id del tenant es el slug ("lavacar-rosales"): debe coincidir con el tenant_id
  // ya guardado en wa_conversaciones/wa_citas. Es inmutable.
  const datos = {
    id: t.id,
    nombre: t.nombre,
    phoneNumberId: t.phoneNumberId,
    accessToken: t.accessToken ?? null,
    timezone: t.timezone,
    moneda: t.moneda,
    ubicacion: t.ubicacion,
    intervaloAgendaMin: t.intervaloAgendaMin,
    horario: t.horario,
    servicios: t.servicios,
    kb: t.kb,
  };

  await db
    .insert(waTenants)
    .values(datos)
    .onConflictDoUpdate({
      target: waTenants.id,
      set: { ...datos, actualizadoEn: new Date() },
    });
  console.log(`✅ Tenant '${t.id}' sembrado/actualizado (phone_number_id: ${t.phoneNumberId}).`);

  await db
    .insert(waUsuarios)
    .values({ usuario: t.id, passwordHash: hash, tenantId: t.id })
    .onConflictDoUpdate({
      target: waUsuarios.usuario,
      set: { passwordHash: hash, tenantId: t.id },
    });
  console.log(`✅ Usuario de panel '${t.id}' sembrado/actualizado.`);
} catch (e) {
  console.error("❌ Error:", e instanceof Error ? e.message : e);
  process.exitCode = 1;
} finally {
  await sql.end();
}
