ALTER TABLE "businesses" ADD COLUMN "unpaid_since" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "businesses" ADD COLUMN "billing_paused_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "businesses" ADD COLUMN "onboarding_dismissed_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "businesses_unpaid_since_idx" ON "businesses" USING btree ("unpaid_since") WHERE "businesses"."unpaid_since" IS NOT NULL;