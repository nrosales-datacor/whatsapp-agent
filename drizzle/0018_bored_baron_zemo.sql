ALTER TABLE "wa_usuarios" ADD COLUMN "debe_cambiar_clave" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "wa_usuarios" ADD COLUMN "clave_temporal_expira" timestamp with time zone;