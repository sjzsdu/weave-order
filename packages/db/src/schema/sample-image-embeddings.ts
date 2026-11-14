import {
  customType,
  index,
  integer,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { sampleImages, samples } from "./samples";

/**
 * 不声明维度的 pgvector 列。
 *
 * drizzle 内置的 `vector()` 强制要求 dimensions，而这里刻意不固定：换 embedding
 * provider 会换维度，固定列宽就等于把「换模型」变成一次表结构迁移。
 * 维度约束下沉到 `dimension` 列与每条 partial 索引的 `::vector(N)` 表达式。
 */
const untypedVector = customType<{ data: number[]; driverData: string }>({
  dataType() {
    return "vector";
  },
  toDriver(value: number[]): string {
    return `[${value.join(",")}]`;
  },
  fromDriver(value: string | number[]): number[] {
    if (Array.isArray(value)) return value;
    return JSON.parse(value) as number[];
  },
});

/**
 * 样品**图像**向量（多模态 embedding，工作向量与文本向量不同空间）。
 *
 * 为什么 `embedding` 不声明维度（`vector` 而不是 `vector(1024)`）：
 * 换 embedding provider 时维度会变，而 HNSW 索引要求维度固定。把维度留在
 * `dimension` 列 + 每条索引的 partial 谓词上，换模型只需「新增一条表达式索引 +
 * 回填新模型的行」，不需要改表结构或停服。索引在迁移里手写：
 *
 *   create index ... using hnsw ((embedding::vector(1024)) vector_cosine_ops)
 *     where model = 'a-qwen3-vl-embedding';
 *
 * 查询必须带 `model = ?` 且用同样的 `::vector(N)` 表达式，planner 才会命中该索引。
 * 不允许跨模型比较同一列的向量：不同模型的向量空间不可互换。
 */
export const sampleImageEmbeddings = pgTable(
  "sample_image_embeddings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    sampleId: uuid("sample_id")
      .notNull()
      .references(() => samples.id, { onDelete: "cascade" }),
    imageId: uuid("image_id")
      .notNull()
      .references(() => sampleImages.id, { onDelete: "cascade" }),
    /** provider + model 标识，如 "dashscope-qwen3-vl-embedding" */
    model: varchar("model", { length: 64 }).notNull(),
    dimension: integer("dimension").notNull(),
    embedding: untypedVector("embedding").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // 同一张图同一模型只算一次：重复 confirm / 重放不会产生第二份向量。
    uniqueIndex("sample_image_embeddings_image_model_idx").on(table.imageId, table.model),
    index("sample_image_embeddings_tenant_model_idx").on(table.tenantId, table.model),
    index("sample_image_embeddings_sample_idx").on(table.sampleId),
  ],
);

export type SampleImageEmbeddingRow = typeof sampleImageEmbeddings.$inferSelect;
