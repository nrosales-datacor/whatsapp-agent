ALTER TABLE "wa_mensajes" DROP CONSTRAINT "wa_mensajes_conversacion_id_wa_conversaciones_id_fk";
--> statement-breakpoint
ALTER TABLE "wa_conversaciones" ADD COLUMN "leido_hasta" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "wa_mensajes" ADD COLUMN "wa_message_id" text;--> statement-breakpoint
ALTER TABLE "wa_mensajes" ADD CONSTRAINT "wa_mensajes_conversacion_id_wa_conversaciones_id_fk" FOREIGN KEY ("conversacion_id") REFERENCES "public"."wa_conversaciones"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "wa_msg_waid_uq" ON "wa_mensajes" USING btree ("wa_message_id");