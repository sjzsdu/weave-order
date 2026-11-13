CREATE TYPE "public"."token_usage_status" AS ENUM('RESERVED', 'SETTLED', 'FAILED');--> statement-breakpoint
ALTER TABLE "token_usage" ADD COLUMN "reserved_tokens" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "token_usage" ADD COLUMN "status" "token_usage_status" DEFAULT 'SETTLED' NOT NULL;--> statement-breakpoint
CREATE INDEX "token_usage_tenant_status_idx" ON "token_usage" USING btree ("tenant_id","status");