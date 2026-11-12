CREATE TYPE "public"."quote_send_channel" AS ENUM('MANUAL_EXPORT');--> statement-breakpoint
CREATE TABLE "quote_sends" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"quote_id" uuid NOT NULL,
	"channel" "quote_send_channel" DEFAULT 'MANUAL_EXPORT' NOT NULL,
	"format" varchar(16) DEFAULT 'PDF' NOT NULL,
	"actor_type" "actor_type" NOT NULL,
	"actor_id" varchar(128) NOT NULL,
	"recipient" varchar(255),
	"note" text,
	"snapshot" jsonb NOT NULL,
	"snapshot_hash" varchar(64) NOT NULL,
	"receipt_status" varchar(16),
	"receipt_at" timestamp with time zone,
	"external_ref" varchar(128),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "quote_sends" ADD CONSTRAINT "quote_sends_quote_id_quotes_id_fk" FOREIGN KEY ("quote_id") REFERENCES "public"."quotes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "quote_sends_quote_idx" ON "quote_sends" USING btree ("quote_id");--> statement-breakpoint
CREATE INDEX "quote_sends_created_at_idx" ON "quote_sends" USING btree ("created_at");