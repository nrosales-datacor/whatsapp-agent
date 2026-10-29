CREATE TABLE "wa_webhooks_crudos" (
	"id" text PRIMARY KEY NOT NULL,
	"payload" jsonb NOT NULL,
	"phone_number_id" text,
	"wa_message_id" text,
	"recibido_en" timestamp with time zone DEFAULT now() NOT NULL,
	"estado" text DEFAULT 'pendiente' NOT NULL,
	"motivo" text NOT NULL,
	"intentos" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "wa_webhooks_crudos_waid_uq" ON "wa_webhooks_crudos" USING btree ("wa_message_id");--> statement-breakpoint
CREATE INDEX "wa_webhooks_crudos_pendiente_idx" ON "wa_webhooks_crudos" USING btree ("estado","recibido_en");