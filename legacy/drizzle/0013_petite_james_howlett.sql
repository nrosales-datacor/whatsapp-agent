CREATE TABLE "wa_campania_envios" (
	"id" text PRIMARY KEY NOT NULL,
	"campania_id" text NOT NULL,
	"tenant_id" text NOT NULL,
	"cliente_wa" text NOT NULL,
	"cliente_nombre" text NOT NULL,
	"estado" text DEFAULT 'pendiente' NOT NULL,
	"intentos" integer DEFAULT 0 NOT NULL,
	"error" text,
	"enviado_en" timestamp with time zone,
	"creado_en" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wa_campanias" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"nombre" text NOT NULL,
	"mensaje" text NOT NULL,
	"segmento_tipo" text NOT NULL,
	"segmento_parametros" jsonb NOT NULL,
	"estado" text DEFAULT 'borrador' NOT NULL,
	"programada_para" timestamp with time zone,
	"creada_en" timestamp with time zone DEFAULT now() NOT NULL,
	"iniciada_en" timestamp with time zone,
	"completada_en" timestamp with time zone,
	"total_destinatarios" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "wa_conversaciones" ADD COLUMN "opt_out_en" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "wa_tenants" ADD COLUMN "plantilla_marketing" text;--> statement-breakpoint
ALTER TABLE "wa_campania_envios" ADD CONSTRAINT "wa_campania_envios_campania_id_wa_campanias_id_fk" FOREIGN KEY ("campania_id") REFERENCES "public"."wa_campanias"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "wa_campania_envios_campania_cliente_uq" ON "wa_campania_envios" USING btree ("campania_id","cliente_wa");--> statement-breakpoint
CREATE INDEX "wa_campania_envios_claim_idx" ON "wa_campania_envios" USING btree ("estado");--> statement-breakpoint
CREATE INDEX "wa_campanias_tenant_idx" ON "wa_campanias" USING btree ("tenant_id","creada_en");