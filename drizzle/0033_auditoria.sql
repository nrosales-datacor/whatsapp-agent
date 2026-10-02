CREATE TABLE "wa_auditoria" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"accion" text NOT NULL,
	"actor" text NOT NULL,
	"detalle" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"creado_en" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "wa_auditoria" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE INDEX "wa_auditoria_tenant_idx" ON "wa_auditoria" USING btree ("tenant_id","creado_en");