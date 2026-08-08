ALTER TABLE "wa_uso_mensual" ADD COLUMN "tokens_entrada" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "wa_uso_mensual" ADD COLUMN "tokens_salida" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "wa_uso_mensual" ADD COLUMN "costo_estimado_millonesimos" bigint DEFAULT 0 NOT NULL;