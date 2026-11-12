CREATE TYPE "public"."pricing_scope_type" AS ENUM('SYSTEM', 'COMPANY', 'TEAM', 'CUSTOMER', 'CATEGORY', 'PERSON');--> statement-breakpoint
CREATE TYPE "public"."scenario_tag" AS ENUM('PRICING', 'SAMPLE_FOLLOWUP', 'ORDER_FOLLOWUP', 'RECONCILIATION');--> statement-breakpoint
CREATE TABLE "policy_change_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"policy_id" uuid NOT NULL,
	"action" varchar(32) NOT NULL,
	"old_value" jsonb,
	"new_value" jsonb,
	"actor_id" varchar(128) NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pricing_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"scope_type" "pricing_scope_type" NOT NULL,
	"scope_id" varchar(128),
	"key" varchar(64) NOT NULL,
	"value" jsonb NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"locked" boolean DEFAULT false NOT NULL,
	"effective_from" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" varchar(128) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "decision_deltas" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"entity_type" varchar(32) NOT NULL,
	"entity_id" uuid NOT NULL,
	"field" varchar(128) NOT NULL,
	"original_value" jsonb,
	"modified_value" jsonb,
	"scenario_tag" "scenario_tag" DEFAULT 'PRICING' NOT NULL,
	"actor_type" "actor_type" NOT NULL,
	"actor_id" varchar(128) NOT NULL,
	"reason_id" uuid,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "samples" ADD COLUMN "category" varchar(64);--> statement-breakpoint
ALTER TABLE "quote_items" ADD COLUMN "provenance" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "quotes" ADD COLUMN "version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "quotes" ADD COLUMN "baseline_snapshot" jsonb;--> statement-breakpoint
ALTER TABLE "quotes" ADD COLUMN "pending_diff" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "quotes" ADD COLUMN "required_approval_role" "member_role";--> statement-breakpoint
ALTER TABLE "quotes" ADD COLUMN "approval_escalated" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "quotes" ADD COLUMN "escalation_reasons" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "quotes" ADD COLUMN "change_pct_bps" integer;--> statement-breakpoint
ALTER TABLE "quotes" ADD COLUMN "last_revised_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "policy_change_log" ADD CONSTRAINT "policy_change_log_policy_id_pricing_policies_id_fk" FOREIGN KEY ("policy_id") REFERENCES "public"."pricing_policies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "policy_change_log_policy_idx" ON "policy_change_log" USING btree ("policy_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "pricing_policies_tenant_scope_key_idx" ON "pricing_policies" USING btree ("tenant_id","scope_type","scope_id","key");--> statement-breakpoint
CREATE INDEX "pricing_policies_tenant_key_idx" ON "pricing_policies" USING btree ("tenant_id","key");--> statement-breakpoint
CREATE INDEX "decision_deltas_tenant_customer_idx" ON "decision_deltas" USING btree ("tenant_id","customer_id");--> statement-breakpoint
CREATE INDEX "decision_deltas_entity_idx" ON "decision_deltas" USING btree ("entity_type","entity_id");