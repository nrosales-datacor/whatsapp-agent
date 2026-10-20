-- Migración base del esquema nuevo (Carril I, PLAN-GESTION.md §4 y §10). Las tablas y
-- políticas las genera drizzle-kit desde src/platform/**/schema.ts; lo de arriba y lo de
-- abajo de ellas es SQL a mano (drizzle-kit no maneja roles ni extensiones).
--
-- Rol de la app SIN BYPASSRLS. Se crea NOLOGIN (inofensivo); la clave y el LOGIN se le
-- dan a mano (scripts/rls/01-app-role.sql) antes de repuntar DATABASE_URL.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
    CREATE ROLE app_runtime NOLOGIN NOBYPASSRLS;
  END IF;
END $$;
--> statement-breakpoint
-- btree_gist: el EXCLUDE por profesional y rango de las citas (scheduling) lo necesita.
CREATE EXTENSION IF NOT EXISTS btree_gist;
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid,
	"action" text NOT NULL,
	"actor" text NOT NULL,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "audit_log" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "leader_leases" (
	"name" text PRIMARY KEY NOT NULL,
	"holder" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "leader_leases" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE INDEX "audit_log_business_created_idx" ON "audit_log" USING btree ("business_id","created_at");--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "audit_log" AS PERMISSIVE FOR ALL TO "app_runtime" USING (business_id = nullif(current_setting('app.tenant_id', true), '')::uuid OR current_setting('app.system', true) = 'on') WITH CHECK (business_id = nullif(current_setting('app.tenant_id', true), '')::uuid OR current_setting('app.system', true) = 'on');--> statement-breakpoint
CREATE POLICY "system_only" ON "leader_leases" AS PERMISSIVE FOR ALL TO "app_runtime" USING (current_setting('app.system', true) = 'on') WITH CHECK (current_setting('app.system', true) = 'on');
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO app_runtime;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "audit_log", "leader_leases" TO app_runtime;
--> statement-breakpoint
-- Las tablas que creen las migraciones siguientes (con el mismo rol que corre las
-- migraciones) nacen con los mismos permisos para la app: un módulo nuevo no queda sin
-- GRANT por olvido. RLS sigue aplicando: el GRANT solo habilita, la política filtra.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_runtime;
