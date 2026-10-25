-- I6.6 · Stripe e I6.7 · Alta self-service: eventos de Stripe procesados (idempotencia del
-- webhook, solo sistema), cliente y suscripción de Stripe y fin de la prueba gratis del
-- negocio, cuenta con el correo sin verificar y el token de verificación del correo.
CREATE TABLE "stripe_events" (
	"id" text PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"business_id" uuid,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "stripe_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "auth_tokens" DROP CONSTRAINT "auth_tokens_kind_check";--> statement-breakpoint
ALTER TABLE "businesses" ADD COLUMN "stripe_customer_id" text;--> statement-breakpoint
ALTER TABLE "businesses" ADD COLUMN "stripe_subscription_id" text;--> statement-breakpoint
ALTER TABLE "businesses" ADD COLUMN "trial_ends_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "email_verification_pending" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "stripe_events" ADD CONSTRAINT "stripe_events_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "stripe_events_received_idx" ON "stripe_events" USING btree ("received_at");--> statement-breakpoint
CREATE UNIQUE INDEX "businesses_stripe_customer_uq" ON "businesses" USING btree ("stripe_customer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "businesses_stripe_subscription_uq" ON "businesses" USING btree ("stripe_subscription_id");--> statement-breakpoint
CREATE INDEX "businesses_trial_ends_idx" ON "businesses" USING btree ("trial_ends_at") WHERE "businesses"."trial_ends_at" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "auth_tokens" ADD CONSTRAINT "auth_tokens_kind_check" CHECK ("auth_tokens"."kind" IN ('password_reset', 'invitation', 'email_verification'));--> statement-breakpoint
CREATE POLICY "system_only" ON "stripe_events" AS PERMISSIVE FOR ALL TO "app_runtime" USING (current_setting('app.system', true) = 'on') WITH CHECK (current_setting('app.system', true) = 'on');