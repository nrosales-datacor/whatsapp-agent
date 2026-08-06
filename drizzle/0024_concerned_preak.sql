ALTER TABLE "wa_citas" ADD COLUMN "empleado_id" text;--> statement-breakpoint
ALTER TABLE "wa_tenants" ADD COLUMN "empleados" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "wa_citas_empleado_slot_uq" ON "wa_citas" USING btree ("tenant_id","empleado_id","fecha","hora") WHERE "wa_citas"."estado" = 'agendada' AND "wa_citas"."empleado_id" IS NOT NULL;