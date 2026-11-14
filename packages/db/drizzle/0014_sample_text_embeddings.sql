-- pgvector：向量列与 HNSW 索引的前提。镜像是 pgvector/pgvector:pg16，已带扩展；
-- 生产由 DBA 在目标库执行同一句（非 superuser 角色会报 permission denied，
-- migrate.ts 会把这条错误翻译成「请 DBA 执行 CREATE EXTENSION vector」）。
CREATE EXTENSION IF NOT EXISTS vector;--> statement-breakpoint
CREATE TABLE "sample_text_embeddings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"sample_id" uuid NOT NULL,
	"model" varchar(64) NOT NULL,
	"dimension" integer NOT NULL,
	"embedding" vector(1024) NOT NULL,
	"content_hash" varchar(64) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sample_text_embeddings" ADD CONSTRAINT "sample_text_embeddings_sample_id_samples_id_fk" FOREIGN KEY ("sample_id") REFERENCES "public"."samples"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "sample_text_embeddings_sample_model_idx" ON "sample_text_embeddings" USING btree ("sample_id","model");--> statement-breakpoint
CREATE INDEX "sample_text_embeddings_tenant_model_idx" ON "sample_text_embeddings" USING btree ("tenant_id","model");--> statement-breakpoint
CREATE INDEX "sample_text_embeddings_embedding_hnsw_idx" ON "sample_text_embeddings" USING hnsw ("embedding" vector_cosine_ops) WITH (m=16,ef_construction=64);--> statement-breakpoint
-- 租户隔离：与 samples / sample_images 完全一致；rls.sql 每次 migrate 后幂等重放同一份定义。
ALTER TABLE "sample_text_embeddings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "sample_text_embeddings" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON "sample_text_embeddings";--> statement-breakpoint
CREATE POLICY tenant_isolation ON "sample_text_embeddings"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
