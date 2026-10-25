-- I6.1–I6.4 · Crecimiento: seguimiento post-servicio (reseñas) y upsell en la configuración
-- del agente, y una sola cotización ABIERTA por cliente y servicio (rescate de cotizaciones).
ALTER TABLE "ai_settings" ADD COLUMN "follow_up" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_settings" ADD COLUMN "upsell" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "quotes_open_client_service_uq" ON "quotes" USING btree ("client_id","service_id") WHERE "quotes"."status" IN ('pending', 'first_touch', 'second_touch');