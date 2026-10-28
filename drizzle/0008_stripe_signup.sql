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
ALTER TABLE "businesses" ADD COLUMN "stripe_subscription_status" text;--> statement-breakpoint
ALTER TABLE "businesses" ADD COLUMN "current_period_end" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "businesses" ADD COLUMN "cancel_at_period_end" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "businesses" ADD COLUMN "stripe_synced_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "businesses" ADD COLUMN "trial_ends_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "businesses" ADD COLUMN "past_due_since" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "businesses" ADD COLUMN "billing_paused_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "businesses" ADD COLUMN "onboarding_dismissed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "email_unverified_since" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "stripe_events" ADD CONSTRAINT "stripe_events_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "stripe_events_business_idx" ON "stripe_events" USING btree ("business_id","received_at");--> statement-breakpoint
CREATE UNIQUE INDEX "businesses_stripe_customer_uq" ON "businesses" USING btree ("stripe_customer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "businesses_stripe_subscription_uq" ON "businesses" USING btree ("stripe_subscription_id");--> statement-breakpoint
ALTER TABLE "auth_tokens" ADD CONSTRAINT "auth_tokens_kind_check" CHECK ("auth_tokens"."kind" IN ('password_reset', 'invitation', 'email_verification'));--> statement-breakpoint
CREATE POLICY "system_only" ON "stripe_events" AS PERMISSIVE FOR ALL TO "app_runtime" USING (current_setting('app.system', true) = 'on') WITH CHECK (current_setting('app.system', true) = 'on');--> statement-breakpoint
-- Backfill (I6): la checklist de primeros pasos del Inicio es para los negocios NUEVOS. Los
-- que ya existían nacen con ella descartada (si no, a un negocio que ya opera le aparecería
-- "Agendá tu primera cita"). SQL a mano dentro de la migración generada: no cambia el
-- esquema, así que el snapshot sigue igual y `npm run db:check` no lo ve como drift.
UPDATE "businesses" SET "onboarding_dismissed_at" = now() WHERE "onboarding_dismissed_at" IS NULL;
