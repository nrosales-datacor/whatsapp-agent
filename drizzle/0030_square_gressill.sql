ALTER TABLE "wa_tenants" ADD COLUMN "tope_conversaciones_desactivado" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "wa_tenants" ADD COLUMN "mensaje_tope_excedido" text;