-- F1: rol de la app SIN BYPASSRLS. Se crea NOLOGIN (inofensivo); la clave y el LOGIN se
-- le dan a mano (scripts/rls/01-rol-aplicacion.sql) antes de repuntar DATABASE_URL.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_wa') THEN
    CREATE ROLE app_wa NOLOGIN NOBYPASSRLS;
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "wa_jobs" ADD COLUMN "conversacion_id" text;
--> statement-breakpoint
UPDATE "wa_jobs" SET "conversacion_id" = payload->'conv'->>'id' WHERE "conversacion_id" IS NULL;
--> statement-breakpoint
-- Ventana del deploy: un proceso con el código anterior encola jobs sin conversacion_id.
CREATE OR REPLACE FUNCTION wa_jobs_completar_conversacion() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.conversacion_id IS NULL THEN
    NEW.conversacion_id := NEW.payload->'conv'->>'id';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER wa_jobs_completar_conversacion BEFORE INSERT ON "wa_jobs" FOR EACH ROW EXECUTE FUNCTION wa_jobs_completar_conversacion();
--> statement-breakpoint
ALTER TABLE "wa_mensajes" ADD COLUMN "tenant_id" text;
--> statement-breakpoint
UPDATE "wa_mensajes" m SET "tenant_id" = c."tenant_id" FROM "wa_conversaciones" c WHERE m."conversacion_id" = c."id" AND m."tenant_id" IS NULL;
--> statement-breakpoint
-- Ventana del deploy: un proceso con el código anterior todavía puede insertar mensajes
-- sin tenant_id. El trigger lo completa desde la conversación.
CREATE OR REPLACE FUNCTION wa_mensajes_completar_tenant() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.tenant_id IS NULL THEN
    SELECT c.tenant_id INTO NEW.tenant_id FROM wa_conversaciones c WHERE c.id = NEW.conversacion_id;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER wa_mensajes_completar_tenant BEFORE INSERT ON "wa_mensajes" FOR EACH ROW EXECUTE FUNCTION wa_mensajes_completar_tenant();
--> statement-breakpoint
CREATE INDEX "wa_jobs_conv_idx" ON "wa_jobs" USING btree ("conversacion_id","creado_en");
--> statement-breakpoint
CREATE INDEX "wa_msg_conv_creado_idx" ON "wa_mensajes" USING btree ("conversacion_id","creado_en");
--> statement-breakpoint
DROP INDEX "wa_msg_conv_idx";
--> statement-breakpoint
CREATE POLICY "aislamiento_tenant" ON "wa_auditoria" AS PERMISSIVE FOR ALL TO "app_wa" USING (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.sistema', true) = 'on') WITH CHECK (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.sistema', true) = 'on');
--> statement-breakpoint
CREATE POLICY "aislamiento_tenant" ON "wa_campania_envios" AS PERMISSIVE FOR ALL TO "app_wa" USING (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.sistema', true) = 'on') WITH CHECK (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.sistema', true) = 'on');
--> statement-breakpoint
CREATE POLICY "aislamiento_tenant" ON "wa_campanias" AS PERMISSIVE FOR ALL TO "app_wa" USING (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.sistema', true) = 'on') WITH CHECK (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.sistema', true) = 'on');
--> statement-breakpoint
CREATE POLICY "aislamiento_tenant" ON "wa_citas" AS PERMISSIVE FOR ALL TO "app_wa" USING (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.sistema', true) = 'on') WITH CHECK (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.sistema', true) = 'on');
--> statement-breakpoint
CREATE POLICY "aislamiento_tenant" ON "wa_conversaciones" AS PERMISSIVE FOR ALL TO "app_wa" USING (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.sistema', true) = 'on') WITH CHECK (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.sistema', true) = 'on');
--> statement-breakpoint
CREATE POLICY "aislamiento_tenant" ON "wa_cotizaciones" AS PERMISSIVE FOR ALL TO "app_wa" USING (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.sistema', true) = 'on') WITH CHECK (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.sistema', true) = 'on');
--> statement-breakpoint
CREATE POLICY "aislamiento_tenant" ON "wa_eventos_calidad" AS PERMISSIVE FOR ALL TO "app_wa" USING (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.sistema', true) = 'on') WITH CHECK (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.sistema', true) = 'on');
--> statement-breakpoint
CREATE POLICY "aislamiento_tenant" ON "wa_jobs" AS PERMISSIVE FOR ALL TO "app_wa" USING (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.sistema', true) = 'on') WITH CHECK (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.sistema', true) = 'on');
--> statement-breakpoint
CREATE POLICY "solo_sistema" ON "wa_lideres" AS PERMISSIVE FOR ALL TO "app_wa" USING (current_setting('app.sistema', true) = 'on') WITH CHECK (current_setting('app.sistema', true) = 'on');
--> statement-breakpoint
CREATE POLICY "aislamiento_tenant" ON "wa_mensajes" AS PERMISSIVE FOR ALL TO "app_wa" USING (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.sistema', true) = 'on') WITH CHECK (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.sistema', true) = 'on');
--> statement-breakpoint
CREATE POLICY "aislamiento_tenant" ON "wa_push_subs" AS PERMISSIVE FOR ALL TO "app_wa" USING (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.sistema', true) = 'on') WITH CHECK (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.sistema', true) = 'on');
--> statement-breakpoint
CREATE POLICY "aislamiento_tenant" ON "wa_seguimientos" AS PERMISSIVE FOR ALL TO "app_wa" USING (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.sistema', true) = 'on') WITH CHECK (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.sistema', true) = 'on');
--> statement-breakpoint
CREATE POLICY "aislamiento_tenant" ON "wa_snapshot_reputacion" AS PERMISSIVE FOR ALL TO "app_wa" USING (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.sistema', true) = 'on') WITH CHECK (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.sistema', true) = 'on');
--> statement-breakpoint
CREATE POLICY "aislamiento_tenant" ON "wa_tenants" AS PERMISSIVE FOR ALL TO "app_wa" USING (id = current_setting('app.tenant_id', true) OR current_setting('app.sistema', true) = 'on') WITH CHECK (id = current_setting('app.tenant_id', true) OR current_setting('app.sistema', true) = 'on');
--> statement-breakpoint
CREATE POLICY "aislamiento_tenant" ON "wa_tenants_historial" AS PERMISSIVE FOR ALL TO "app_wa" USING (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.sistema', true) = 'on') WITH CHECK (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.sistema', true) = 'on');
--> statement-breakpoint
CREATE POLICY "aislamiento_tenant" ON "wa_uso_mensual" AS PERMISSIVE FOR ALL TO "app_wa" USING (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.sistema', true) = 'on') WITH CHECK (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.sistema', true) = 'on');
--> statement-breakpoint
CREATE POLICY "aislamiento_tenant" ON "wa_usuarios" AS PERMISSIVE FOR ALL TO "app_wa" USING (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.sistema', true) = 'on') WITH CHECK (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.sistema', true) = 'on');
--> statement-breakpoint
CREATE POLICY "solo_sistema" ON "wa_webhooks_crudos" AS PERMISSIVE FOR ALL TO "app_wa" USING (current_setting('app.sistema', true) = 'on') WITH CHECK (current_setting('app.sistema', true) = 'on');
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO app_wa;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "wa_conversaciones", "wa_mensajes", "wa_citas", "wa_eventos_calidad", "wa_push_subs", "wa_tenants", "wa_usuarios", "wa_tenants_historial", "wa_jobs", "wa_webhooks_crudos", "wa_campanias", "wa_campania_envios", "wa_uso_mensual", "wa_cotizaciones", "wa_seguimientos", "wa_snapshot_reputacion", "wa_lideres", "wa_auditoria" TO app_wa;
