CREATE TABLE "config_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"entity" text NOT NULL,
	"entity_id" uuid,
	"snapshot" jsonb NOT NULL,
	"changed_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "config_history" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "daily_usage" (
	"business_id" uuid NOT NULL,
	"date" date NOT NULL,
	"metric" text NOT NULL,
	"value" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "daily_usage_business_id_date_metric_pk" PRIMARY KEY("business_id","date","metric"),
	CONSTRAINT "daily_usage_metric_check" CHECK ("daily_usage"."metric" ~ '^[a-z][a-z0-9_]*$')
);
--> statement-breakpoint
ALTER TABLE "daily_usage" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "push_subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"session_epoch" integer NOT NULL,
	"endpoint" text NOT NULL,
	"p256dh" text NOT NULL,
	"auth" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "push_subscriptions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "businesses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"industry" text DEFAULT 'generic' NOT NULL,
	"plan" text DEFAULT 'basic' NOT NULL,
	"extra_modules" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"currency" text DEFAULT 'CRC' NOT NULL,
	"country" text DEFAULT 'CR' NOT NULL,
	"timezone" text DEFAULT 'America/Costa_Rica' NOT NULL,
	"terminology" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"client_status_rules" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"reminder_channels" jsonb DEFAULT '["whatsapp"]'::jsonb NOT NULL,
	"branding" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"legal_name" text,
	"tax_id" text,
	"billing_email" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "businesses_slug_check" CHECK ("businesses"."slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
	CONSTRAINT "businesses_plan_check" CHECK ("businesses"."plan" IN ('basic', 'pro')),
	CONSTRAINT "businesses_status_check" CHECK ("businesses"."status" IN ('active', 'paused', 'closed')),
	CONSTRAINT "businesses_currency_check" CHECK ("businesses"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "businesses_country_check" CHECK ("businesses"."country" ~ '^[A-Z]{2}$'),
	CONSTRAINT "businesses_reminder_channels_check" CHECK (jsonb_typeof("businesses"."reminder_channels") = 'array' AND "businesses"."reminder_channels" <@ '["whatsapp", "email"]'::jsonb)
);
--> statement-breakpoint
ALTER TABLE "businesses" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "custom_fields" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"entity" text NOT NULL,
	"key" text NOT NULL,
	"label" text NOT NULL,
	"type" text NOT NULL,
	"options" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"required" boolean DEFAULT false NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "custom_fields_entity_check" CHECK ("custom_fields"."entity" IN ('client', 'appointment')),
	CONSTRAINT "custom_fields_type_check" CHECK ("custom_fields"."type" IN ('text', 'long_text', 'number', 'date', 'boolean', 'select', 'multi_select')),
	CONSTRAINT "custom_fields_key_check" CHECK ("custom_fields"."key" ~ '^[a-z][a-z0-9_]*$')
);
--> statement-breakpoint
ALTER TABLE "custom_fields" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "location_hours" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"weekday" smallint NOT NULL,
	"opens_at" time NOT NULL,
	"closes_at" time NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "location_hours_weekday_check" CHECK ("location_hours"."weekday" BETWEEN 0 AND 6),
	CONSTRAINT "location_hours_range_check" CHECK ("location_hours"."closes_at" > "location_hours"."opens_at")
);
--> statement-breakpoint
ALTER TABLE "location_hours" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "locations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"name" text NOT NULL,
	"address" text,
	"phone" text,
	"timezone" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "locations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "campaign_sends" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"campaign_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"error" text,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "campaign_sends_status_check" CHECK ("campaign_sends"."status" IN ('pending', 'processing', 'sent', 'failed', 'skipped'))
);
--> statement-breakpoint
ALTER TABLE "campaign_sends" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "campaigns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"name" text NOT NULL,
	"message" text NOT NULL,
	"segment" jsonb NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"scheduled_for" timestamp with time zone,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"total_recipients" integer DEFAULT 0 NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "campaigns_status_check" CHECK ("campaigns"."status" IN ('draft', 'scheduled', 'sending', 'completed', 'cancelled'))
);
--> statement-breakpoint
ALTER TABLE "campaigns" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "service_categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"name" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "service_categories" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "service_locations" (
	"service_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"business_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "service_locations_service_id_location_id_pk" PRIMARY KEY("service_id","location_id")
);
--> statement-breakpoint
ALTER TABLE "service_locations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "services" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"category_id" uuid,
	"name" text NOT NULL,
	"description" text,
	"duration_min" integer NOT NULL,
	"buffer_min" integer DEFAULT 0 NOT NULL,
	"price_cents" bigint DEFAULT 0 NOT NULL,
	"variable_price" boolean DEFAULT false NOT NULL,
	"online_booking" boolean DEFAULT true NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "services_duration_check" CHECK ("services"."duration_min" > 0),
	CONSTRAINT "services_buffer_check" CHECK ("services"."buffer_min" >= 0),
	CONSTRAINT "services_price_check" CHECK ("services"."price_cents" >= 0)
);
--> statement-breakpoint
ALTER TABLE "services" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "staff_services" (
	"staff_id" uuid NOT NULL,
	"service_id" uuid NOT NULL,
	"business_id" uuid NOT NULL,
	"price_cents" bigint,
	"duration_min" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "staff_services_staff_id_service_id_pk" PRIMARY KEY("staff_id","service_id"),
	CONSTRAINT "staff_services_price_check" CHECK ("staff_services"."price_cents" >= 0),
	CONSTRAINT "staff_services_duration_check" CHECK ("staff_services"."duration_min" > 0)
);
--> statement-breakpoint
ALTER TABLE "staff_services" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "clients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"name" text NOT NULL,
	"phone" text,
	"email" text,
	"birth_date" date,
	"guardian_id" uuid,
	"notes" text,
	"tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"source" text,
	"custom_data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"preferred_location_id" uuid,
	"preferred_staff_id" uuid,
	"preferred_channel" text,
	"vip" boolean DEFAULT false NOT NULL,
	"marketing_consent_at" timestamp with time zone,
	"marketing_opt_out_at" timestamp with time zone,
	"marketing_consent_requested_at" timestamp with time zone,
	"visit_count" integer DEFAULT 0 NOT NULL,
	"first_visit_at" timestamp with time zone,
	"last_visit_at" timestamp with time zone,
	"total_spent_cents" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "clients_phone_check" CHECK ("clients"."phone" ~ '^\+[1-9][0-9]{6,14}$'),
	CONSTRAINT "clients_preferred_channel_check" CHECK ("clients"."preferred_channel" IN ('whatsapp', 'email')),
	CONSTRAINT "clients_guardian_check" CHECK ("clients"."guardian_id" <> "clients"."id")
);
--> statement-breakpoint
ALTER TABLE "clients" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "commission_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"staff_id" uuid NOT NULL,
	"appointment_service_id" uuid NOT NULL,
	"base_cents" bigint NOT NULL,
	"amount_cents" bigint NOT NULL,
	"rule" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"payout_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "commission_entries_status_check" CHECK ("commission_entries"."status" IN ('pending', 'paid')),
	CONSTRAINT "commission_entries_amounts_check" CHECK ("commission_entries"."base_cents" >= 0 AND "commission_entries"."amount_cents" >= 0),
	CONSTRAINT "commission_entries_paid_check" CHECK ("commission_entries"."status" <> 'paid' OR "commission_entries"."payout_id" IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "commission_entries" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "commission_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"staff_id" uuid,
	"service_id" uuid,
	"category_id" uuid,
	"kind" text NOT NULL,
	"value" bigint NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "commission_rules_scope_uq" UNIQUE NULLS NOT DISTINCT("business_id","staff_id","service_id","category_id"),
	CONSTRAINT "commission_rules_kind_check" CHECK ("commission_rules"."kind" IN ('percent', 'fixed')),
	CONSTRAINT "commission_rules_value_check" CHECK ("commission_rules"."value" >= 0 AND ("commission_rules"."kind" <> 'percent' OR "commission_rules"."value" <= 10000)),
	CONSTRAINT "commission_rules_scope_check" CHECK ("commission_rules"."service_id" IS NULL OR "commission_rules"."category_id" IS NULL)
);
--> statement-breakpoint
ALTER TABLE "commission_rules" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "payouts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"staff_id" uuid NOT NULL,
	"period_start" date NOT NULL,
	"period_end" date NOT NULL,
	"total_cents" bigint NOT NULL,
	"paid_at" timestamp with time zone,
	"paid_by" uuid,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payouts_period_check" CHECK ("payouts"."period_end" >= "payouts"."period_start"),
	CONSTRAINT "payouts_total_check" CHECK ("payouts"."total_cents" >= 0)
);
--> statement-breakpoint
ALTER TABLE "payouts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "payment_methods" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"name" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "payment_methods" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"appointment_id" uuid,
	"kind" text DEFAULT 'payment' NOT NULL,
	"amount_cents" bigint NOT NULL,
	"payment_method_id" uuid NOT NULL,
	"recorded_by" uuid,
	"paid_at" timestamp with time zone DEFAULT now() NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payments_kind_check" CHECK ("payments"."kind" IN ('deposit', 'payment', 'refund')),
	CONSTRAINT "payments_amount_check" CHECK ("payments"."amount_cents" > 0)
);
--> statement-breakpoint
ALTER TABLE "payments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "appointment_services" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"appointment_id" uuid NOT NULL,
	"service_id" uuid,
	"name" text NOT NULL,
	"duration_min" integer NOT NULL,
	"price_cents" bigint NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "appointment_services_duration_check" CHECK ("appointment_services"."duration_min" > 0),
	CONSTRAINT "appointment_services_price_check" CHECK ("appointment_services"."price_cents" >= 0)
);
--> statement-breakpoint
ALTER TABLE "appointment_services" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "appointments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"staff_id" uuid NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"channel" text DEFAULT 'panel' NOT NULL,
	"total_cents" bigint DEFAULT 0 NOT NULL,
	"notes" text,
	"custom_data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by" uuid,
	"confirmed_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"cancellation_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "appointments_range_check" CHECK ("appointments"."ends_at" > "appointments"."starts_at"),
	CONSTRAINT "appointments_status_check" CHECK ("appointments"."status" IN ('pending', 'confirmed', 'completed', 'cancelled', 'no_show')),
	CONSTRAINT "appointments_channel_check" CHECK ("appointments"."channel" IN ('whatsapp_ai', 'panel', 'phone', 'walk_in', 'web')),
	CONSTRAINT "appointments_total_check" CHECK ("appointments"."total_cents" >= 0)
);
--> statement-breakpoint
ALTER TABLE "appointments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "reminders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"appointment_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"channel" text NOT NULL,
	"scheduled_for" timestamp with time zone NOT NULL,
	"sent_at" timestamp with time zone,
	"status" text DEFAULT 'pending' NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reminders_kind_check" CHECK ("reminders"."kind" IN ('day_before', 'same_day')),
	CONSTRAINT "reminders_channel_check" CHECK ("reminders"."channel" IN ('whatsapp', 'email')),
	CONSTRAINT "reminders_status_check" CHECK ("reminders"."status" IN ('pending', 'sent', 'failed', 'cancelled', 'skipped'))
);
--> statement-breakpoint
ALTER TABLE "reminders" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "membership_locations" (
	"membership_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"business_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "membership_locations_membership_id_location_id_pk" PRIMARY KEY("membership_id","location_id")
);
--> statement-breakpoint
ALTER TABLE "membership_locations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "memberships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memberships_role_check" CHECK ("memberships"."role" IN ('owner', 'admin', 'front_desk', 'staff'))
);
--> statement-breakpoint
ALTER TABLE "memberships" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "staff" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"membership_id" uuid,
	"name" text NOT NULL,
	"color" text,
	"active" boolean DEFAULT true NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "staff_color_check" CHECK ("staff"."color" ~ '^#[0-9a-fA-F]{6}$')
);
--> statement-breakpoint
ALTER TABLE "staff" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "staff_hours" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"staff_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"weekday" smallint NOT NULL,
	"starts_at" time NOT NULL,
	"ends_at" time NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "staff_hours_weekday_check" CHECK ("staff_hours"."weekday" BETWEEN 0 AND 6),
	CONSTRAINT "staff_hours_range_check" CHECK ("staff_hours"."ends_at" > "staff_hours"."starts_at")
);
--> statement-breakpoint
ALTER TABLE "staff_hours" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "time_off" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"location_id" uuid,
	"staff_id" uuid,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "time_off_range_check" CHECK ("time_off"."ends_at" > "time_off"."starts_at")
);
--> statement-breakpoint
ALTER TABLE "time_off" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"password_hash" text,
	"totp_secret" text,
	"session_epoch" integer DEFAULT 0 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_check" CHECK ("users"."email" = lower("users"."email") AND position('@' in "users"."email") > 1)
);
--> statement-breakpoint
ALTER TABLE "users" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "ai_settings" (
	"business_id" uuid PRIMARY KEY NOT NULL,
	"tone" text,
	"register" text,
	"instructions" text,
	"knowledge" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"faq" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"texts" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"quote_recovery" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"review_url" text,
	"google_place_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_settings_register_check" CHECK ("ai_settings"."register" IN ('vos', 'tu', 'usted'))
);
--> statement-breakpoint
ALTER TABLE "ai_settings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "ai_usage_monthly" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"month" date NOT NULL,
	"conversations_started" integer DEFAULT 0 NOT NULL,
	"messages_in" integer DEFAULT 0 NOT NULL,
	"messages_out" integer DEFAULT 0 NOT NULL,
	"marketing_templates" integer DEFAULT 0 NOT NULL,
	"utility_templates" integer DEFAULT 0 NOT NULL,
	"input_tokens" bigint DEFAULT 0 NOT NULL,
	"output_tokens" bigint DEFAULT 0 NOT NULL,
	"estimated_cost_usd_micros" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_usage_monthly_month_check" CHECK (extract(day from "ai_usage_monthly"."month") = 1)
);
--> statement-breakpoint
ALTER TABLE "ai_usage_monthly" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"mode" text DEFAULT 'bot' NOT NULL,
	"human_since" timestamp with time zone,
	"status" text DEFAULT 'open' NOT NULL,
	"read_until" timestamp with time zone,
	"declined_upsells" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"bot_notice_sent_at" timestamp with time zone,
	"last_activity_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversations_mode_check" CHECK ("conversations"."mode" IN ('bot', 'human')),
	CONSTRAINT "conversations_status_check" CHECK ("conversations"."status" IN ('open', 'resolved'))
);
--> statement-breakpoint
ALTER TABLE "conversations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "follow_ups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"appointment_id" uuid NOT NULL,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sentiment" text,
	"review_requested" boolean DEFAULT false NOT NULL,
	"response_text" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "follow_ups_sentiment_check" CHECK ("follow_ups"."sentiment" IN ('positive', 'neutral', 'negative'))
);
--> statement-breakpoint
ALTER TABLE "follow_ups" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"role" text NOT NULL,
	"content" text NOT NULL,
	"by_human" boolean DEFAULT false NOT NULL,
	"wa_message_id" text,
	"media_path" text,
	"media_type" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "messages_role_check" CHECK ("messages"."role" IN ('user', 'assistant')),
	CONSTRAINT "messages_media_type_check" CHECK ("messages"."media_type" IN ('image', 'audio', 'document'))
);
--> statement-breakpoint
ALTER TABLE "messages" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "quotes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"service_id" uuid,
	"amount_cents" bigint NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"appointment_id" uuid,
	"recovered_cents" bigint,
	"first_touch_at" timestamp with time zone,
	"second_touch_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "quotes_status_check" CHECK ("quotes"."status" IN ('pending', 'first_touch', 'second_touch', 'booked', 'recovered', 'discarded', 'opted_out')),
	CONSTRAINT "quotes_amount_check" CHECK ("quotes"."amount_cents" >= 0)
);
--> statement-breakpoint
ALTER TABLE "quotes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "raw_webhooks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"payload" jsonb NOT NULL,
	"phone_number_id" text,
	"wa_message_id" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"reason" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "raw_webhooks_status_check" CHECK ("raw_webhooks"."status" IN ('pending', 'processed', 'discarded')),
	CONSTRAINT "raw_webhooks_reason_check" CHECK ("raw_webhooks"."reason" IN ('unknown_channel', 'unparseable'))
);
--> statement-breakpoint
ALTER TABLE "raw_webhooks" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "whatsapp_channels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"location_id" uuid,
	"phone_number_id" text NOT NULL,
	"waba_id" text,
	"display_phone" text,
	"access_token_encrypted" text,
	"templates" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "whatsapp_channels_status_check" CHECK ("whatsapp_channels"."status" IN ('pending', 'active', 'disconnected'))
);
--> statement-breakpoint
ALTER TABLE "whatsapp_channels" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "custom_fields" ADD CONSTRAINT "custom_fields_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "location_hours" ADD CONSTRAINT "location_hours_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "location_hours" ADD CONSTRAINT "location_hours_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "locations" ADD CONSTRAINT "locations_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_sends" ADD CONSTRAINT "campaign_sends_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_sends" ADD CONSTRAINT "campaign_sends_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_sends" ADD CONSTRAINT "campaign_sends_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_categories" ADD CONSTRAINT "service_categories_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_locations" ADD CONSTRAINT "service_locations_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_locations" ADD CONSTRAINT "service_locations_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_locations" ADD CONSTRAINT "service_locations_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "services" ADD CONSTRAINT "services_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "services" ADD CONSTRAINT "services_category_id_service_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."service_categories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_services" ADD CONSTRAINT "staff_services_staff_id_staff_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."staff"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_services" ADD CONSTRAINT "staff_services_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_services" ADD CONSTRAINT "staff_services_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clients" ADD CONSTRAINT "clients_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clients" ADD CONSTRAINT "clients_guardian_id_clients_id_fk" FOREIGN KEY ("guardian_id") REFERENCES "public"."clients"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clients" ADD CONSTRAINT "clients_preferred_location_id_locations_id_fk" FOREIGN KEY ("preferred_location_id") REFERENCES "public"."locations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clients" ADD CONSTRAINT "clients_preferred_staff_id_staff_id_fk" FOREIGN KEY ("preferred_staff_id") REFERENCES "public"."staff"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commission_entries" ADD CONSTRAINT "commission_entries_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commission_entries" ADD CONSTRAINT "commission_entries_staff_id_staff_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."staff"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commission_entries" ADD CONSTRAINT "commission_entries_appointment_service_id_appointment_services_id_fk" FOREIGN KEY ("appointment_service_id") REFERENCES "public"."appointment_services"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commission_entries" ADD CONSTRAINT "commission_entries_payout_id_payouts_id_fk" FOREIGN KEY ("payout_id") REFERENCES "public"."payouts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commission_rules" ADD CONSTRAINT "commission_rules_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commission_rules" ADD CONSTRAINT "commission_rules_staff_id_staff_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."staff"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commission_rules" ADD CONSTRAINT "commission_rules_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commission_rules" ADD CONSTRAINT "commission_rules_category_id_service_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."service_categories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_staff_id_staff_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."staff"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_paid_by_users_id_fk" FOREIGN KEY ("paid_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_methods" ADD CONSTRAINT "payment_methods_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_appointment_id_appointments_id_fk" FOREIGN KEY ("appointment_id") REFERENCES "public"."appointments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_payment_method_id_payment_methods_id_fk" FOREIGN KEY ("payment_method_id") REFERENCES "public"."payment_methods"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_recorded_by_users_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment_services" ADD CONSTRAINT "appointment_services_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment_services" ADD CONSTRAINT "appointment_services_appointment_id_appointments_id_fk" FOREIGN KEY ("appointment_id") REFERENCES "public"."appointments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment_services" ADD CONSTRAINT "appointment_services_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_staff_id_staff_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."staff"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reminders" ADD CONSTRAINT "reminders_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reminders" ADD CONSTRAINT "reminders_appointment_id_appointments_id_fk" FOREIGN KEY ("appointment_id") REFERENCES "public"."appointments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "membership_locations" ADD CONSTRAINT "membership_locations_membership_id_memberships_id_fk" FOREIGN KEY ("membership_id") REFERENCES "public"."memberships"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "membership_locations" ADD CONSTRAINT "membership_locations_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "membership_locations" ADD CONSTRAINT "membership_locations_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff" ADD CONSTRAINT "staff_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff" ADD CONSTRAINT "staff_membership_id_memberships_id_fk" FOREIGN KEY ("membership_id") REFERENCES "public"."memberships"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_hours" ADD CONSTRAINT "staff_hours_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_hours" ADD CONSTRAINT "staff_hours_staff_id_staff_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."staff"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_hours" ADD CONSTRAINT "staff_hours_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_off" ADD CONSTRAINT "time_off_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_off" ADD CONSTRAINT "time_off_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_off" ADD CONSTRAINT "time_off_staff_id_staff_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."staff"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_settings" ADD CONSTRAINT "ai_settings_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_usage_monthly" ADD CONSTRAINT "ai_usage_monthly_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_channel_id_whatsapp_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."whatsapp_channels"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "follow_ups" ADD CONSTRAINT "follow_ups_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "follow_ups" ADD CONSTRAINT "follow_ups_appointment_id_appointments_id_fk" FOREIGN KEY ("appointment_id") REFERENCES "public"."appointments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_appointment_id_appointments_id_fk" FOREIGN KEY ("appointment_id") REFERENCES "public"."appointments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "whatsapp_channels" ADD CONSTRAINT "whatsapp_channels_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "whatsapp_channels" ADD CONSTRAINT "whatsapp_channels_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "config_history_business_entity_idx" ON "config_history" USING btree ("business_id","entity","created_at");--> statement-breakpoint
CREATE INDEX "daily_usage_metric_date_idx" ON "daily_usage" USING btree ("metric","date");--> statement-breakpoint
CREATE UNIQUE INDEX "push_subscriptions_endpoint_uq" ON "push_subscriptions" USING btree ("endpoint");--> statement-breakpoint
CREATE INDEX "push_subscriptions_business_idx" ON "push_subscriptions" USING btree ("business_id");--> statement-breakpoint
CREATE INDEX "push_subscriptions_user_idx" ON "push_subscriptions" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "businesses_slug_uq" ON "businesses" USING btree ("slug");--> statement-breakpoint
CREATE UNIQUE INDEX "custom_fields_business_entity_key_uq" ON "custom_fields" USING btree ("business_id","entity","key");--> statement-breakpoint
CREATE INDEX "location_hours_location_idx" ON "location_hours" USING btree ("location_id","weekday");--> statement-breakpoint
CREATE INDEX "locations_business_idx" ON "locations" USING btree ("business_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "campaign_sends_campaign_client_uq" ON "campaign_sends" USING btree ("campaign_id","client_id");--> statement-breakpoint
CREATE INDEX "campaign_sends_campaign_status_idx" ON "campaign_sends" USING btree ("campaign_id","status");--> statement-breakpoint
CREATE INDEX "campaign_sends_client_idx" ON "campaign_sends" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "campaigns_business_created_idx" ON "campaigns" USING btree ("business_id","created_at");--> statement-breakpoint
CREATE INDEX "service_categories_business_idx" ON "service_categories" USING btree ("business_id","position");--> statement-breakpoint
CREATE INDEX "service_locations_location_idx" ON "service_locations" USING btree ("location_id");--> statement-breakpoint
CREATE INDEX "services_business_idx" ON "services" USING btree ("business_id","category_id","position");--> statement-breakpoint
CREATE INDEX "staff_services_service_idx" ON "staff_services" USING btree ("service_id");--> statement-breakpoint
CREATE UNIQUE INDEX "clients_business_phone_uq" ON "clients" USING btree ("business_id","phone");--> statement-breakpoint
CREATE INDEX "clients_business_name_idx" ON "clients" USING btree ("business_id","name");--> statement-breakpoint
CREATE INDEX "clients_business_last_visit_idx" ON "clients" USING btree ("business_id","last_visit_at");--> statement-breakpoint
CREATE INDEX "clients_business_email_idx" ON "clients" USING btree ("business_id","email");--> statement-breakpoint
CREATE UNIQUE INDEX "commission_entries_line_uq" ON "commission_entries" USING btree ("appointment_service_id");--> statement-breakpoint
CREATE INDEX "commission_entries_staff_status_idx" ON "commission_entries" USING btree ("staff_id","status","created_at");--> statement-breakpoint
CREATE INDEX "commission_entries_payout_idx" ON "commission_entries" USING btree ("payout_id");--> statement-breakpoint
CREATE INDEX "payouts_staff_period_idx" ON "payouts" USING btree ("staff_id","period_start");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_methods_business_name_uq" ON "payment_methods" USING btree ("business_id","name");--> statement-breakpoint
CREATE INDEX "payments_location_paid_idx" ON "payments" USING btree ("business_id","location_id","paid_at");--> statement-breakpoint
CREATE INDEX "payments_business_paid_idx" ON "payments" USING btree ("business_id","paid_at");--> statement-breakpoint
CREATE INDEX "payments_appointment_idx" ON "payments" USING btree ("appointment_id");--> statement-breakpoint
CREATE INDEX "payments_client_paid_idx" ON "payments" USING btree ("client_id","paid_at");--> statement-breakpoint
CREATE INDEX "appointment_services_appointment_idx" ON "appointment_services" USING btree ("appointment_id","position");--> statement-breakpoint
CREATE INDEX "appointment_services_service_idx" ON "appointment_services" USING btree ("service_id");--> statement-breakpoint
CREATE INDEX "appointments_location_starts_idx" ON "appointments" USING btree ("business_id","location_id","starts_at");--> statement-breakpoint
CREATE INDEX "appointments_business_starts_idx" ON "appointments" USING btree ("business_id","starts_at");--> statement-breakpoint
CREATE INDEX "appointments_staff_starts_idx" ON "appointments" USING btree ("staff_id","starts_at");--> statement-breakpoint
CREATE INDEX "appointments_client_starts_idx" ON "appointments" USING btree ("client_id","starts_at");--> statement-breakpoint
CREATE UNIQUE INDEX "reminders_appointment_kind_uq" ON "reminders" USING btree ("appointment_id","kind");--> statement-breakpoint
CREATE INDEX "reminders_due_idx" ON "reminders" USING btree ("scheduled_for") WHERE "reminders"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "membership_locations_location_idx" ON "membership_locations" USING btree ("location_id");--> statement-breakpoint
CREATE UNIQUE INDEX "memberships_business_user_uq" ON "memberships" USING btree ("business_id","user_id");--> statement-breakpoint
CREATE INDEX "memberships_user_idx" ON "memberships" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "staff_business_idx" ON "staff" USING btree ("business_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "staff_membership_uq" ON "staff" USING btree ("membership_id");--> statement-breakpoint
CREATE INDEX "staff_hours_staff_idx" ON "staff_hours" USING btree ("staff_id","weekday");--> statement-breakpoint
CREATE INDEX "staff_hours_location_idx" ON "staff_hours" USING btree ("location_id","weekday");--> statement-breakpoint
CREATE INDEX "time_off_business_starts_idx" ON "time_off" USING btree ("business_id","starts_at");--> statement-breakpoint
CREATE INDEX "time_off_staff_starts_idx" ON "time_off" USING btree ("staff_id","starts_at");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_uq" ON "users" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "ai_usage_monthly_business_month_uq" ON "ai_usage_monthly" USING btree ("business_id","month");--> statement-breakpoint
CREATE UNIQUE INDEX "conversations_channel_client_uq" ON "conversations" USING btree ("channel_id","client_id");--> statement-breakpoint
CREATE INDEX "conversations_business_activity_idx" ON "conversations" USING btree ("business_id","last_activity_at");--> statement-breakpoint
CREATE INDEX "conversations_client_idx" ON "conversations" USING btree ("client_id");--> statement-breakpoint
CREATE UNIQUE INDEX "follow_ups_appointment_uq" ON "follow_ups" USING btree ("appointment_id");--> statement-breakpoint
CREATE INDEX "follow_ups_business_sent_idx" ON "follow_ups" USING btree ("business_id","sent_at");--> statement-breakpoint
CREATE INDEX "messages_conversation_created_idx" ON "messages" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "messages_wa_message_id_uq" ON "messages" USING btree ("wa_message_id");--> statement-breakpoint
CREATE INDEX "quotes_business_status_created_idx" ON "quotes" USING btree ("business_id","status","created_at");--> statement-breakpoint
CREATE INDEX "quotes_client_idx" ON "quotes" USING btree ("client_id");--> statement-breakpoint
CREATE UNIQUE INDEX "raw_webhooks_wa_message_id_uq" ON "raw_webhooks" USING btree ("wa_message_id");--> statement-breakpoint
CREATE INDEX "raw_webhooks_status_received_idx" ON "raw_webhooks" USING btree ("status","received_at");--> statement-breakpoint
CREATE UNIQUE INDEX "whatsapp_channels_phone_number_id_uq" ON "whatsapp_channels" USING btree ("phone_number_id");--> statement-breakpoint
CREATE INDEX "whatsapp_channels_business_idx" ON "whatsapp_channels" USING btree ("business_id");--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "config_history" AS PERMISSIVE FOR ALL TO "app_runtime" USING (business_id = nullif(current_setting('app.tenant_id', true), '')::uuid OR current_setting('app.system', true) = 'on') WITH CHECK (business_id = nullif(current_setting('app.tenant_id', true), '')::uuid OR current_setting('app.system', true) = 'on');--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "daily_usage" AS PERMISSIVE FOR ALL TO "app_runtime" USING (business_id = nullif(current_setting('app.tenant_id', true), '')::uuid OR current_setting('app.system', true) = 'on') WITH CHECK (business_id = nullif(current_setting('app.tenant_id', true), '')::uuid OR current_setting('app.system', true) = 'on');--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "push_subscriptions" AS PERMISSIVE FOR ALL TO "app_runtime" USING (business_id = nullif(current_setting('app.tenant_id', true), '')::uuid OR current_setting('app.system', true) = 'on') WITH CHECK (business_id = nullif(current_setting('app.tenant_id', true), '')::uuid OR current_setting('app.system', true) = 'on');--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "businesses" AS PERMISSIVE FOR ALL TO "app_runtime" USING (id = nullif(current_setting('app.tenant_id', true), '')::uuid OR current_setting('app.system', true) = 'on') WITH CHECK (id = nullif(current_setting('app.tenant_id', true), '')::uuid OR current_setting('app.system', true) = 'on');--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "custom_fields" AS PERMISSIVE FOR ALL TO "app_runtime" USING (business_id = nullif(current_setting('app.tenant_id', true), '')::uuid OR current_setting('app.system', true) = 'on') WITH CHECK (business_id = nullif(current_setting('app.tenant_id', true), '')::uuid OR current_setting('app.system', true) = 'on');--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "location_hours" AS PERMISSIVE FOR ALL TO "app_runtime" USING (business_id = nullif(current_setting('app.tenant_id', true), '')::uuid OR current_setting('app.system', true) = 'on') WITH CHECK (business_id = nullif(current_setting('app.tenant_id', true), '')::uuid OR current_setting('app.system', true) = 'on');--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "locations" AS PERMISSIVE FOR ALL TO "app_runtime" USING (business_id = nullif(current_setting('app.tenant_id', true), '')::uuid OR current_setting('app.system', true) = 'on') WITH CHECK (business_id = nullif(current_setting('app.tenant_id', true), '')::uuid OR current_setting('app.system', true) = 'on');--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "campaign_sends" AS PERMISSIVE FOR ALL TO "app_runtime" USING (business_id = nullif(current_setting('app.tenant_id', true), '')::uuid OR current_setting('app.system', true) = 'on') WITH CHECK (business_id = nullif(current_setting('app.tenant_id', true), '')::uuid OR current_setting('app.system', true) = 'on');--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "campaigns" AS PERMISSIVE FOR ALL TO "app_runtime" USING (business_id = nullif(current_setting('app.tenant_id', true), '')::uuid OR current_setting('app.system', true) = 'on') WITH CHECK (business_id = nullif(current_setting('app.tenant_id', true), '')::uuid OR current_setting('app.system', true) = 'on');--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "service_categories" AS PERMISSIVE FOR ALL TO "app_runtime" USING (business_id = nullif(current_setting('app.tenant_id', true), '')::uuid OR current_setting('app.system', true) = 'on') WITH CHECK (business_id = nullif(current_setting('app.tenant_id', true), '')::uuid OR current_setting('app.system', true) = 'on');--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "service_locations" AS PERMISSIVE FOR ALL TO "app_runtime" USING (business_id = nullif(current_setting('app.tenant_id', true), '')::uuid OR current_setting('app.system', true) = 'on') WITH CHECK (business_id = nullif(current_setting('app.tenant_id', true), '')::uuid OR current_setting('app.system', true) = 'on');--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "services" AS PERMISSIVE FOR ALL TO "app_runtime" USING (business_id = nullif(current_setting('app.tenant_id', true), '')::uuid OR current_setting('app.system', true) = 'on') WITH CHECK (business_id = nullif(current_setting('app.tenant_id', true), '')::uuid OR current_setting('app.system', true) = 'on');--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "staff_services" AS PERMISSIVE FOR ALL TO "app_runtime" USING (business_id = nullif(current_setting('app.tenant_id', true), '')::uuid OR current_setting('app.system', true) = 'on') WITH CHECK (business_id = nullif(current_setting('app.tenant_id', true), '')::uuid OR current_setting('app.system', true) = 'on');--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "clients" AS PERMISSIVE FOR ALL TO "app_runtime" USING (business_id = nullif(current_setting('app.tenant_id', true), '')::uuid OR current_setting('app.system', true) = 'on') WITH CHECK (business_id = nullif(current_setting('app.tenant_id', true), '')::uuid OR current_setting('app.system', true) = 'on');--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "commission_entries" AS PERMISSIVE FOR ALL TO "app_runtime" USING (business_id = nullif(current_setting('app.tenant_id', true), '')::uuid OR current_setting('app.system', true) = 'on') WITH CHECK (business_id = nullif(current_setting('app.tenant_id', true), '')::uuid OR current_setting('app.system', true) = 'on');--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "commission_rules" AS PERMISSIVE FOR ALL TO "app_runtime" USING (business_id = nullif(current_setting('app.tenant_id', true), '')::uuid OR current_setting('app.system', true) = 'on') WITH CHECK (business_id = nullif(current_setting('app.tenant_id', true), '')::uuid OR current_setting('app.system', true) = 'on');--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "payouts" AS PERMISSIVE FOR ALL TO "app_runtime" USING (business_id = nullif(current_setting('app.tenant_id', true), '')::uuid OR current_setting('app.system', true) = 'on') WITH CHECK (business_id = nullif(current_setting('app.tenant_id', true), '')::uuid OR current_setting('app.system', true) = 'on');--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "payment_methods" AS PERMISSIVE FOR ALL TO "app_runtime" USING (business_id = nullif(current_setting('app.tenant_id', true), '')::uuid OR current_setting('app.system', true) = 'on') WITH CHECK (business_id = nullif(current_setting('app.tenant_id', true), '')::uuid OR current_setting('app.system', true) = 'on');--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "payments" AS PERMISSIVE FOR ALL TO "app_runtime" USING (business_id = nullif(current_setting('app.tenant_id', true), '')::uuid OR current_setting('app.system', true) = 'on') WITH CHECK (business_id = nullif(current_setting('app.tenant_id', true), '')::uuid OR current_setting('app.system', true) = 'on');--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "appointment_services" AS PERMISSIVE FOR ALL TO "app_runtime" USING (business_id = nullif(current_setting('app.tenant_id', true), '')::uuid OR current_setting('app.system', true) = 'on') WITH CHECK (business_id = nullif(current_setting('app.tenant_id', true), '')::uuid OR current_setting('app.system', true) = 'on');--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "appointments" AS PERMISSIVE FOR ALL TO "app_runtime" USING (business_id = nullif(current_setting('app.tenant_id', true), '')::uuid OR current_setting('app.system', true) = 'on') WITH CHECK (business_id = nullif(current_setting('app.tenant_id', true), '')::uuid OR current_setting('app.system', true) = 'on');--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "reminders" AS PERMISSIVE FOR ALL TO "app_runtime" USING (business_id = nullif(current_setting('app.tenant_id', true), '')::uuid OR current_setting('app.system', true) = 'on') WITH CHECK (business_id = nullif(current_setting('app.tenant_id', true), '')::uuid OR current_setting('app.system', true) = 'on');--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "membership_locations" AS PERMISSIVE FOR ALL TO "app_runtime" USING (business_id = nullif(current_setting('app.tenant_id', true), '')::uuid OR current_setting('app.system', true) = 'on') WITH CHECK (business_id = nullif(current_setting('app.tenant_id', true), '')::uuid OR current_setting('app.system', true) = 'on');--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "memberships" AS PERMISSIVE FOR ALL TO "app_runtime" USING (business_id = nullif(current_setting('app.tenant_id', true), '')::uuid OR current_setting('app.system', true) = 'on') WITH CHECK (business_id = nullif(current_setting('app.tenant_id', true), '')::uuid OR current_setting('app.system', true) = 'on');--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "staff" AS PERMISSIVE FOR ALL TO "app_runtime" USING (business_id = nullif(current_setting('app.tenant_id', true), '')::uuid OR current_setting('app.system', true) = 'on') WITH CHECK (business_id = nullif(current_setting('app.tenant_id', true), '')::uuid OR current_setting('app.system', true) = 'on');--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "staff_hours" AS PERMISSIVE FOR ALL TO "app_runtime" USING (business_id = nullif(current_setting('app.tenant_id', true), '')::uuid OR current_setting('app.system', true) = 'on') WITH CHECK (business_id = nullif(current_setting('app.tenant_id', true), '')::uuid OR current_setting('app.system', true) = 'on');--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "time_off" AS PERMISSIVE FOR ALL TO "app_runtime" USING (business_id = nullif(current_setting('app.tenant_id', true), '')::uuid OR current_setting('app.system', true) = 'on') WITH CHECK (business_id = nullif(current_setting('app.tenant_id', true), '')::uuid OR current_setting('app.system', true) = 'on');--> statement-breakpoint
CREATE POLICY "member_or_system" ON "users" AS PERMISSIVE FOR ALL TO "app_runtime" USING (current_setting('app.system', true) = 'on' OR EXISTS (SELECT 1 FROM memberships m WHERE m.user_id = users.id AND m.business_id = nullif(current_setting('app.tenant_id', true), '')::uuid)) WITH CHECK (current_setting('app.system', true) = 'on' OR EXISTS (SELECT 1 FROM memberships m WHERE m.user_id = users.id AND m.business_id = nullif(current_setting('app.tenant_id', true), '')::uuid));--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "ai_settings" AS PERMISSIVE FOR ALL TO "app_runtime" USING (business_id = nullif(current_setting('app.tenant_id', true), '')::uuid OR current_setting('app.system', true) = 'on') WITH CHECK (business_id = nullif(current_setting('app.tenant_id', true), '')::uuid OR current_setting('app.system', true) = 'on');--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "ai_usage_monthly" AS PERMISSIVE FOR ALL TO "app_runtime" USING (business_id = nullif(current_setting('app.tenant_id', true), '')::uuid OR current_setting('app.system', true) = 'on') WITH CHECK (business_id = nullif(current_setting('app.tenant_id', true), '')::uuid OR current_setting('app.system', true) = 'on');--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "conversations" AS PERMISSIVE FOR ALL TO "app_runtime" USING (business_id = nullif(current_setting('app.tenant_id', true), '')::uuid OR current_setting('app.system', true) = 'on') WITH CHECK (business_id = nullif(current_setting('app.tenant_id', true), '')::uuid OR current_setting('app.system', true) = 'on');--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "follow_ups" AS PERMISSIVE FOR ALL TO "app_runtime" USING (business_id = nullif(current_setting('app.tenant_id', true), '')::uuid OR current_setting('app.system', true) = 'on') WITH CHECK (business_id = nullif(current_setting('app.tenant_id', true), '')::uuid OR current_setting('app.system', true) = 'on');--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "messages" AS PERMISSIVE FOR ALL TO "app_runtime" USING (business_id = nullif(current_setting('app.tenant_id', true), '')::uuid OR current_setting('app.system', true) = 'on') WITH CHECK (business_id = nullif(current_setting('app.tenant_id', true), '')::uuid OR current_setting('app.system', true) = 'on');--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "quotes" AS PERMISSIVE FOR ALL TO "app_runtime" USING (business_id = nullif(current_setting('app.tenant_id', true), '')::uuid OR current_setting('app.system', true) = 'on') WITH CHECK (business_id = nullif(current_setting('app.tenant_id', true), '')::uuid OR current_setting('app.system', true) = 'on');--> statement-breakpoint
CREATE POLICY "system_only" ON "raw_webhooks" AS PERMISSIVE FOR ALL TO "app_runtime" USING (current_setting('app.system', true) = 'on') WITH CHECK (current_setting('app.system', true) = 'on');--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "whatsapp_channels" AS PERMISSIVE FOR ALL TO "app_runtime" USING (business_id = nullif(current_setting('app.tenant_id', true), '')::uuid OR current_setting('app.system', true) = 'on') WITH CHECK (business_id = nullif(current_setting('app.tenant_id', true), '')::uuid OR current_setting('app.system', true) = 'on');