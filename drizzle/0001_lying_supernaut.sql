CREATE TABLE "wa_push_subs" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"endpoint" text NOT NULL,
	"p256dh" text NOT NULL,
	"auth" text NOT NULL,
	"creada_en" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "wa_conversaciones" ADD COLUMN "modo" text DEFAULT 'bot' NOT NULL;--> statement-breakpoint
ALTER TABLE "wa_conversaciones" ADD COLUMN "humano_en" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "wa_conversaciones" ADD COLUMN "no_leidos" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "wa_mensajes" ADD COLUMN "por_humano" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "wa_push_endpoint_uq" ON "wa_push_subs" USING btree ("endpoint");--> statement-breakpoint
CREATE INDEX "wa_push_tenant_idx" ON "wa_push_subs" USING btree ("tenant_id");