CREATE TABLE "wa_uso_mensual" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"anio_mes" text NOT NULL,
	"conversaciones_iniciadas" integer DEFAULT 0 NOT NULL,
	"mensajes_entrantes" integer DEFAULT 0 NOT NULL,
	"mensajes_salientes" integer DEFAULT 0 NOT NULL,
	"plantillas_marketing" integer DEFAULT 0 NOT NULL,
	"plantillas_utilidad" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "wa_uso_mensual_tenant_mes_uq" ON "wa_uso_mensual" USING btree ("tenant_id","anio_mes");