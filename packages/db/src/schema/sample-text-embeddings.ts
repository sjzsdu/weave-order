import {
  index,
  integer,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
  vector,
} from "drizzle-orm/pg-core";
import { samples } from "./samples";

/**
 * 样品**真实文本**向量（pgvector `vector(1024)` + HNSW）。
 *
 * 为什么另建一张表而不改 `sample_embeddings`：
 * - HNSW 要求列维度固定，文本模型（1024）与 S4 的图像向量（可能是 512/1024）不能共用一列；
 * - 旧表是 `real[]`（16 维哈希），与真实模型混存会让「分数看起来正常但完全无效」。
 *
 * `embedding` 存的是模型原样输出（未在应用层归一化）；cosine 距离由 pgvector 计算。
 */
export const sampleTextEmbeddings = pgTable(
  "sample_text_embeddings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    sampleId: uuid("sample_id")
      .notNull()
      .references(() => samples.id, { onDelete: "cascade" }),
    /** provider + model 标识，如 "dashscope-text-embedding-v3" */
    model: varchar("model", { length: 64 }).notNull(),
    dimension: integer("dimension").notNull(),
    embedding: vector("embedding", { dimensions: 1024 }).notNull(),
    /** 生成向量的原文 sha256；变了就必须重算，避免改名后仍命中旧语义。 */
    contentHash: varchar("content_hash", { length: 64 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("sample_text_embeddings_sample_model_idx").on(table.sampleId, table.model),
    index("sample_text_embeddings_tenant_model_idx").on(table.tenantId, table.model),
    // HNSW：近似最近邻索引。m / ef_construction 是召回率与建索引成本的折中（pgvector 默认值）。
    index("sample_text_embeddings_embedding_hnsw_idx")
      .using("hnsw", table.embedding.op("vector_cosine_ops"))
      .with({ m: 16, ef_construction: 64 }),
  ],
);

export type SampleTextEmbeddingRow = typeof sampleTextEmbeddings.$inferSelect;
