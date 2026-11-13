CREATE TYPE "public"."box_label_status" AS ENUM('ACTIVE', 'VOIDED');--> statement-breakpoint
CREATE TYPE "public"."order_box_status" AS ENUM('OPEN', 'PACKED', 'VOIDED');--> statement-breakpoint
CREATE TYPE "public"."print_agent_status" AS ENUM('ONLINE', 'OFFLINE', 'DISABLED');--> statement-breakpoint
CREATE TYPE "public"."print_document_kind" AS ENUM('PICKING_LIST', 'DELIVERY_NOTE', 'PACKING_LIST', 'BOX_LABEL', 'SAMPLE_LABEL', 'SHELF_LABEL', 'TEST_LABEL');--> statement-breakpoint
CREATE TYPE "public"."print_job_status" AS ENUM('QUEUED', 'SENT', 'PRINTING', 'DONE', 'FAILED', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."print_template_format" AS ENUM('HTML', 'ZPL', 'TSPL');--> statement-breakpoint
CREATE TYPE "public"."print_template_scope" AS ENUM('SYSTEM', 'COMPANY', 'DOCUMENT_TYPE');--> statement-breakpoint
CREATE TYPE "public"."printer_connection" AS ENUM('SYSTEM_DRIVER', 'RAW_TCP', 'USB', 'BLUETOOTH');--> statement-breakpoint
CREATE TYPE "public"."printer_kind" AS ENUM('A4', 'THERMAL', 'BLUETOOTH');--> statement-breakpoint
CREATE TYPE "public"."printer_status" AS ENUM('READY', 'OFFLINE', 'NEEDS_ATTENTION');--> statement-breakpoint
CREATE TYPE "public"."scan_result" AS ENUM('OK', 'MISMATCH', 'UNKNOWN_CODE', 'WRONG_BOX');--> statement-breakpoint
CREATE TYPE "public"."scan_event_type" AS ENUM('PICK', 'VERIFY');--> statement-breakpoint
CREATE TABLE "box_labels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"box_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"qr_payload" varchar(255) NOT NULL,
	"status" "box_label_status" DEFAULT 'ACTIVE' NOT NULL,
	"voided_at" timestamp with time zone,
	"void_reason" varchar(64),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "document_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"kind" "print_document_kind" NOT NULL,
	"document_id" uuid NOT NULL,
	"view" jsonb NOT NULL,
	"sha256" varchar(64) NOT NULL,
	"created_by" varchar(128) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "order_box_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"box_id" uuid NOT NULL,
	"shipment_item_id" uuid NOT NULL,
	"order_item_id" uuid NOT NULL,
	"quantity_milli" bigint NOT NULL,
	"unit" varchar(16) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "order_boxes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"shipment_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"box_no" varchar(32) NOT NULL,
	"seq" integer DEFAULT 1 NOT NULL,
	"status" "order_box_status" DEFAULT 'OPEN' NOT NULL,
	"gross_weight_kg" varchar(32),
	"size" varchar(64),
	"note" varchar(500),
	"verified_at" timestamp with time zone,
	"verified_by" varchar(128),
	"has_discrepancy" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "print_agents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" varchar(128) NOT NULL,
	"location" varchar(128),
	"token_hash" varchar(128) NOT NULL,
	"status" "print_agent_status" DEFAULT 'OFFLINE' NOT NULL,
	"app_version" varchar(64),
	"last_seen_at" timestamp with time zone,
	"disabled_at" timestamp with time zone,
	"created_by" varchar(128) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "print_job_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"status" "print_job_status" NOT NULL,
	"message" varchar(500),
	"agent_id" uuid,
	"printer_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "print_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"kind" "print_document_kind" NOT NULL,
	"document_id" uuid NOT NULL,
	"order_id" uuid,
	"shipment_id" uuid,
	"box_id" uuid,
	"label_seq" integer,
	"template_id" uuid,
	"template_version_id" uuid,
	"template_version" integer,
	"printer_id" uuid,
	"agent_id" uuid,
	"format" "print_template_format" NOT NULL,
	"copies" integer DEFAULT 1 NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"status" "print_job_status" DEFAULT 'QUEUED' NOT NULL,
	"idempotency_key" varchar(160) NOT NULL,
	"payload" text NOT NULL,
	"snapshot_id" uuid,
	"reprint_reason" varchar(64),
	"requested_by" varchar(128) NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" varchar(500),
	"claimed_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "print_template_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"template_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"body" text NOT NULL,
	"variables" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"page_size" varchar(32),
	"changelog" varchar(500),
	"published_by" varchar(128) NOT NULL,
	"published_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "print_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"kind" "print_document_kind" NOT NULL,
	"scope" "print_template_scope" NOT NULL,
	"variant" varchar(64),
	"name" varchar(128) NOT NULL,
	"format" "print_template_format" NOT NULL,
	"active_version_id" uuid,
	"archived_at" timestamp with time zone,
	"created_by" varchar(128) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "printers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"name" varchar(128) NOT NULL,
	"kind" "printer_kind" NOT NULL,
	"connection" "printer_connection" NOT NULL,
	"address" varchar(255),
	"capabilities" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"calibration" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" "printer_status" DEFAULT 'OFFLINE' NOT NULL,
	"last_seen_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scan_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"shipment_id" uuid NOT NULL,
	"box_id" uuid,
	"type" "scan_event_type" NOT NULL,
	"result" "scan_result" NOT NULL,
	"qr_payload" varchar(255),
	"order_item_id" uuid,
	"quantity_milli" bigint,
	"unit" varchar(16),
	"scanned_by" varchar(128) NOT NULL,
	"message" varchar(500),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "box_labels" ADD CONSTRAINT "box_labels_box_id_order_boxes_id_fk" FOREIGN KEY ("box_id") REFERENCES "public"."order_boxes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_box_items" ADD CONSTRAINT "order_box_items_box_id_order_boxes_id_fk" FOREIGN KEY ("box_id") REFERENCES "public"."order_boxes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_box_items" ADD CONSTRAINT "order_box_items_shipment_item_id_shipment_items_id_fk" FOREIGN KEY ("shipment_item_id") REFERENCES "public"."shipment_items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_box_items" ADD CONSTRAINT "order_box_items_order_item_id_order_items_id_fk" FOREIGN KEY ("order_item_id") REFERENCES "public"."order_items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_boxes" ADD CONSTRAINT "order_boxes_shipment_id_shipments_id_fk" FOREIGN KEY ("shipment_id") REFERENCES "public"."shipments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_boxes" ADD CONSTRAINT "order_boxes_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "print_job_events" ADD CONSTRAINT "print_job_events_job_id_print_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."print_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "print_jobs" ADD CONSTRAINT "print_jobs_snapshot_id_document_snapshots_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."document_snapshots"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "print_template_versions" ADD CONSTRAINT "print_template_versions_template_id_print_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."print_templates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "printers" ADD CONSTRAINT "printers_agent_id_print_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."print_agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "box_labels_box_seq_idx" ON "box_labels" USING btree ("box_id","seq");--> statement-breakpoint
CREATE INDEX "box_labels_qr_idx" ON "box_labels" USING btree ("tenant_id","qr_payload");--> statement-breakpoint
CREATE INDEX "document_snapshots_document_idx" ON "document_snapshots" USING btree ("tenant_id","kind","document_id");--> statement-breakpoint
CREATE INDEX "order_box_items_box_idx" ON "order_box_items" USING btree ("box_id");--> statement-breakpoint
CREATE UNIQUE INDEX "order_boxes_shipment_box_no_idx" ON "order_boxes" USING btree ("shipment_id","box_no");--> statement-breakpoint
CREATE INDEX "order_boxes_tenant_order_idx" ON "order_boxes" USING btree ("tenant_id","order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "print_agents_token_hash_idx" ON "print_agents" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "print_agents_tenant_status_idx" ON "print_agents" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "print_job_events_job_idx" ON "print_job_events" USING btree ("job_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "print_jobs_idempotency_idx" ON "print_jobs" USING btree ("tenant_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "print_jobs_queue_idx" ON "print_jobs" USING btree ("tenant_id","status","priority","created_at");--> statement-breakpoint
CREATE INDEX "print_jobs_shipment_idx" ON "print_jobs" USING btree ("tenant_id","shipment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "print_template_versions_template_version_idx" ON "print_template_versions" USING btree ("template_id","version");--> statement-breakpoint
CREATE INDEX "print_template_versions_tenant_idx" ON "print_template_versions" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "print_templates_tenant_kind_idx" ON "print_templates" USING btree ("tenant_id","kind","scope");--> statement-breakpoint
CREATE UNIQUE INDEX "print_templates_tenant_name_idx" ON "print_templates" USING btree ("tenant_id","kind","name");--> statement-breakpoint
CREATE UNIQUE INDEX "printers_agent_name_idx" ON "printers" USING btree ("agent_id","name");--> statement-breakpoint
CREATE INDEX "printers_tenant_idx" ON "printers" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "scan_events_shipment_idx" ON "scan_events" USING btree ("shipment_id","created_at");