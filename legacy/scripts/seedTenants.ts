import "dotenv/config";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { cifrar } from "../src/config/secretos";
import { TENANT_FALLBACK_SELYON } from "../src/config/tenants";
import { waTenants, waUsuarios } from "../src/db/schema";

// ─────────────────────────────────────────────────────────────────────────────
// Siembra en la base el tenant inicial "selyon" y su usuario de panel, a partir de
// la config hardcodeada (TENANT_FALLBACK_SELYON). IDEMPOTENTE: se puede correr en
// cada deploy sin duplicar ni romper. (ROADMAP B2)
//
//   Ejecutar:  npx tsx scripts/seedTenants.ts
//
// Va en el deploy DESPUÉS de migrar.ts y ANTES del pm2 restart, para que al reiniciar
// el bot ya encuentre al tenant en la base (ver DEPLOY.md).
//
// ⚠️ NO PISA LO QUE EL DUEÑO EDITÓ (auditoría ALTO-08, 2026-07-27). Este script corre
// en CADA push a main (`.github/workflows/ci-cd.yml`) y antes hacía un
// `onConflictDoUpdate` con TODOS los campos: si el dueño afinaba su base de
// conocimiento, sus servicios o su horario desde "Mi negocio" un martes, el próximo
// deploy —aunque fuera por un cambio de CSS— le revertía todo a los valores
// hardcodeados del repo, y su contraseña a la del .env. Para un cliente que paga eso
// es pérdida de datos.
//
// Regla nueva: en el INSERT va todo (bootstrap de un tenant que no existe); en el
// UPDATE van SOLO los campos de infraestructura que administramos nosotros y que el
// dueño no puede editar desde el panel (`phone_number_id`, `access_token`,
// `google_calendar_id` si el .env lo trae). Todo lo demás —horario, servicios, kb,
// perfil, marca, contraseña— es del dueño y se respeta.
// ─────────────────────────────────────────────────────────────────────────────

// F1: con la app conectada como `app_wa` (sin DDL ni BYPASSRLS), los scripts de
// operación usan la URL privilegiada. Sin ella (antes de F1, o en dev) cae a DATABASE_URL.
const url = process.env.DATABASE_URL_MIGRACIONES ?? process.env.DATABASE_URL;
if (!url) {
  console.error("❌ Falta DATABASE_URL_MIGRACIONES (o DATABASE_URL) en el .env");
  process.exit(1);
}

const hash = process.env.PANEL_PASSWORD_HASH_SELYON;
if (!hash) {
  console.error(
    "❌ Falta PANEL_PASSWORD_HASH_SELYON en el .env (es la contraseña del panel del negocio). " +
      'Generala con: npx tsx scripts/hashPassword.ts "TU_CLAVE"',
  );
  process.exit(1);
}

const esSupabase = /supabase\.(co|com)/.test(url);
const sql = esSupabase ? postgres(url, { ssl: "require", prepare: false, max: 1 }) : postgres(url, { max: 1 });

try {
  const db = drizzle(sql);
  const t = TENANT_FALLBACK_SELYON;

  // Cifrado (ROADMAP F2) ANTES de armar los objetos de insert/update: este script es el
  // otro punto de escritura de wa_tenants.access_token además de crearTenant (tenantStore.ts).
  const accessTokenCifrado = t.accessToken ? cifrar(t.accessToken) : null;

  // El id del tenant es el slug ("selyon"): debe coincidir con el tenant_id ya guardado
  // en wa_conversaciones/wa_citas. Es inmutable.
  const datos = {
    id: t.id,
    nombre: t.nombre,
    phoneNumberId: t.phoneNumberId,
    accessToken: accessTokenCifrado,
    timezone: t.timezone,
    moneda: t.moneda,
    ubicacion: t.ubicacion,
    intervaloAgendaMin: t.intervaloAgendaMin,
    horario: t.horario,
    servicios: t.servicios,
    kb: t.kb,
    bloqueos: t.bloqueos,
    // Perfil del negocio (B7): sin esto el prompt del tenant sembrado caería a defaults.
    tipoNegocio: t.tipoNegocio ?? null,
    pais: t.pais ?? null,
    formasPago: t.formasPago ?? null,
    registro: t.registro ?? null,
    tono: t.tono ?? null,
    instrucciones: t.instrucciones ?? null,
  };

  // Campos de INFRAESTRUCTURA: los administramos nosotros, no el dueño desde el panel,
  // así que sí se refrescan en cada corrida (un token rotado tiene que llegar a la base).
  // El resto de `datos` solo aplica al INSERT inicial.
  const infraestructura = {
    phoneNumberId: t.phoneNumberId,
    accessToken: accessTokenCifrado,
    actualizadoEn: new Date(),
  };

  await db
    .insert(waTenants)
    .values(datos)
    .onConflictDoUpdate({ target: waTenants.id, set: infraestructura });
  console.log(
    `✅ Tenant '${t.id}' listo (phone_number_id: ${t.phoneNumberId}). ` +
      `Si ya existía, se respetó su config editada desde el panel.`,
  );

  // La contraseña NO se pisa (auditoría ALTO-08): si el dueño la cambió desde el panel,
  // un deploy no puede devolverla a la del .env. Solo se siembra si el usuario no existe.
  // Para resetear una clave existente está el flujo del superadmin (Carril D 0.5).
  // `rol` también va solo en el INSERT: nace dueño del negocio (el default de la columna
  // es "operador", ver migración 0011) y no se toca después para no pisar un rol que el
  // propio dueño haya cambiado desde "Usuarios".
  const usuarioSembrado = await db
    .insert(waUsuarios)
    .values({ usuario: t.id, passwordHash: hash, tenantId: t.id, rol: "dueno" })
    .onConflictDoNothing({ target: waUsuarios.usuario })
    .returning({ id: waUsuarios.id });
  console.log(
    usuarioSembrado.length > 0
      ? `✅ Usuario de panel '${t.id}' creado.`
      : `✅ Usuario de panel '${t.id}' ya existía: no se toca su contraseña (usá el reset del superadmin).`,
  );
} catch (e) {
  console.error("❌ Error:", e instanceof Error ? e.message : e);
  // Drizzle envuelve los errores de query: el motivo real de Postgres queda en
  // `.cause`, no en `.message` (que solo trae la query fallida + params).
  if (e instanceof Error && e.cause instanceof Error) {
    console.error("   causa:", e.cause.message);
  }
  process.exitCode = 1;
} finally {
  await sql.end();
}
