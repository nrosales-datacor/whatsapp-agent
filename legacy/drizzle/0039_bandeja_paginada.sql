ALTER TABLE "wa_conversaciones" ADD COLUMN "ultima_actividad_en" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
-- Valor real para las conversaciones existentes: su último mensaje, o la creación si no tiene.
UPDATE "wa_conversaciones" c SET "ultima_actividad_en" = COALESCE(
  (SELECT max(m."creado_en") FROM "wa_mensajes" m WHERE m."conversacion_id" = c."id"),
  c."creada_en"
);--> statement-breakpoint
-- Cada mensaje nuevo (de cualquier camino de código, incluso uno viejo en la ventana del
-- deploy) actualiza la actividad de su conversación. GREATEST: un insert con fecha vieja
-- (backfill, tests) no la hace retroceder.
CREATE OR REPLACE FUNCTION wa_conversaciones_tocar_actividad() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE wa_conversaciones
     SET ultima_actividad_en = GREATEST(ultima_actividad_en, NEW.creado_en)
   WHERE id = NEW.conversacion_id;
  RETURN NULL;
END $$;--> statement-breakpoint
CREATE TRIGGER wa_mensajes_tocar_actividad AFTER INSERT ON "wa_mensajes" FOR EACH ROW EXECUTE FUNCTION wa_conversaciones_tocar_actividad();--> statement-breakpoint
CREATE INDEX "wa_citas_tenant_cliente_idx" ON "wa_citas" USING btree ("tenant_id","cliente_wa");--> statement-breakpoint
CREATE INDEX "wa_conv_tenant_actividad_idx" ON "wa_conversaciones" USING btree ("tenant_id","ultima_actividad_en");
