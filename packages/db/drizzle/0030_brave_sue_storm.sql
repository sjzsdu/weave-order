CREATE TYPE "public"."item_status" AS ENUM('IN_PROGRESS', 'WAITING_INPUT', 'WAITING_DECISION', 'COMPLETED', 'CLOSED');--> statement-breakpoint
CREATE TYPE "public"."ocr_status" AS ENUM('PENDING', 'SUCCEEDED', 'FAILED');--> statement-breakpoint
CREATE TYPE "public"."resource_field_source_kind" AS ENUM('bizcard', 'label', 'history', 'manual', 'llm');--> statement-breakpoint
CREATE TYPE "public"."resource_field_status" AS ENUM('CONFIRMED', 'PENDING', 'EDITED', 'CONFLICT');--> statement-breakpoint
CREATE TYPE "public"."resource_status" AS ENUM('DRAFT', 'AVAILABLE', 'ARCHIVED');--> statement-breakpoint
CREATE TYPE "public"."resource_type" AS ENUM('customer', 'contact', 'sample');--> statement-breakpoint
CREATE TYPE "public"."source_kind" AS ENUM('IMAGE', 'PDF', 'TEXT');--> statement-breakpoint
ALTER TYPE "public"."intent_source" ADD VALUE 'mobile-camera';--> statement-breakpoint
ALTER TYPE "public"."intent_source" ADD VALUE 'upload';--> statement-breakpoint
ALTER TYPE "public"."sample_status" ADD VALUE 'DRAFT';--> statement-breakpoint
ALTER TYPE "public"."sample_status" ADD VALUE 'AVAILABLE';--> statement-breakpoint
CREATE TABLE "items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"status" "item_status" DEFAULT 'IN_PROGRESS' NOT NULL,
	"customer_id" uuid,
	"sample_id" uuid,
	"quantity_milli" bigint,
	"unit" "unit" DEFAULT 'meter' NOT NULL,
	"current_stage" varchar(64),
	"next_action" varchar(255),
	"source_intent_id" uuid,
	"created_by" varchar(128) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ocr_results" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"engine" varchar(128) NOT NULL,
	"raw" jsonb,
	"fields" jsonb,
	"status" "ocr_status" DEFAULT 'PENDING' NOT NULL,
	"failure_code" varchar(64),
	"attempts" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "resource_fields" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"resource_type" "resource_type" NOT NULL,
	"resource_id" uuid NOT NULL,
	"field_name" varchar(64) NOT NULL,
	"value" jsonb,
	"status" "resource_field_status" DEFAULT 'PENDING' NOT NULL,
	"source_id" uuid,
	"source_kind" "resource_field_source_kind" DEFAULT 'manual' NOT NULL,
	"updated_by" varchar(128),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"kind" "source_kind" NOT NULL,
	"object_key" varchar(512),
	"text_content" text,
	"mime_type" varchar(128),
	"byte_size" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "status" "resource_status" DEFAULT 'AVAILABLE' NOT NULL;--> statement-breakpoint
ALTER TABLE "intents" ADD COLUMN "attachments" uuid[] DEFAULT '{}'::uuid[] NOT NULL;--> statement-breakpoint
ALTER TABLE "intents" ADD COLUMN "understanding" jsonb;--> statement-breakpoint
ALTER TABLE "items" ADD CONSTRAINT "items_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "items" ADD CONSTRAINT "items_sample_id_samples_id_fk" FOREIGN KEY ("sample_id") REFERENCES "public"."samples"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "items" ADD CONSTRAINT "items_source_intent_id_intents_id_fk" FOREIGN KEY ("source_intent_id") REFERENCES "public"."intents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ocr_results" ADD CONSTRAINT "ocr_results_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resource_fields" ADD CONSTRAINT "resource_fields_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "items_tenant_status_updated_idx" ON "items" USING btree ("tenant_id","status","updated_at");--> statement-breakpoint
CREATE INDEX "items_tenant_customer_idx" ON "items" USING btree ("tenant_id","customer_id");--> statement-breakpoint
CREATE INDEX "items_tenant_sample_idx" ON "items" USING btree ("tenant_id","sample_id");--> statement-breakpoint
CREATE INDEX "ocr_results_tenant_status_idx" ON "ocr_results" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "ocr_results_source_idx" ON "ocr_results" USING btree ("source_id");--> statement-breakpoint
CREATE UNIQUE INDEX "resource_fields_tenant_resource_field_idx" ON "resource_fields" USING btree ("tenant_id","resource_type","resource_id","field_name");--> statement-breakpoint
CREATE INDEX "resource_fields_tenant_type_status_idx" ON "resource_fields" USING btree ("tenant_id","resource_type","status");--> statement-breakpoint
CREATE INDEX "resource_fields_source_idx" ON "resource_fields" USING btree ("source_id");--> statement-breakpoint
CREATE INDEX "sources_tenant_created_idx" ON "sources" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "customers_tenant_status_idx" ON "customers" USING btree ("tenant_id","status");