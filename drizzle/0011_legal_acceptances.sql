CREATE TABLE "legal_acceptances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" text NOT NULL,
	"context" text NOT NULL,
	"terms_version" text NOT NULL,
	"privacy_version" text NOT NULL,
	"accepted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "legal_acceptances_role_check" CHECK ("legal_acceptances"."role" IN ('owner', 'admin', 'front_desk', 'staff')),
	CONSTRAINT "legal_acceptances_context_check" CHECK ("legal_acceptances"."context" IN ('signup', 'invitation', 'reacceptance')),
	CONSTRAINT "legal_acceptances_terms_version_check" CHECK ("legal_acceptances"."terms_version" ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
	CONSTRAINT "legal_acceptances_privacy_version_check" CHECK ("legal_acceptances"."privacy_version" ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$')
);
--> statement-breakpoint
ALTER TABLE "legal_acceptances" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "legal_acceptances" ADD CONSTRAINT "legal_acceptances_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legal_acceptances" ADD CONSTRAINT "legal_acceptances_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "legal_acceptances_business_user_idx" ON "legal_acceptances" USING btree ("business_id","user_id","accepted_at");--> statement-breakpoint
CREATE INDEX "legal_acceptances_user_idx" ON "legal_acceptances" USING btree ("user_id");--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "legal_acceptances" AS PERMISSIVE FOR ALL TO "app_runtime" USING (business_id = nullif(current_setting('app.tenant_id', true), '')::uuid OR current_setting('app.system', true) = 'on') WITH CHECK (business_id = nullif(current_setting('app.tenant_id', true), '')::uuid OR current_setting('app.system', true) = 'on');