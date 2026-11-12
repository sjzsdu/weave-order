CREATE TYPE "public"."data_scope" AS ENUM('ALL', 'TEAM', 'OWN');--> statement-breakpoint
CREATE TYPE "public"."isolation_mode" AS ENUM('SHARED_RLS', 'SCHEMA', 'DATABASE');--> statement-breakpoint
CREATE TYPE "public"."member_role" AS ENUM('OWNER', 'MANAGER', 'SALES', 'MERCHANDISER', 'SAMPLE_ADMIN', 'FINANCE', 'VIEWER');--> statement-breakpoint
CREATE TYPE "public"."membership_status" AS ENUM('ACTIVE', 'INVITED', 'DISABLED');--> statement-breakpoint
CREATE TYPE "public"."order_shipment_status" AS ENUM('DRAFT', 'PACKED', 'SHIPPED', 'DELIVERED', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."order_status" AS ENUM('DRAFT', 'CONFIRMED', 'IN_PRODUCTION', 'SHIPPED', 'COMPLETED', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."quote_share_event" AS ENUM('VIEWED', 'PDF_DOWNLOADED', 'ACCEPTED', 'QUESTION_ASKED', 'REVOKED');--> statement-breakpoint
CREATE TYPE "public"."receivable_status" AS ENUM('PENDING', 'PARTIAL', 'PAID', 'OVERDUE', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."revision_entity_type" AS ENUM('quote', 'order', 'sample_shipment');--> statement-breakpoint
CREATE TYPE "public"."revision_request_status" AS ENUM('PENDING', 'APPROVED', 'REJECTED', 'WITHDRAWN');--> statement-breakpoint
CREATE TYPE "public"."revision_source" AS ENUM('INLINE', 'FORM', 'CHAT');--> statement-breakpoint
CREATE TYPE "public"."tenant_status" AS ENUM('ACTIVE', 'TRIAL', 'SUSPENDED', 'CLOSED');--> statement-breakpoint
CREATE TABLE "memberships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"subject" varchar(128) NOT NULL,
	"casdoor_org" varchar(128),
	"role" "member_role" NOT NULL,
	"data_scope" "data_scope" DEFAULT 'OWN' NOT NULL,
	"team_id" uuid,
	"approval_limit_amount" bigint,
	"status" "membership_status" DEFAULT 'ACTIVE' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tenants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" varchar(64) NOT NULL,
	"name" varchar(255) NOT NULL,
	"brand" varchar(255),
	"bank" jsonb,
	"currency" "currency" DEFAULT 'CNY' NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" "tenant_status" DEFAULT 'ACTIVE' NOT NULL,
	"isolation_mode" "isolation_mode" DEFAULT 'SHARED_RLS' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenants_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "order_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"sample_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"description" varchar(255) NOT NULL,
	"quantity_milli" bigint NOT NULL,
	"unit" "unit" NOT NULL,
	"unit_price_amount" bigint NOT NULL,
	"line_total_amount" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shipment_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"shipment_id" uuid NOT NULL,
	"order_item_id" uuid NOT NULL,
	"quantity_milli" bigint NOT NULL,
	"unit" "unit" NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shipments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"status" "order_shipment_status" DEFAULT 'DRAFT' NOT NULL,
	"carrier" varchar(128),
	"tracking_number" varchar(128),
	"address" text,
	"shipped_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"quote_id" uuid,
	"code" varchar(64) NOT NULL,
	"status" "order_status" DEFAULT 'DRAFT' NOT NULL,
	"currency" "currency" NOT NULL,
	"total_amount" bigint NOT NULL,
	"due_date" timestamp with time zone,
	"progress_pct" integer DEFAULT 0 NOT NULL,
	"confirmed_by" varchar(128),
	"confirmed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "receivables" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"amount" bigint NOT NULL,
	"paid_amount" bigint DEFAULT 0 NOT NULL,
	"currency" "currency" NOT NULL,
	"due_date" timestamp with time zone NOT NULL,
	"status" "receivable_status" DEFAULT 'PENDING' NOT NULL,
	"paid_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "draft_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"revision_request_id" uuid,
	"entity_type" "revision_entity_type" NOT NULL,
	"entity_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"patch" jsonb NOT NULL,
	"before" jsonb NOT NULL,
	"after" jsonb NOT NULL,
	"provenance" jsonb NOT NULL,
	"actor_type" "actor_type" NOT NULL,
	"actor_id" varchar(128) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "revision_reasons" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"code" varchar(64) NOT NULL,
	"label" varchar(255) NOT NULL,
	"applies_to" "revision_entity_type"[] NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "revision_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"entity_type" "revision_entity_type" NOT NULL,
	"entity_id" uuid NOT NULL,
	"source" "revision_source" NOT NULL,
	"instruction" text NOT NULL,
	"patch" jsonb NOT NULL,
	"status" "revision_request_status" DEFAULT 'PENDING' NOT NULL,
	"reason_id" uuid,
	"base_version" integer DEFAULT 0 NOT NULL,
	"requested_by_type" "actor_type" NOT NULL,
	"requested_by_id" varchar(128) NOT NULL,
	"resolved_by" varchar(128),
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "quote_share_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"share_id" uuid NOT NULL,
	"event" "quote_share_event" NOT NULL,
	"meta" jsonb,
	"ip_hash" varchar(128),
	"ua_hash" varchar(128),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "quote_shares" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"quote_id" uuid NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"token_hash" varchar(128) NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"require_phone_tail" boolean DEFAULT false NOT NULL,
	"allow_pdf" boolean DEFAULT true NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_by" varchar(128) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "customers" DROP CONSTRAINT "customers_code_unique";--> statement-breakpoint
ALTER TABLE "samples" DROP CONSTRAINT "samples_code_unique";--> statement-breakpoint
DROP INDEX "quotes_customer_idx";--> statement-breakpoint
DROP INDEX "quotes_status_idx";--> statement-breakpoint
DROP INDEX "sample_shipments_customer_idx";--> statement-breakpoint
DROP INDEX "audit_log_entity_idx";--> statement-breakpoint
ALTER TABLE "customer_contexts" ADD COLUMN "tenant_id" uuid DEFAULT '00000000-0000-0000-0000-000000000001'::uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "tenant_id" uuid DEFAULT '00000000-0000-0000-0000-000000000001'::uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "owner_id" uuid;--> statement-breakpoint
ALTER TABLE "samples" ADD COLUMN "tenant_id" uuid DEFAULT '00000000-0000-0000-0000-000000000001'::uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "quote_items" ADD COLUMN "tenant_id" uuid DEFAULT '00000000-0000-0000-0000-000000000001'::uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "quotes" ADD COLUMN "tenant_id" uuid DEFAULT '00000000-0000-0000-0000-000000000001'::uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "sample_shipment_items" ADD COLUMN "tenant_id" uuid DEFAULT '00000000-0000-0000-0000-000000000001'::uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "sample_shipments" ADD COLUMN "tenant_id" uuid DEFAULT '00000000-0000-0000-0000-000000000001'::uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN "tenant_id" uuid DEFAULT '00000000-0000-0000-0000-000000000001'::uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "sample_embeddings" ADD COLUMN "tenant_id" uuid DEFAULT '00000000-0000-0000-0000-000000000001'::uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_sample_id_samples_id_fk" FOREIGN KEY ("sample_id") REFERENCES "public"."samples"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipment_items" ADD CONSTRAINT "shipment_items_shipment_id_shipments_id_fk" FOREIGN KEY ("shipment_id") REFERENCES "public"."shipments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipment_items" ADD CONSTRAINT "shipment_items_order_item_id_order_items_id_fk" FOREIGN KEY ("order_item_id") REFERENCES "public"."order_items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receivables" ADD CONSTRAINT "receivables_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receivables" ADD CONSTRAINT "receivables_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "draft_revisions" ADD CONSTRAINT "draft_revisions_revision_request_id_revision_requests_id_fk" FOREIGN KEY ("revision_request_id") REFERENCES "public"."revision_requests"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "revision_requests" ADD CONSTRAINT "revision_requests_reason_id_revision_reasons_id_fk" FOREIGN KEY ("reason_id") REFERENCES "public"."revision_reasons"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote_share_events" ADD CONSTRAINT "quote_share_events_share_id_quote_shares_id_fk" FOREIGN KEY ("share_id") REFERENCES "public"."quote_shares"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote_shares" ADD CONSTRAINT "quote_shares_quote_id_quotes_id_fk" FOREIGN KEY ("quote_id") REFERENCES "public"."quotes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "memberships_tenant_subject_idx" ON "memberships" USING btree ("tenant_id","subject");--> statement-breakpoint
CREATE INDEX "memberships_subject_idx" ON "memberships" USING btree ("subject");--> statement-breakpoint
CREATE INDEX "tenants_status_idx" ON "tenants" USING btree ("status");--> statement-breakpoint
CREATE INDEX "order_items_order_idx" ON "order_items" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "shipment_items_shipment_idx" ON "shipment_items" USING btree ("shipment_id");--> statement-breakpoint
CREATE INDEX "shipments_tenant_order_idx" ON "shipments" USING btree ("tenant_id","order_id");--> statement-breakpoint
CREATE INDEX "orders_tenant_due_status_idx" ON "orders" USING btree ("tenant_id","due_date","status");--> statement-breakpoint
CREATE INDEX "orders_tenant_customer_idx" ON "orders" USING btree ("tenant_id","customer_id");--> statement-breakpoint
CREATE INDEX "receivables_tenant_status_due_idx" ON "receivables" USING btree ("tenant_id","status","due_date");--> statement-breakpoint
CREATE INDEX "receivables_tenant_customer_idx" ON "receivables" USING btree ("tenant_id","customer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "draft_revisions_entity_version_idx" ON "draft_revisions" USING btree ("tenant_id","entity_type","entity_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "revision_reasons_tenant_code_idx" ON "revision_reasons" USING btree ("tenant_id","code");--> statement-breakpoint
CREATE INDEX "revision_requests_entity_created_idx" ON "revision_requests" USING btree ("entity_type","entity_id","created_at");--> statement-breakpoint
CREATE INDEX "revision_requests_tenant_status_idx" ON "revision_requests" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "quote_share_events_share_created_idx" ON "quote_share_events" USING btree ("share_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "quote_shares_token_hash_idx" ON "quote_shares" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "quote_shares_tenant_quote_idx" ON "quote_shares" USING btree ("tenant_id","quote_id");--> statement-breakpoint
CREATE UNIQUE INDEX "customers_tenant_code_idx" ON "customers" USING btree ("tenant_id","code");--> statement-breakpoint
CREATE INDEX "customers_tenant_owner_idx" ON "customers" USING btree ("tenant_id","owner_id");--> statement-breakpoint
CREATE UNIQUE INDEX "samples_tenant_code_idx" ON "samples" USING btree ("tenant_id","code");--> statement-breakpoint
CREATE INDEX "quotes_tenant_customer_idx" ON "quotes" USING btree ("tenant_id","customer_id");--> statement-breakpoint
CREATE INDEX "quotes_tenant_status_created_idx" ON "quotes" USING btree ("tenant_id","status","created_at");--> statement-breakpoint
CREATE INDEX "sample_shipments_tenant_customer_idx" ON "sample_shipments" USING btree ("tenant_id","customer_id");--> statement-breakpoint
CREATE INDEX "audit_log_tenant_entity_idx" ON "audit_log" USING btree ("tenant_id","entity_type","entity_id","created_at");
--> statement-breakpoint
INSERT INTO "tenants" ("id", "slug", "name", "currency", "settings", "status", "isolation_mode")
VALUES ('00000000-0000-0000-0000-000000000001', 'default', '默认演示租户', 'CNY', '{}'::jsonb, 'ACTIVE', 'SHARED_RLS')
ON CONFLICT ("id") DO NOTHING;--> statement-breakpoint
ALTER TABLE "customer_contexts" ALTER COLUMN "tenant_id" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "customers" ALTER COLUMN "tenant_id" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "samples" ALTER COLUMN "tenant_id" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "quote_items" ALTER COLUMN "tenant_id" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "quotes" ALTER COLUMN "tenant_id" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "sample_shipment_items" ALTER COLUMN "tenant_id" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "sample_shipments" ALTER COLUMN "tenant_id" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "audit_log" ALTER COLUMN "tenant_id" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "sample_embeddings" ALTER COLUMN "tenant_id" DROP DEFAULT;