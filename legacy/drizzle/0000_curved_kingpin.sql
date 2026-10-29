CREATE TABLE "wa_citas" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"cliente_wa" text NOT NULL,
	"cliente_nombre" text NOT NULL,
	"servicio_id" text NOT NULL,
	"fecha" text NOT NULL,
	"hora" text NOT NULL,
	"placa" text,
	"estado" text DEFAULT 'agendada' NOT NULL,
	"creada_en" timestamp with time zone DEFAULT now() NOT NULL,
	"gcal_event_id" text,
	"recordatorio_dia_antes_en" timestamp with time zone,
	"recordatorio_mismo_dia_en" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "wa_conversaciones" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"cliente_wa" text NOT NULL,
	"opt_in_en" timestamp with time zone,
	"creada_en" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wa_eventos_calidad" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"cliente_wa" text NOT NULL,
	"tipo" text NOT NULL,
	"detalle" text,
	"creado_en" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wa_mensajes" (
	"id" text PRIMARY KEY NOT NULL,
	"conversacion_id" text NOT NULL,
	"rol" text NOT NULL,
	"contenido" text NOT NULL,
	"creado_en" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "wa_mensajes" ADD CONSTRAINT "wa_mensajes_conversacion_id_wa_conversaciones_id_fk" FOREIGN KEY ("conversacion_id") REFERENCES "public"."wa_conversaciones"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "wa_citas_tenant_fecha_idx" ON "wa_citas" USING btree ("tenant_id","fecha");--> statement-breakpoint
CREATE UNIQUE INDEX "wa_conv_tenant_cliente_uq" ON "wa_conversaciones" USING btree ("tenant_id","cliente_wa");--> statement-breakpoint
CREATE INDEX "wa_conv_tenant_idx" ON "wa_conversaciones" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "wa_eventos_tenant_idx" ON "wa_eventos_calidad" USING btree ("tenant_id","creado_en");--> statement-breakpoint
CREATE INDEX "wa_msg_conv_idx" ON "wa_mensajes" USING btree ("conversacion_id");