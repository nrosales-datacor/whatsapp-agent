ALTER TABLE "wa_push_subs" ADD COLUMN "usuario_id" text;--> statement-breakpoint
ALTER TABLE "wa_push_subs" ADD COLUMN "session_epoch" integer;--> statement-breakpoint
ALTER TABLE "wa_push_subs" ADD CONSTRAINT "wa_push_subs_usuario_id_wa_usuarios_id_fk" FOREIGN KEY ("usuario_id") REFERENCES "public"."wa_usuarios"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "wa_push_usuario_idx" ON "wa_push_subs" USING btree ("usuario_id");