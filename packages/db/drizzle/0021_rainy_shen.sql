CREATE TABLE "control_sync_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"slug" varchar(64) NOT NULL,
	"name" varchar(255) NOT NULL,
	"owner_email" varchar(255),
	"status" varchar(16) DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"synced_at" timestamp with time zone,
	CONSTRAINT "control_sync_outbox_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE INDEX "control_sync_outbox_status_next_idx" ON "control_sync_outbox" USING btree ("status","next_attempt_at");