CREATE TYPE "public"."intent_source" AS ENUM('today', 'command-bar', 'customer-360');--> statement-breakpoint
CREATE TYPE "public"."intent_status" AS ENUM('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMEOUT');--> statement-breakpoint
CREATE TABLE "intents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"client_request_id" varchar(128) NOT NULL,
	"source" "intent_source" NOT NULL,
	"text" text NOT NULL,
	"context" jsonb,
	"status" "intent_status" DEFAULT 'QUEUED' NOT NULL,
	"executor_state" varchar(32) DEFAULT 'NOT_CONNECTED' NOT NULL,
	"failure_reason" text,
	"result" jsonb,
	"submitted_by" varchar(128) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone
);
--> statement-breakpoint
CREATE UNIQUE INDEX "intents_tenant_client_request_idx" ON "intents" USING btree ("tenant_id","client_request_id");--> statement-breakpoint
CREATE INDEX "intents_tenant_created_idx" ON "intents" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "intents_tenant_status_idx" ON "intents" USING btree ("tenant_id","status","updated_at");--> statement-breakpoint
-- 租户隔离：意图同样按 tenant_id 隔离，rls.sql 每次迁移后幂等重放。
ALTER TABLE "intents" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "intents" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON "intents";--> statement-breakpoint
CREATE POLICY tenant_isolation ON "intents"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
