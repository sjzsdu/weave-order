ALTER TABLE "sample_images" ADD COLUMN "thumb_320_key" varchar(512);--> statement-breakpoint
ALTER TABLE "sample_images" ADD COLUMN "thumb_640_key" varchar(512);--> statement-breakpoint
ALTER TABLE "sample_images" ADD COLUMN "thumb_status" varchar(16) DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "sample_images" ADD COLUMN "thumb_error" varchar(255);--> statement-breakpoint
ALTER TABLE "sample_images" ADD COLUMN "original_byte_size" integer;--> statement-breakpoint
ALTER TABLE "sample_images" ADD COLUMN "reencoded_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "sample_images_tenant_thumb_status_idx" ON "sample_images" USING btree ("tenant_id","thumb_status");--> statement-breakpoint
-- 派生状态三态，与 index_status 同一形态：图墙据此区分「生成中 / 可缓存缩略图 / 生成失败回退原图」。
ALTER TABLE "sample_images" ADD CONSTRAINT "sample_images_thumb_status_check"
  CHECK ("thumb_status" IN ('pending', 'ready', 'failed'));--> statement-breakpoint
-- 回填说明：历史行 ADD COLUMN 后默认 pending，用 `pnpm --filter @weave-order/api maintain:media --skip-compress --skip-orphans`
-- 或默认全量跑一次即可补齐；缩略图 key 只由服务端生成，不依赖客户端参与。
