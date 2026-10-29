-- ─────────────────────────────────────────────────────────────────────────────
-- Activar el aislamiento entre negocios en la base (paso OPERATIVO, a mano)
--
-- ⚠️ SE CORRE A MANO, UNA SOLA VEZ, DESDE EL SQL EDITOR DE SUPABASE, y DESPUÉS de que el
-- deploy aplicó la migración base (drizzle/0000_platform_base.sql).
--
-- Qué ya hizo la migración (no hay que repetirlo):
--   • creó el rol `app_runtime` SIN BYPASSRLS y SIN LOGIN (inofensivo: nadie puede entrar);
--   • le dio USAGE en el schema y SELECT/INSERT/UPDATE/DELETE sobre las tablas, más los
--     mismos permisos por defecto para las tablas que creen las migraciones siguientes;
--   • creó las políticas RLS de cada tabla (por negocio, o solo sistema).
--
-- Qué falta (este archivo): darle LOGIN con una clave, probar la conexión y repuntar la
-- app. No es una migración a propósito: cambia credenciales de producción, y eso lo tiene
-- que hacer y verificar una persona.
--
-- Por qué importa: si la app se conecta como `postgres`, que tiene BYPASSRLS, las
-- políticas existen pero no aplican, y el aislamiento por negocio depende de que ninguna
-- consulta del código olvide filtrar. Con la app como `app_runtime`, lo garantiza la base
-- (cada transacción fija `app.tenant_id` o `app.system`, src/platform/db/scope.ts).
--
-- ⚠️ PRERREQUISITO: backups verificados — un restore probado (scripts/verifyRestore.ts)
-- antes de cambiar cómo se conecta la app a la base.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. Darle login al rol ───────────────────────────────────────────────────
-- Reemplazá 'PONE_UNA_CLAVE_FUERTE_ACA' por una clave generada al azar, p. ej.:
--   node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"
-- Guardala en el gestor de secretos: es la credencial de producción de la app.

ALTER ROLE app_runtime WITH LOGIN PASSWORD 'PONE_UNA_CLAVE_FUERTE_ACA';

-- ── 2. Verificación (corré esto y leé la salida) ────────────────────────────
-- Lo importante: rolbypassrls = false para app_runtime. Si sale true, las políticas
-- serían decorativas.

SELECT rolname, rolsuper, rolbypassrls, rolcanlogin
FROM pg_roles
WHERE rolname IN ('postgres', 'app_runtime')
ORDER BY rolname;

-- Esperado:
--   app_runtime | false | false | true
--   postgres    | false | true  | true

-- Toda tabla de public debe tener política para app_runtime (0 filas = bien):
SELECT c.relname AS table_without_policy
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind = 'r'
  AND NOT EXISTS (SELECT 1 FROM pg_policies p WHERE p.tablename = c.relname AND 'app_runtime' = ANY(p.roles));

-- ── 3. Probar la conexión ANTES de tocar producción ─────────────────────────
-- El pooler de Supabase (modo sesión, puerto 5432) usa el usuario con el project-ref
-- pegado: `app_runtime.<project-ref>`. Desde el servidor:
--
--   psql "postgresql://app_runtime.<project-ref>:CLAVE@<pooler>:5432/postgres" \
--     -c "SELECT count(*) FROM audit_log"             -- debe dar 0 (sin contexto no ve nada)
--   psql "...mismo URL..." -c "BEGIN; SELECT set_config('app.system','on',true); SELECT count(*) FROM audit_log; COMMIT;"
--                                                    -- debe dar la cantidad real de filas
--
-- Si el pooler rechaza el rol custom, usá la conexión DIRECTA (db.<ref>.supabase.co:5432)
-- para la app y revisá DB_POOL_MAX contra su límite de conexiones (más bajo).

-- ── 4. Repuntar la app ──────────────────────────────────────────────────────
-- En el .env del servidor quedan DOS URLs, con roles distintos y a propósito:
--
--   DATABASE_URL             → rol app_runtime (la app: sin DDL, sin BYPASSRLS)
--   DATABASE_URL_MIGRATIONS  → rol postgres    (migrate.ts, backups y demás scripts)
--
-- `pm2 reload selyon-crm --update-env` y verificar /health?detail=1&token=… + una prueba
-- de punta a punta en el panel.

-- ── 5. Rollback ─────────────────────────────────────────────────────────────
-- Volver DATABASE_URL al rol postgres y recargar. El rol puede quedar creado sin efecto;
-- para quitarle el acceso:
--   ALTER ROLE app_runtime NOLOGIN;
