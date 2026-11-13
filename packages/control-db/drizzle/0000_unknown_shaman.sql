CREATE SCHEMA "control";
--> statement-breakpoint
CREATE TYPE "control"."approval_action" AS ENUM('TENANT_PURGE', 'TENANT_FORCE_PLAN', 'PRICE_CHANGE', 'TAX_CHANGE', 'INVOICE_VOID', 'BREAK_GLASS');--> statement-breakpoint
CREATE TYPE "control"."approval_status" AS ENUM('PENDING', 'APPROVED', 'REJECTED', 'EXPIRED', 'EXECUTED');--> statement-breakpoint
CREATE TYPE "control"."billing_cycle" AS ENUM('MONTHLY', 'ANNUAL');--> statement-breakpoint
CREATE TYPE "control"."break_glass_status" AS ENUM('PENDING', 'APPROVED', 'ACTIVE', 'EXPIRED', 'REJECTED');--> statement-breakpoint
CREATE TYPE "control"."config_scope" AS ENUM('GLOBAL', 'PLAN', 'TENANT');--> statement-breakpoint
CREATE TYPE "control"."config_status" AS ENUM('ACTIVE', 'SUPERSEDED');--> statement-breakpoint
CREATE TYPE "control"."invoice_status" AS ENUM('DRAFT', 'ISSUED', 'PAID', 'OVERDUE', 'VOID', 'RED_FLUSH');--> statement-breakpoint
CREATE TYPE "control"."invoice_type" AS ENUM('VAT_SPECIAL', 'VAT_NORMAL', 'E_INVOICE', 'NONE');--> statement-breakpoint
CREATE TYPE "control"."isolation_mode" AS ENUM('SHARED_RLS', 'SCHEMA', 'DATABASE');--> statement-breakpoint
CREATE TYPE "control"."llm_scope" AS ENUM('GLOBAL', 'TENANT');--> statement-breakpoint
CREATE TYPE "control"."override_status" AS ENUM('PENDING', 'ACTIVE', 'EXPIRED', 'REVOKED');--> statement-breakpoint
CREATE TYPE "control"."plan_status" AS ENUM('ACTIVE', 'RETIRED');--> statement-breakpoint
CREATE TYPE "control"."platform_role" AS ENUM('platform_owner', 'platform_finance', 'platform_support', 'platform_ops', 'platform_readonly');--> statement-breakpoint
CREATE TYPE "control"."platform_tenant_status" AS ENUM('TRIAL', 'ACTIVE', 'OVERDUE', 'SUSPENDED', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "control"."platform_user_status" AS ENUM('ACTIVE', 'DISABLED');--> statement-breakpoint
CREATE TYPE "control"."price_book_status" AS ENUM('DRAFT', 'ACTIVE', 'RETIRED');--> statement-breakpoint
CREATE TYPE "control"."subscription_status" AS ENUM('TRIAL', 'ACTIVE', 'OVERDUE', 'SUSPENDED', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "control"."ticket_status" AS ENUM('OPEN', 'PENDING', 'RESOLVED');--> statement-breakpoint
CREATE TYPE "control"."usage_kind" AS ENUM('agent_action', 'storage', 'sms', 'llm_tokens');--> statement-breakpoint
CREATE SEQUENCE "control"."invoice_number_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1000 CACHE 1;--> statement-breakpoint
CREATE TABLE "control"."approvals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"action" "control"."approval_action" NOT NULL,
	"target_type" varchar(64) NOT NULL,
	"target_id" varchar(128),
	"summary" varchar(255) NOT NULL,
	"payload" jsonb NOT NULL,
	"required_roles" jsonb NOT NULL,
	"votes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" "control"."approval_status" DEFAULT 'PENDING' NOT NULL,
	"requested_by" varchar(128) NOT NULL,
	"requested_by_name" varchar(255) NOT NULL,
	"reason" varchar(500) NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"decided_at" timestamp with time zone,
	"result" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "control"."break_glass_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"ticket_no" varchar(64) NOT NULL,
	"reason" text NOT NULL,
	"status" "control"."break_glass_status" DEFAULT 'PENDING' NOT NULL,
	"tenant_consent" boolean DEFAULT false NOT NULL,
	"consent_at" timestamp with time zone,
	"requested_by" varchar(128) NOT NULL,
	"approved_by" varchar(128),
	"starts_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "control"."feature_flags" (
	"key" varchar(64) PRIMARY KEY NOT NULL,
	"name" varchar(128) NOT NULL,
	"description" varchar(500) DEFAULT '' NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"rollout_percent" integer DEFAULT 0 NOT NULL,
	"tenant_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"updated_by" varchar(128),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "control"."identity_settings" (
	"id" varchar(16) PRIMARY KEY DEFAULT 'default' NOT NULL,
	"mfa_required" boolean DEFAULT true NOT NULL,
	"social_login_allowed" boolean DEFAULT false NOT NULL,
	"sso_enabled" boolean DEFAULT false NOT NULL,
	"casdoor_org_template" varchar(128) DEFAULT 'weave-{slug}' NOT NULL,
	"session_max_hours" integer DEFAULT 8 NOT NULL,
	"updated_by" varchar(128),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "control"."invoice_settings" (
	"id" varchar(16) PRIMARY KEY DEFAULT 'default' NOT NULL,
	"invoice_type" "control"."invoice_type" DEFAULT 'VAT_SPECIAL' NOT NULL,
	"tax_rate_bp" integer DEFAULT 600 NOT NULL,
	"price_display" varchar(32) DEFAULT 'TAX_EXCLUSIVE' NOT NULL,
	"issuer_entity" varchar(255) DEFAULT '织序（上海）科技有限公司' NOT NULL,
	"issue_timing" varchar(32) DEFAULT 'AFTER_PAYMENT_3D' NOT NULL,
	"red_flush_rule" varchar(32) DEFAULT 'FINANCE_REVIEW' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_by" varchar(128),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "control"."invoices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"number" varchar(32) NOT NULL,
	"status" "control"."invoice_status" DEFAULT 'DRAFT' NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"due_at" timestamp with time zone,
	"issued_at" timestamp with time zone,
	"paid_at" timestamp with time zone,
	"subtotal_cents" bigint NOT NULL,
	"tax_rate_bp" integer NOT NULL,
	"tax_cents" bigint NOT NULL,
	"total_cents" bigint NOT NULL,
	"currency" varchar(3) DEFAULT 'CNY' NOT NULL,
	"line_items" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"notes" text,
	"created_by" varchar(128) NOT NULL,
	"approved_by" varchar(128),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "control"."llm_settings" (
	"scope" "control"."llm_scope" NOT NULL,
	"tenant_id" uuid,
	"provider" varchar(64) DEFAULT 'litellm' NOT NULL,
	"base_url" varchar(512),
	"default_model" varchar(128) DEFAULT 'deepseek-chat' NOT NULL,
	"daily_token_budget" bigint,
	"monthly_token_budget" bigint,
	"key_ref" varchar(255),
	"allow_external" boolean DEFAULT true NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_by" varchar(128),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "control"."plan_prices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"price_book_id" uuid NOT NULL,
	"plan_code" varchar(32) NOT NULL,
	"monthly_price_cents" bigint NOT NULL,
	"annual_price_cents" bigint NOT NULL,
	"currency" varchar(3) DEFAULT 'CNY' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "control"."plans" (
	"code" varchar(32) PRIMARY KEY NOT NULL,
	"name" varchar(64) NOT NULL,
	"tier" integer NOT NULL,
	"seat_min" integer DEFAULT 1 NOT NULL,
	"seat_max" integer,
	"agent_actions_quota" integer DEFAULT 0 NOT NULL,
	"storage_gb" integer DEFAULT 0 NOT NULL,
	"features" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" "control"."plan_status" DEFAULT 'ACTIVE' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "control"."platform_audit" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_sub" varchar(128) NOT NULL,
	"actor_name" varchar(255) NOT NULL,
	"actor_role" "control"."platform_role" NOT NULL,
	"action" varchar(64) NOT NULL,
	"target_type" varchar(64) NOT NULL,
	"target_id" varchar(128),
	"before" jsonb,
	"after" jsonb,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "control"."platform_configs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" varchar(128) NOT NULL,
	"scope" "control"."config_scope" NOT NULL,
	"scope_ref" varchar(128),
	"value" jsonb NOT NULL,
	"version" integer NOT NULL,
	"status" "control"."config_status" DEFAULT 'ACTIVE' NOT NULL,
	"effective_from" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" varchar(128) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "control"."platform_users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"subject" varchar(128) NOT NULL,
	"email" varchar(255) NOT NULL,
	"name" varchar(255) NOT NULL,
	"role" "control"."platform_role" NOT NULL,
	"status" "control"."platform_user_status" DEFAULT 'ACTIVE' NOT NULL,
	"mfa_enforced" boolean DEFAULT true NOT NULL,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "control"."price_books" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"version" integer NOT NULL,
	"status" "control"."price_book_status" DEFAULT 'DRAFT' NOT NULL,
	"effective_from" timestamp with time zone DEFAULT now() NOT NULL,
	"notes" text,
	"created_by" varchar(128) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"activated_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "control"."subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"plan_code" varchar(32) NOT NULL,
	"price_book_id" uuid NOT NULL,
	"seats" integer NOT NULL,
	"billing_cycle" "control"."billing_cycle" DEFAULT 'MONTHLY' NOT NULL,
	"status" "control"."subscription_status" DEFAULT 'TRIAL' NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"trial_ends_at" timestamp with time zone,
	"next_due_at" timestamp with time zone,
	"effective_monthly_cents" bigint DEFAULT 0 NOT NULL,
	"override_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "control"."support_tickets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"title" varchar(255) NOT NULL,
	"body" text NOT NULL,
	"priority" varchar(16) DEFAULT 'NORMAL' NOT NULL,
	"status" "control"."ticket_status" DEFAULT 'OPEN' NOT NULL,
	"created_by" varchar(128) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "control"."tax_profiles" (
	"tenant_id" uuid PRIMARY KEY NOT NULL,
	"title" varchar(255) NOT NULL,
	"tax_no" varchar(64),
	"bank" varchar(255),
	"address" varchar(255),
	"invoice_type" "control"."invoice_type" DEFAULT 'VAT_SPECIAL' NOT NULL,
	"tax_rate_bp" integer DEFAULT 600 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "control"."tenant_price_overrides" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"plan_code" varchar(32) NOT NULL,
	"monthly_price_cents" bigint NOT NULL,
	"seats" integer,
	"effective_from" timestamp with time zone NOT NULL,
	"effective_to" timestamp with time zone,
	"reason" varchar(500) NOT NULL,
	"status" "control"."override_status" DEFAULT 'PENDING' NOT NULL,
	"created_by" varchar(128) NOT NULL,
	"approved_by" varchar(128),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "control"."tenants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" varchar(64) NOT NULL,
	"name" varchar(255) NOT NULL,
	"status" "control"."platform_tenant_status" DEFAULT 'TRIAL' NOT NULL,
	"isolation_mode" "control"."isolation_mode" DEFAULT 'SHARED_RLS' NOT NULL,
	"region" varchar(32) DEFAULT 'cn-east' NOT NULL,
	"currency" varchar(3) DEFAULT 'CNY' NOT NULL,
	"health_score" integer DEFAULT 80 NOT NULL,
	"notes" text,
	"contact_name" varchar(255),
	"contact_email" varchar(255),
	"suspended_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"trial_started_at" timestamp with time zone,
	"converted_at" timestamp with time zone,
	"churned_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "control"."usage_daily" (
	"tenant_id" uuid NOT NULL,
	"day" date NOT NULL,
	"agent_actions" integer DEFAULT 0 NOT NULL,
	"storage_gb" numeric(12, 3) DEFAULT '0' NOT NULL,
	"sms_count" integer DEFAULT 0 NOT NULL,
	"llm_input_tokens" bigint DEFAULT 0 NOT NULL,
	"llm_output_tokens" bigint DEFAULT 0 NOT NULL,
	"llm_cost_cents" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "control"."usage_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"kind" "control"."usage_kind" NOT NULL,
	"quantity" numeric(18, 3) NOT NULL,
	"idempotency_key" varchar(128) NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "control"."break_glass_requests" ADD CONSTRAINT "break_glass_requests_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "control"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "control"."invoices" ADD CONSTRAINT "invoices_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "control"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "control"."llm_settings" ADD CONSTRAINT "llm_settings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "control"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "control"."plan_prices" ADD CONSTRAINT "plan_prices_price_book_id_price_books_id_fk" FOREIGN KEY ("price_book_id") REFERENCES "control"."price_books"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "control"."plan_prices" ADD CONSTRAINT "plan_prices_plan_code_plans_code_fk" FOREIGN KEY ("plan_code") REFERENCES "control"."plans"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "control"."subscriptions" ADD CONSTRAINT "subscriptions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "control"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "control"."subscriptions" ADD CONSTRAINT "subscriptions_plan_code_plans_code_fk" FOREIGN KEY ("plan_code") REFERENCES "control"."plans"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "control"."subscriptions" ADD CONSTRAINT "subscriptions_price_book_id_price_books_id_fk" FOREIGN KEY ("price_book_id") REFERENCES "control"."price_books"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "control"."support_tickets" ADD CONSTRAINT "support_tickets_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "control"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "control"."tax_profiles" ADD CONSTRAINT "tax_profiles_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "control"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "control"."tenant_price_overrides" ADD CONSTRAINT "tenant_price_overrides_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "control"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "control"."usage_daily" ADD CONSTRAINT "usage_daily_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "control"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "control"."usage_events" ADD CONSTRAINT "usage_events_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "control"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "control_approvals_status_idx" ON "control"."approvals" USING btree ("status","expires_at");--> statement-breakpoint
CREATE INDEX "control_break_glass_status_idx" ON "control"."break_glass_requests" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "control_invoices_number_idx" ON "control"."invoices" USING btree ("number");--> statement-breakpoint
CREATE INDEX "control_invoices_tenant_idx" ON "control"."invoices" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "control_llm_settings_global_idx" ON "control"."llm_settings" USING btree ("scope") WHERE "control"."llm_settings"."scope" = 'GLOBAL';--> statement-breakpoint
CREATE UNIQUE INDEX "control_llm_settings_tenant_idx" ON "control"."llm_settings" USING btree ("tenant_id") WHERE "control"."llm_settings"."scope" = 'TENANT';--> statement-breakpoint
CREATE UNIQUE INDEX "control_plan_prices_book_plan_idx" ON "control"."plan_prices" USING btree ("price_book_id","plan_code");--> statement-breakpoint
CREATE INDEX "control_platform_audit_created_idx" ON "control"."platform_audit" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "control_platform_configs_key_idx" ON "control"."platform_configs" USING btree ("key","scope","scope_ref");--> statement-breakpoint
CREATE UNIQUE INDEX "control_platform_configs_version_idx" ON "control"."platform_configs" USING btree ("key","scope",coalesce("scope_ref", ''),"version");--> statement-breakpoint
CREATE UNIQUE INDEX "platform_users_subject_idx" ON "control"."platform_users" USING btree ("subject");--> statement-breakpoint
CREATE UNIQUE INDEX "control_price_books_version_idx" ON "control"."price_books" USING btree ("version");--> statement-breakpoint
CREATE UNIQUE INDEX "control_subscriptions_tenant_idx" ON "control"."subscriptions" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "control_support_tickets_status_idx" ON "control"."support_tickets" USING btree ("status");--> statement-breakpoint
CREATE INDEX "control_overrides_tenant_idx" ON "control"."tenant_price_overrides" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "control_tenants_slug_idx" ON "control"."tenants" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "control_tenants_status_idx" ON "control"."tenants" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "control_usage_daily_pk" ON "control"."usage_daily" USING btree ("tenant_id","day");--> statement-breakpoint
CREATE INDEX "control_usage_daily_day_idx" ON "control"."usage_daily" USING btree ("day");--> statement-breakpoint
CREATE UNIQUE INDEX "control_usage_events_idempotency_idx" ON "control"."usage_events" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "control_usage_events_tenant_idx" ON "control"."usage_events" USING btree ("tenant_id","occurred_at");