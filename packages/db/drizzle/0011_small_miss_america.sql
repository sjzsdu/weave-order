CREATE TYPE "public"."sample_image_variant" AS ENUM('primary', 'angle', 'detail', 'swatch');--> statement-breakpoint
CREATE TABLE "sample_images" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"sample_id" uuid NOT NULL,
	"object_key" varchar(512) NOT NULL,
	"variant" "sample_image_variant" DEFAULT 'primary' NOT NULL,
	"is_primary" boolean DEFAULT false NOT NULL,
	"mime_type" varchar(32) NOT NULL,
	"byte_size" integer NOT NULL,
	"width" integer,
	"height" integer,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sample_images_object_key_unique" UNIQUE("object_key")
);
--> statement-breakpoint
ALTER TABLE "sample_images" ADD CONSTRAINT "sample_images_sample_id_samples_id_fk" FOREIGN KEY ("sample_id") REFERENCES "public"."samples"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "sample_images_primary_per_sample_idx" ON "sample_images" USING btree ("sample_id") WHERE is_primary = true;--> statement-breakpoint
CREATE INDEX "sample_images_tenant_sample_sort_idx" ON "sample_images" USING btree ("tenant_id","sample_id","sort_order");--> statement-breakpoint
-- 租户隔离：与 samples 完全一致。迁移里先建策略，rls.sql 每次 migrate 后幂等重放同一份定义。
ALTER TABLE "sample_images" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "sample_images" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON "sample_images";--> statement-breakpoint
CREATE POLICY tenant_isolation ON "sample_images"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
