-- ─────────────────────────────────────────────────────────────────────────────
-- F1 · Activar el aislamiento entre negocios en la base (paso OPERATIVO, a mano)
--
-- ⚠️ SE CORRE A MANO, UNA SOLA VEZ, DESDE EL SQL EDITOR DE SUPABASE, y DESPUÉS de que
-- el deploy aplicó la migración 0037 (drizzle/0037_f1_rls_y_cola.sql).
--
-- Qué ya hizo la migración (no hay que repetirlo):
--   • creó el rol `app_wa` SIN BYPASSRLS y SIN LOGIN (inofensivo: nadie puede entrar);
--   • le dio USAGE en el schema y SELECT/INSERT/UPDATE/DELETE sobre las tablas wa_*;
--   • creó las políticas RLS de cada tabla (por negocio, o solo sistema).
--
-- Qué falta (este archivo): darle LOGIN con una clave, probar la conexión y repuntar la
-- app. No es una migración a propósito: cambia credenciales de producción, y eso lo
-- tiene que hacer y verificar una persona.
--
-- Por qué importa: hoy la app se conecta como `postgres`, que tiene BYPASSRLS — las
-- políticas existen pero no aplican. El aislamiento por negocio depende de que ninguna
-- consulta del código olvide filtrar por tenant. Con la app como `app_wa`, lo garantiza
-- la base (cada transacción fija `app.tenant_id` o `app.sistema`, src/db/alcance.ts).
--
-- ⚠️ PRERREQUISITO: backups verificados (ROADMAP E14 / B5) — un restore probado antes
-- de cambiar cómo se conecta la app a la base.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. Darle login al rol ───────────────────────────────────────────────────
-- Reemplazá 'PONE_UNA_CLAVE_FUERTE_ACA' por una clave generada al azar, p. ej.:
--   node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"
-- Guardala en el gestor de secretos: es la credencial de producción de la app.

ALTER ROLE app_wa WITH LOGIN PASSWORD 'PONE_UNA_CLAVE_FUERTE_ACA';

-- ── 2. Verificación (corré esto y leé la salida) ────────────────────────────
-- Lo importante: rolbypassrls = false para app_wa. Si sale true, las políticas serían
-- decorativas.

SELECT rolname, rolsuper, rolbypassrls, rolcanlogin
FROM pg_roles
WHERE rolname IN ('postgres', 'app_wa')
ORDER BY rolname;

-- Esperado:
--   app_wa    | false | false | true
--   postgres  | false | true  | true

-- Toda tabla wa_* debe tener política para app_wa (0 filas = bien):
SELECT c.relname AS tabla_sin_politica
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname LIKE 'wa_%'
  AND NOT EXISTS (SELECT 1 FROM pg_policies p WHERE p.tablename = c.relname AND 'app_wa' = ANY(p.roles));

-- ── 3. Probar la conexión ANTES de tocar producción ─────────────────────────
-- El pooler de Supabase (modo sesión, puerto 5432) usa el usuario con el project-ref
-- pegado: `app_wa.<project-ref>` (hoy `app_wa.mfwyocxzmhzsuhidvuhp`). Desde el droplet:
--
--   psql "postgresql://app_wa.mfwyocxzmhzsuhidvuhp:CLAVE@aws-1-us-east-1.pooler.supabase.com:5432/postgres" \
--     -c "SELECT count(*) FROM wa_tenants"            -- debe dar 0 (sin contexto no ve nada)
--   psql "...mismo URL..." -c "BEGIN; SELECT set_config('app.sistema','on',true); SELECT count(*) FROM wa_tenants; COMMIT;"
--                                                    -- debe dar la cantidad real de negocios
--
-- Si el pooler rechaza el rol custom, usá la conexión DIRECTA (db.<ref>.supabase.co:5432)
-- para la app y revisá DB_POOL_MAX contra su límite de conexiones (más bajo).

-- ── 4. Repuntar la app ──────────────────────────────────────────────────────
-- En el .env del droplet quedan DOS URLs, con roles distintos y a propósito:
--
--   DATABASE_URL              → rol app_wa   (la app: sin DDL, sin BYPASSRLS)
--   DATABASE_URL_MIGRACIONES  → rol postgres (migrar.ts, seedTenants.ts y demás scripts)
--
-- `pm2 reload whatsapp-bot --update-env` y verificar /salud?detalle=1 + un mensaje de prueba
-- de punta a punta (entra, responde, aparece en el panel).

-- ── 5. Rollback ─────────────────────────────────────────────────────────────
-- Volver DATABASE_URL al rol postgres y recargar. El rol puede quedar creado sin efecto;
-- para quitarle el acceso:
--   ALTER ROLE app_wa NOLOGIN;
