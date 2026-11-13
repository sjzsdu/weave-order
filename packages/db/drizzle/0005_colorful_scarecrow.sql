CREATE TYPE "public"."llm_scope" AS ENUM('GLOBAL', 'TENANT');--> statement-breakpoint
CREATE TYPE "public"."llm_task" AS ENUM('QUOTE_INTENT', 'QUOTE_DRAFT', 'FOLLOWUP_SUGGESTION', 'REPLY_CLASSIFICATION');--> statement-breakpoint
CREATE TABLE "llm_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scope" "llm_scope" NOT NULL,
	"tenant_id" uuid,
	"provider" varchar(64) DEFAULT 'litellm' NOT NULL,
	"base_url" varchar(512),
	"default_model" varchar(128) DEFAULT 'deepseek-chat' NOT NULL,
	"reasoning_model" varchar(128) DEFAULT 'deepseek-reasoner' NOT NULL,
	"model_allowlist" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"daily_token_budget" bigint,
	"monthly_token_budget" bigint,
	"params" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"key_ref" varchar(255),
	"allow_external" boolean DEFAULT true NOT NULL,
	"log_prompts" boolean DEFAULT false NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_by" varchar(128),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "token_usage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	"task" "llm_task" NOT NULL,
	"model" varchar(128) NOT NULL,
	"provider" varchar(64) NOT NULL,
	"prompt_tokens" bigint DEFAULT 0 NOT NULL,
	"completion_tokens" bigint DEFAULT 0 NOT NULL,
	"cached_tokens" bigint DEFAULT 0 NOT NULL,
	"cost_micros" bigint,
	"prompt_hash" varchar(64) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "usage_monthly" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"period" date NOT NULL,
	"model" varchar(128) NOT NULL,
	"task" "llm_task" NOT NULL,
	"request_count" bigint DEFAULT 0 NOT NULL,
	"prompt_tokens" bigint DEFAULT 0 NOT NULL,
	"completion_tokens" bigint DEFAULT 0 NOT NULL,
	"cached_tokens" bigint DEFAULT 0 NOT NULL,
	"cost_micros" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "llm_settings_global_idx" ON "llm_settings" USING btree ("scope") WHERE "llm_settings"."scope" = 'GLOBAL';--> statement-breakpoint
CREATE UNIQUE INDEX "llm_settings_tenant_idx" ON "llm_settings" USING btree ("tenant_id") WHERE "llm_settings"."scope" = 'TENANT';--> statement-breakpoint
CREATE INDEX "llm_settings_scope_tenant_idx" ON "llm_settings" USING btree ("scope","tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "token_usage_request_id_idx" ON "token_usage" USING btree ("request_id");--> statement-breakpoint
CREATE INDEX "token_usage_tenant_created_idx" ON "token_usage" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "token_usage_tenant_task_idx" ON "token_usage" USING btree ("tenant_id","task");--> statement-breakpoint
CREATE UNIQUE INDEX "usage_monthly_tenant_period_model_task_idx" ON "usage_monthly" USING btree ("tenant_id","period","model","task");--> statement-breakpoint
CREATE INDEX "usage_monthly_tenant_period_idx" ON "usage_monthly" USING btree ("tenant_id","period");
--> statement-breakpoint
-- 全局默认：日常 deepseek-chat / 复杂 deepseek-reasoner；租户可覆盖。
-- base_url 留空表示使用 LITELLM_BASE_URL 环境变量，避免把环境写进数据。
INSERT INTO "llm_settings" (
  "scope", "tenant_id", "provider", "base_url",
  "default_model", "reasoning_model", "model_allowlist",
  "allow_external", "log_prompts", "params"
) VALUES (
  'GLOBAL', NULL, 'litellm', NULL,
  'deepseek-chat', 'deepseek-reasoner',
  '["deepseek-chat","deepseek-reasoner"]'::jsonb,
  true, false, '{}'::jsonb
);
