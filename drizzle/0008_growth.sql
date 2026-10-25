ALTER TABLE "ai_settings" ADD COLUMN "follow_up" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_settings" ADD COLUMN "upsell" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "quotes_open_client_service_uq" ON "quotes" USING btree ("client_id","service_id") WHERE "quotes"."status" IN ('pending', 'first_touch', 'second_touch');