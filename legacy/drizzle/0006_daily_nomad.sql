CREATE TABLE "wa_jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"tipo" text DEFAULT 'responder_entrante' NOT NULL,
	"estado" text DEFAULT 'pendiente' NOT NULL,
	"intentos" integer DEFAULT 0 NOT NULL,
	"max_intentos" integer DEFAULT 5 NOT NULL,
	"ejecutar_despues_de" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_at" timestamp with time zone,
	"creado_en" timestamp with time zone DEFAULT now() NOT NULL,
	"finalizado_en" timestamp with time zone,
	"payload" jsonb NOT NULL,
	"ultimo_error" text,
	"wa_message_id" text
);
--> statement-breakpoint
CREATE INDEX "wa_jobs_claim_idx" ON "wa_jobs" USING btree ("estado","ejecutar_despues_de");--> statement-breakpoint
CREATE UNIQUE INDEX "wa_jobs_waid_uq" ON "wa_jobs" USING btree ("wa_message_id");