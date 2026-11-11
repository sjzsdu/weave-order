CREATE TYPE "public"."actor_type" AS ENUM('AGENT', 'HUMAN', 'SYSTEM');--> statement-breakpoint
CREATE TYPE "public"."currency" AS ENUM('CNY', 'USD', 'EUR', 'HKD');--> statement-breakpoint
CREATE TYPE "public"."customer_tier" AS ENUM('VIP', 'REGULAR', 'NEW', 'COLD');--> statement-breakpoint
CREATE TYPE "public"."quote_status" AS ENUM('DRAFT', 'SENT', 'ACCEPTED', 'REJECTED', 'EXPIRED');--> statement-breakpoint
CREATE TYPE "public"."sample_status" AS ENUM('ACTIVE', 'ARCHIVED');--> statement-breakpoint
CREATE TYPE "public"."shipment_channel" AS ENUM('COURIER', 'EXPRESS', 'HAND_CARRY');--> statement-breakpoint
CREATE TYPE "public"."sample_shipment_status" AS ENUM('DRAFT', 'CONFIRMED', 'SHIPPED', 'DELIVERED', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."unit" AS ENUM('meter', 'kilogram', 'yard', 'piece');--> statement-breakpoint
CREATE TABLE "customer_contexts" (
	"customer_id" uuid PRIMARY KEY NOT NULL,
	"preference_notes" text[] DEFAULT '{}'::text[] NOT NULL,
	"pricing_behavior" jsonb NOT NULL,
	"payment_pattern" jsonb NOT NULL,
	"followup_preference" jsonb NOT NULL,
	"decision_deltas" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "customers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" varchar(64) NOT NULL,
	"name" varchar(255) NOT NULL,
	"tier" "customer_tier" DEFAULT 'REGULAR' NOT NULL,
	"contact_name" varchar(255),
	"contact_phone" varchar(64),
	"contact_email" varchar(255),
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customers_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "samples" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" varchar(64) NOT NULL,
	"name" varchar(255) NOT NULL,
	"composition" varchar(255),
	"weight" varchar(64),
	"unit" "unit" DEFAULT 'meter' NOT NULL,
	"cost_floor_amount" integer,
	"cost_floor_currency" "currency",
	"status" "sample_status" DEFAULT 'ACTIVE' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "samples_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "quote_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"quote_id" uuid NOT NULL,
	"sample_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"description" varchar(255) NOT NULL,
	"quantity_milli" integer NOT NULL,
	"unit" "unit" NOT NULL,
	"unit_price_amount" integer NOT NULL,
	"line_total_amount" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "quotes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" uuid NOT NULL,
	"status" "quote_status" DEFAULT 'DRAFT' NOT NULL,
	"currency" "currency" NOT NULL,
	"subtotal_amount" integer NOT NULL,
	"total_amount" integer NOT NULL,
	"validity_days" integer NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"remarks" text,
	"confirmed_by" varchar(128),
	"confirmed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sample_shipment_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shipment_id" uuid NOT NULL,
	"sample_id" uuid NOT NULL,
	"quantity_milli" integer NOT NULL,
	"unit" "unit" NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sample_shipments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" uuid NOT NULL,
	"status" "sample_shipment_status" DEFAULT 'DRAFT' NOT NULL,
	"channel" "shipment_channel" DEFAULT 'COURIER' NOT NULL,
	"carrier" varchar(128),
	"tracking_number" varchar(128),
	"note" text,
	"confirmed_by" varchar(128),
	"confirmed_at" timestamp with time zone,
	"shipped_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"seq" bigserial NOT NULL,
	"actor_type" "actor_type" NOT NULL,
	"actor_id" varchar(128) NOT NULL,
	"action" varchar(64) NOT NULL,
	"entity_type" varchar(64) NOT NULL,
	"entity_id" uuid NOT NULL,
	"before" jsonb,
	"after" jsonb,
	"correlation_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "audit_log_seq_unique" UNIQUE("seq")
);
--> statement-breakpoint
ALTER TABLE "customer_contexts" ADD CONSTRAINT "customer_contexts_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote_items" ADD CONSTRAINT "quote_items_quote_id_quotes_id_fk" FOREIGN KEY ("quote_id") REFERENCES "public"."quotes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote_items" ADD CONSTRAINT "quote_items_sample_id_samples_id_fk" FOREIGN KEY ("sample_id") REFERENCES "public"."samples"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sample_shipment_items" ADD CONSTRAINT "sample_shipment_items_shipment_id_sample_shipments_id_fk" FOREIGN KEY ("shipment_id") REFERENCES "public"."sample_shipments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sample_shipment_items" ADD CONSTRAINT "sample_shipment_items_sample_id_samples_id_fk" FOREIGN KEY ("sample_id") REFERENCES "public"."samples"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sample_shipments" ADD CONSTRAINT "sample_shipments_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "customers_name_idx" ON "customers" USING btree ("name");--> statement-breakpoint
CREATE INDEX "samples_name_idx" ON "samples" USING btree ("name");--> statement-breakpoint
CREATE INDEX "quote_items_quote_idx" ON "quote_items" USING btree ("quote_id");--> statement-breakpoint
CREATE INDEX "quotes_customer_idx" ON "quotes" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "quotes_status_idx" ON "quotes" USING btree ("status");--> statement-breakpoint
CREATE INDEX "sample_shipment_items_shipment_idx" ON "sample_shipment_items" USING btree ("shipment_id");--> statement-breakpoint
CREATE INDEX "sample_shipments_customer_idx" ON "sample_shipments" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "sample_shipments_status_idx" ON "sample_shipments" USING btree ("status");--> statement-breakpoint
CREATE INDEX "audit_log_entity_idx" ON "audit_log" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "audit_log_created_at_idx" ON "audit_log" USING btree ("created_at");