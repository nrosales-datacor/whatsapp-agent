-- Restricciones del dominio que drizzle-kit no expresa (PLAN-GESTION.md §4). SQL a mano,
-- en una migración custom (`drizzle-kit generate --custom`): su snapshot es idéntico al de
-- 0001, así que `npm run db:check` no lo ve como drift y, si se regeneran las migraciones
-- de las tablas, este archivo se conserva tal cual (va después de ellas).
-- test/reliability/appointmentOverlap.test.ts y test/reliability/domainSchema.test.ts
-- fallan si algo de esto se pierde.
--
-- 1. Anti-solape de citas por profesional (btree_gist lo crea 0000_platform_base.sql).
--    Dos citas VIVAS (pending/confirmed) del mismo profesional no pueden pisarse; las
--    canceladas, completadas y no-show no bloquean. Rango semiabierto '[)': 09:00–10:00 y
--    10:00–11:00 no chocan. Es la red de la base: la app igual chequea disponibilidad antes
--    de reservar, pero dos reservas simultáneas al mismo horario las frena esto (error
--    23P01, exclusion_violation), sin advisory locks. El índice gist que crea también sirve
--    para "citas de este profesional que se cruzan con este rango".
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_staff_no_overlap"
  EXCLUDE USING gist ("staff_id" WITH =, tstzrange("starts_at", "ends_at", '[)') WITH &&)
  WHERE ("status" IN ('pending', 'confirmed'));
--> statement-breakpoint
-- 2. FKs de las tablas de PLATAFORMA hacia tablas de módulos. La plataforma no importa de
--    src/modules (test/architecture/moduleBoundaries.test.ts), así que Drizzle no las
--    declara; la integridad la da igual la base.
ALTER TABLE "push_subscriptions" ADD CONSTRAINT "push_subscriptions_business_id_businesses_id_fk"
  FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "push_subscriptions" ADD CONSTRAINT "push_subscriptions_user_id_users_id_fk"
  FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "config_history" ADD CONSTRAINT "config_history_business_id_businesses_id_fk"
  FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "config_history" ADD CONSTRAINT "config_history_changed_by_users_id_fk"
  FOREIGN KEY ("changed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "daily_usage" ADD CONSTRAINT "daily_usage_business_id_businesses_id_fk"
  FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
-- 3. Última actividad de la conversación: cada mensaje nuevo (de cualquier camino de
--    código) la actualiza. La bandeja ordena y pagina por conversations.last_activity_at
--    con índice. GREATEST: un insert con fecha vieja (backfill, tests) no la hace
--    retroceder. SECURITY INVOKER (default): el UPDATE pasa por RLS con el mismo contexto
--    que el INSERT del mensaje, que es del mismo negocio.
CREATE OR REPLACE FUNCTION conversations_touch_activity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE conversations
     SET last_activity_at = GREATEST(last_activity_at, NEW.created_at)
   WHERE id = NEW.conversation_id;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE TRIGGER messages_touch_activity AFTER INSERT ON "messages"
  FOR EACH ROW EXECUTE FUNCTION conversations_touch_activity();
