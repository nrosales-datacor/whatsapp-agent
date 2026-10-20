ALTER TABLE "wa_tenants" ADD COLUMN "plan" text DEFAULT 'pro' NOT NULL;--> statement-breakpoint
ALTER TABLE "wa_tenants" ADD COLUMN "stripe_customer_id" text;--> statement-breakpoint
ALTER TABLE "wa_tenants" ADD COLUMN "stripe_subscription_id" text;--> statement-breakpoint
ALTER TABLE "wa_tenants" ADD COLUMN "estado_facturacion" text;--> statement-breakpoint
ALTER TABLE "wa_tenants" ADD COLUMN "facturacion_periodo_fin" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "wa_tenants_stripe_customer_uq" ON "wa_tenants" USING btree ("stripe_customer_id");