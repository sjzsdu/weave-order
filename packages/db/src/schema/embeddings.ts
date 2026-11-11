import {
  index,
  integer,
  pgTable,
  real,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { samples } from "./samples";

/**
 * 样品向量索引（找样工具用）。
 *
 * MVP 阶段用 `real[]` 存向量并在应用内算 cosine 相似度：不需要 pgvector 扩展，
 * 本地任何 PG 都能跑。真实商品库上量后改成 pgvector 的 `vector` 列 + HNSW 索引，
 * 只需替换本表列类型与 SearchService 的查询，契约不变。
 */
export const sampleEmbeddings = pgTable(
  "sample_embeddings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sampleId: uuid("sample_id")
      .notNull()
      .references(() => samples.id, { onDelete: "cascade" }),
    /** provider 标识，如 "local-stub-v1" */
    model: varchar("model", { length: 64 }).notNull(),
    dimension: integer("dimension").notNull(),
    /** 已归一化的向量 */
    embedding: real("embedding").array().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("sample_embeddings_sample_model_idx").on(table.sampleId, table.model),
    index("sample_embeddings_model_idx").on(table.model),
  ],
);
