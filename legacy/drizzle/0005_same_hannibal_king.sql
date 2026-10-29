CREATE TABLE "wa_tenants" (
	"id" text PRIMARY KEY NOT NULL,
	"nombre" text NOT NULL,
	"phone_number_id" text NOT NULL,
	"access_token" text,
	"timezone" text NOT NULL,
	"moneda" text NOT NULL,
	"ubicacion" text NOT NULL,
	"intervalo_agenda_min" integer DEFAULT 30 NOT NULL,
	"horario" jsonb NOT NULL,
	"servicios" jsonb NOT NULL,
	"kb" jsonb NOT NULL,
	"activo" boolean DEFAULT true NOT NULL,
	"creado_en" timestamp with time zone DEFAULT now() NOT NULL,
	"actualizado_en" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wa_usuarios" (
	"id" text PRIMARY KEY NOT NULL,
	"usuario" text NOT NULL,
	"password_hash" text NOT NULL,
	"tenant_id" text NOT NULL,
	"activo" boolean DEFAULT true NOT NULL,
	"creado_en" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "wa_usuarios" ADD CONSTRAINT "wa_usuarios_tenant_id_wa_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."wa_tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "wa_tenants_pnid_uq" ON "wa_tenants" USING btree ("phone_number_id");--> statement-breakpoint
CREATE UNIQUE INDEX "wa_usuarios_usuario_uq" ON "wa_usuarios" USING btree ("usuario");--> statement-breakpoint
CREATE INDEX "wa_usuarios_tenant_idx" ON "wa_usuarios" USING btree ("tenant_id");