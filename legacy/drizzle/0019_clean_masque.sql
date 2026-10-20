CREATE TABLE "wa_cotizaciones" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"cliente_wa" text NOT NULL,
	"servicio_id" text NOT NULL,
	"monto" integer NOT NULL,
	"estado" text DEFAULT 'pendiente' NOT NULL,
	"cita_id" text,
	"monto_recuperado" integer,
	"creada_en" timestamp with time zone DEFAULT now() NOT NULL,
	"toque1_en" timestamp with time zone,
	"toque2_en" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "wa_tenants" ADD COLUMN "rescate_activo" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "wa_tenants" ADD COLUMN "rescate_horas_espera" integer DEFAULT 3 NOT NULL;--> statement-breakpoint
ALTER TABLE "wa_tenants" ADD COLUMN "rescate_toque1_texto" text;--> statement-breakpoint
ALTER TABLE "wa_tenants" ADD COLUMN "rescate_toque2_texto" text;--> statement-breakpoint
ALTER TABLE "wa_tenants" ADD COLUMN "rescate_plantilla" text;--> statement-breakpoint
CREATE INDEX "wa_cotizaciones_claim_idx" ON "wa_cotizaciones" USING btree ("tenant_id","estado","creada_en");--> statement-breakpoint
CREATE INDEX "wa_cotizaciones_cliente_idx" ON "wa_cotizaciones" USING btree ("tenant_id","cliente_wa");