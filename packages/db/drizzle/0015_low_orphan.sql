CREATE TABLE "sample_image_embeddings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"sample_id" uuid NOT NULL,
	"image_id" uuid NOT NULL,
	"model" varchar(64) NOT NULL,
	"dimension" integer NOT NULL,
	"embedding" vector NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sample_images" ADD COLUMN "index_status" varchar(16) DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "sample_images" ADD COLUMN "index_error" varchar(255);--> statement-breakpoint
ALTER TABLE "sample_image_embeddings" ADD CONSTRAINT "sample_image_embeddings_sample_id_samples_id_fk" FOREIGN KEY ("sample_id") REFERENCES "public"."samples"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sample_image_embeddings" ADD CONSTRAINT "sample_image_embeddings_image_id_sample_images_id_fk" FOREIGN KEY ("image_id") REFERENCES "public"."sample_images"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "sample_image_embeddings_image_model_idx" ON "sample_image_embeddings" USING btree ("image_id","model");--> statement-breakpoint
CREATE INDEX "sample_image_embeddings_tenant_model_idx" ON "sample_image_embeddings" USING btree ("tenant_id","model");--> statement-breakpoint
CREATE INDEX "sample_image_embeddings_sample_idx" ON "sample_image_embeddings" USING btree ("sample_id");--> statement-breakpoint
CREATE INDEX "sample_images_tenant_index_status_idx" ON "sample_images" USING btree ("tenant_id","index_status");--> statement-breakpoint
-- 索引状态只能是三态：图墙据此区分「检索中 / 可检索 / 索引失败」，不接受空串或拼错。
ALTER TABLE "sample_images" ADD CONSTRAINT "sample_images_index_status_check"
  CHECK ("index_status" IN ('pending', 'ready', 'failed'));--> statement-breakpoint
-- 回填说明：ADD COLUMN ... NOT NULL DEFAULT 'pending' 已经把历史行填成 pending，
-- `reindex:images` 据此把 S4 之前入库的图片补上向量，不会漏。
-- 每模型一条 partial 表达式索引：向量列不定维，HNSW 必须靠 `::vector(N)` 固定维度。
-- 每模型一条 partial 表达式索引，索引名带模型 + 维度：
-- 换模型/换维度都不会被同名索引静默跳过（ensureHnswIndex 也会核对已有索引维度）。
-- model 名与 providers 的 `name` 一致：dashscope-qwen3-vl-embedding。
CREATE INDEX "sample_image_embeddings_hnsw_dashscope_qwen3_vl_embedding_1024"
  ON "sample_image_embeddings"
  USING hnsw ((embedding::vector(1024)) vector_cosine_ops)
  WITH (m=16, ef_construction=64)
  WHERE model = 'dashscope-qwen3-vl-embedding';--> statement-breakpoint
-- 租户隔离：与 samples / sample_images / sample_text_embeddings 完全一致。
ALTER TABLE "sample_image_embeddings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "sample_image_embeddings" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON "sample_image_embeddings";--> statement-breakpoint
CREATE POLICY tenant_isolation ON "sample_image_embeddings"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
