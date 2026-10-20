CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid,
	"type" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 5 NOT NULL,
	"run_after" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_at" timestamp with time zone,
	"locked_by" text,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_error" text,
	"dedupe_key" text,
	"group_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "jobs_status_check" CHECK ("jobs"."status" IN ('pending', 'running', 'done', 'failed', 'dead')),
	CONSTRAINT "jobs_max_attempts_check" CHECK ("jobs"."max_attempts" >= 1)
);
--> statement-breakpoint
ALTER TABLE "jobs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE INDEX "jobs_ready_idx" ON "jobs" USING btree ("run_after") WHERE status IN ('pending', 'failed');--> statement-breakpoint
CREATE INDEX "jobs_running_idx" ON "jobs" USING btree ("business_id","group_key") WHERE status = 'running';--> statement-breakpoint
CREATE INDEX "jobs_business_locked_idx" ON "jobs" USING btree ("business_id","locked_at");--> statement-breakpoint
CREATE INDEX "jobs_finished_idx" ON "jobs" USING btree ("status","finished_at") WHERE status IN ('done', 'dead');--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_business_dedupe_key_unique" ON "jobs" USING btree ("business_id","dedupe_key") WHERE dedupe_key IS NOT NULL AND business_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_system_dedupe_key_unique" ON "jobs" USING btree ("dedupe_key") WHERE dedupe_key IS NOT NULL AND business_id IS NULL;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "jobs" AS PERMISSIVE FOR ALL TO "app_runtime" USING (business_id = nullif(current_setting('app.tenant_id', true), '')::uuid OR current_setting('app.system', true) = 'on') WITH CHECK (business_id = nullif(current_setting('app.tenant_id', true), '')::uuid OR current_setting('app.system', true) = 'on');