CREATE TABLE "wa_seguimientos" (
	"id" text PRIMARY KEY NOT NULL,
	"cita_id" text NOT NULL,
	"tenant_id" text NOT NULL,
	"enviado_en" timestamp with time zone DEFAULT now() NOT NULL,
	"sentimiento" text,
	"resena_solicitada" boolean DEFAULT false NOT NULL,
	"respuesta_texto" text
);
--> statement-breakpoint
CREATE TABLE "wa_snapshot_reputacion" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"fecha" text NOT NULL,
	"rating" numeric(3, 2) NOT NULL,
	"total_resenas" integer NOT NULL,
	"creada_en" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "wa_tenants" ADD COLUMN "google_place_id" text;--> statement-breakpoint
ALTER TABLE "wa_seguimientos" ADD CONSTRAINT "wa_seguimientos_cita_id_wa_citas_id_fk" FOREIGN KEY ("cita_id") REFERENCES "public"."wa_citas"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "wa_seguimientos_cita_uq" ON "wa_seguimientos" USING btree ("cita_id");--> statement-breakpoint
CREATE INDEX "wa_seguimientos_tenant_idx" ON "wa_seguimientos" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "wa_snapshot_reputacion_tenant_fecha_uq" ON "wa_snapshot_reputacion" USING btree ("tenant_id","fecha");