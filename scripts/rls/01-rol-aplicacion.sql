-- ─────────────────────────────────────────────────────────────────────────────
-- F1 · Paso 1 de 3 — Rol de aplicación SIN BYPASSRLS
--
-- ⚠️ ESTE ARCHIVO SE CORRE A MANO, UNA SOLA VEZ, DESDE EL SQL EDITOR DE SUPABASE.
-- NO es una migración de drizzle a propósito: crea un ROL y cambia credenciales de
-- conexión (operación de infraestructura, no de esquema). Meterlo en `migrar.ts`
-- haría que el deploy automático toque la seguridad de la base sin que nadie mire.
--
-- POR QUÉ EXISTE ESTE PASO
-- Verificado contra producción el 2026-08-06:
--
--     usuario efectivo : postgres
--     rolsuper         : false
--     rolbypassrls     : true    ← ignora TODAS las políticas RLS
--
-- La app se conecta con el rol `postgres` de Supabase, que tiene BYPASSRLS. Si se
-- escriben las políticas de F1 sin cambiar esto, quedan escritas y NO HACEN NADA:
-- la peor variante posible, porque da apariencia de aislamiento sin aislamiento, y
-- con ella la tentación de dejar de revisar los filtros de la aplicación.
--
-- Roles que ya existen en el proyecto con rolbypassrls = false (o sea: el patrón es
-- viable acá): authenticator, supabase_auth_admin, supabase_replication_admin,
-- supabase_storage_admin.
--
-- ORDEN DE LOS 3 PASOS DE F1
--   1. Este archivo: crear el rol y darle permisos.          ← ops, a mano
--   2. Migración drizzle: `tenant_id` en wa_mensajes + backfill.
--   3. Migración drizzle: ENABLE/FORCE ROW LEVEL SECURITY + políticas.
-- Recién cuando los 3 estén, se repunta DATABASE_URL al rol nuevo.
--
-- ⚠️ PRERREQUISITO: E14 (backups verificados). El paso 2 hace un backfill sobre
-- wa_mensajes; no se toca esa tabla sin un restore probado.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. Crear el rol ─────────────────────────────────────────────────────────
-- Reemplazá 'PONE_UNA_CLAVE_FUERTE_ACA' por una clave generada al azar, p. ej.:
--   node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"
-- Guardala en el gestor de secretos: es la credencial de producción de la app.

CREATE ROLE app_wa WITH
  LOGIN
  PASSWORD 'PONE_UNA_CLAVE_FUERTE_ACA'
  NOSUPERUSER
  NOCREATEDB
  NOCREATEROLE
  NOBYPASSRLS     -- ← lo único que realmente importa acá
  NOINHERIT;

-- ── 2. Permisos mínimos ─────────────────────────────────────────────────────
-- Solo lo que la app necesita: leer/escribir filas de SUS tablas. Sin DDL: las
-- migraciones siguen corriendo con el rol privilegiado (ver paso 4).

GRANT USAGE ON SCHEMA public TO app_wa;

-- Explícito tabla por tabla en vez de "ALL TABLES IN SCHEMA public": si mañana
-- aparece una tabla nueva que no sea del bot, no queda expuesta por accidente. El
-- costo es acordarse de agregarla acá — y esa fricción es deliberada.
GRANT SELECT, INSERT, UPDATE, DELETE ON
  wa_conversaciones,
  wa_mensajes,
  wa_citas,
  wa_eventos_calidad,
  wa_push_subs,
  wa_tenants,
  wa_usuarios,
  wa_jobs,
  wa_campanias,
  wa_campania_envios,
  wa_uso_mensual,
  wa_cotizaciones,
  wa_seguimientos,
  wa_snapshot_reputacion
TO app_wa;

-- No hacen falta permisos sobre secuencias: todos los ids son `text` generados con
-- randomUUID() del lado de Node (ver el helper `id()` en src/db/schema.ts), no
-- hay ningún serial/identity en el esquema.

-- ── 3. Verificación (corré esto y leé la salida) ────────────────────────────
-- Lo importante: rolbypassrls = false. Si sale true, algo salió mal y las
-- políticas de RLS del paso 3 serían decorativas.

SELECT rolname, rolsuper, rolbypassrls, rolcanlogin
FROM pg_roles
WHERE rolname IN ('postgres', 'app_wa')
ORDER BY rolname;

-- Esperado:
--   app_wa    | false | false | true
--   postgres  | false | true  | true

-- ── 4. Cambiar las credenciales de la app ───────────────────────────────────
-- En el .env del droplet quedan DOS URLs, con roles distintos y a propósito:
--
--   DATABASE_URL              → rol app_wa   (la app: sin DDL, sin BYPASSRLS)
--   DATABASE_URL_MIGRACIONES  → rol postgres (solo migrar.ts y seedTenants.ts)
--
-- Un rol sin DDL no puede correr las migraciones; y darle DDL al rol de la app
-- anularía media ventaja de haberlo creado.
--
-- ⚠️ FORMATO DEL USUARIO EN EL POOLER DE SUPABASE: la conexión va por
-- `aws-1-us-east-1.pooler.supabase.com:5432` (modo sesión), y ahí el usuario NO es
-- solo el nombre del rol: lleva el project-ref pegado con un punto. Hoy es
-- `postgres.mfwyocxzmhzsuhidvuhp`, así que para el rol nuevo debería ser
-- `app_wa.mfwyocxzmhzsuhidvuhp`.
--
-- ⚠️ VERIFICALO ANTES DE CONFIAR: probá la conexión con psql o con un script corto
-- ANTES de cambiar el .env de producción. Si el pooler rechaza el rol custom,
-- la alternativa es usar la conexión DIRECTA (db.<ref>.supabase.co:5432) para la
-- app — pero ojo: la directa tiene un límite de conexiones más bajo, así que hay
-- que revisar DB_POOL_MAX (F7) contra ese número.
--
-- ── 5. Rollback ─────────────────────────────────────────────────────────────
-- Si algo sale mal, volver DATABASE_URL al rol postgres y reiniciar. El rol nuevo
-- puede quedar creado sin efecto. Para borrarlo del todo:
--   REVOKE ALL ON ALL TABLES IN SCHEMA public FROM app_wa;
--   REVOKE USAGE ON SCHEMA public FROM app_wa;
--   DROP ROLE app_wa;
