CREATE TYPE "public"."inbound_channel" AS ENUM('manual', 'screenshot');--> statement-breakpoint
ALTER TYPE "public"."llm_task" ADD VALUE 'SCREENSHOT_OCR';--> statement-breakpoint
CREATE TABLE "inbound_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"channel" "inbound_channel" NOT NULL,
	"external_id" varchar(128) NOT NULL,
	"customer_ref" varchar(128),
	"text" text NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"raw_payload" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX "inbound_messages_tenant_channel_external_idx" ON "inbound_messages" USING btree ("tenant_id","channel","external_id");