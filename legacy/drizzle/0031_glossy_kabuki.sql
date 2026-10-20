CREATE TABLE "wa_tenants_historial" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"snapshot" jsonb NOT NULL,
	"usuario_id" text NOT NULL,
	"creado_en" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "wa_tenants_historial_tenant_idx" ON "wa_tenants_historial" USING btree ("tenant_id","creado_en");