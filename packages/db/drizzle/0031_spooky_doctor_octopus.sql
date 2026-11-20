ALTER TABLE "customers" ADD COLUMN "draft_source_id" uuid;--> statement-breakpoint
ALTER TABLE "samples" ADD COLUMN "draft_source_id" uuid;--> statement-breakpoint
CREATE UNIQUE INDEX "customers_tenant_draft_source_idx" ON "customers" USING btree ("tenant_id","draft_source_id") WHERE "customers"."draft_source_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "samples_tenant_draft_source_idx" ON "samples" USING btree ("tenant_id","draft_source_id") WHERE "samples"."draft_source_id" is not null;