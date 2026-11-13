import { sampleEmbeddings, samples } from "@weave-order/db";
import type { Db, Tx } from "@weave-order/db";
import { CreateSampleInput } from "@weave-order/schema";
import type { FabricSample, MemberRole } from "@weave-order/schema";
import { and, eq, inArray } from "drizzle-orm";
import { appendAudit } from "./audit";
import type { KernelContext } from "./audit";
import { KernelError, isUniqueViolation } from "./errors";
import { mayViewCost, toIso } from "./mappers";
import type { EmbeddingProvider } from "../platform/embedding";
import { sampleEmbeddingText } from "./sample-embedding-text";

type SampleRow = typeof samples.$inferSelect;

export function mapSample(row: SampleRow): FabricSample {
  return {
    id: row.id,
    tenantId: row.tenantId,
    code: row.code,
    name: row.name,
    composition: row.composition,
    category: row.category,
    weight: row.weight,
    unit: row.unit,
    costFloor:
      row.costFloorAmount === null || row.costFloorCurrency === null
        ? null
        : { amount: row.costFloorAmount, currency: row.costFloorCurrency },
    status: row.status,
    createdAt: toIso(row.createdAt),
  };
}

/**
 * 面向人的样品读模型：按角色裁剪成本底线。
 * 内核内部（计价、工具层）继续用 mapSample 拿到完整底线，裁剪只在这一层发生。
 */
export function presentSample(row: SampleRow, role?: MemberRole): FabricSample {
  const sample = mapSample(row);
  if (mayViewCost(role)) return sample;
  // 契约里 costFloor 是必填可空字段：裁剪后给 null，前端语义等同「不可见/未设置」。
  return { ...sample, costFloor: null };
}

/** 样品内核服务：samples 的唯一写入入口。 */
export class SampleService {
  constructor(
    private readonly db: Db,
    private readonly embedder: EmbeddingProvider,
    private readonly tenantId: string,
  ) {}

  async create(input: unknown, ctx: KernelContext): Promise<FabricSample> {
    const parsed = CreateSampleInput.parse(input);
    // 向量生成在写库前完成；provider 不可用时样品不会半写入。
    const embedding = await this.embedder.embedText(
      sampleEmbeddingText({
        code: parsed.code,
        name: parsed.name,
        composition: parsed.composition ?? null,
        category: parsed.category ?? null,
        weight: parsed.weight ?? null,
      }),
    );
    try {
      return await this.db.transaction((tx) => this.insertWithin(tx, parsed, ctx, embedding));
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new KernelError("KERNEL_REJECTED", `样品编号已存在：${parsed.code}`, {
          reason: "SAMPLE_CODE_EXISTS",
        });
      }
      throw error;
    }
  }

  /**
   * 在外部事务内插入样品 + 向量 + 同事务审计，不自行开事务。
   * 单条 create 与批量导入共用这一处写逻辑；embedding 由调用方在事务前算好。
   */
  async insertWithin(
    tx: Tx,
    parsed: CreateSampleInput,
    ctx: KernelContext,
    embedding: number[],
  ): Promise<FabricSample> {
    const rows = await tx
      .insert(samples)
      .values({
        tenantId: this.tenantId,
        code: parsed.code,
        name: parsed.name,
        composition: parsed.composition ?? null,
        weight: parsed.weight ?? null,
        unit: parsed.unit,
        costFloorAmount: parsed.costFloor?.amount ?? null,
        costFloorCurrency: parsed.costFloor?.currency ?? null,
        status: parsed.status,
      })
      .returning();
    const row = rows[0];
    if (!row) {
      throw new KernelError("KERNEL_REJECTED", "样品写入未返回记录", {
        reason: "INSERT_RETURNED_NO_ROW",
      });
    }
    await tx.insert(sampleEmbeddings).values({
      tenantId: this.tenantId,
      sampleId: row.id,
      model: this.embedder.name,
      dimension: this.embedder.dimension,
      embedding,
    });
    await appendAudit(
      tx,
      ctx,
      {
        action: "SAMPLE_CREATED",
        entityType: "sample",
        entityId: row.id,
        before: null,
        after: {
          code: row.code,
          name: row.name,
          unit: row.unit,
          category: row.category,
          costFloorAmount: row.costFloorAmount,
        },
      },
      this.tenantId,
    );
    return mapSample(row);
  }

  async getById(sampleId: string): Promise<FabricSample> {
    const rows = await this.db
      .select()
      .from(samples)
      .where(and(eq(samples.id, sampleId), eq(samples.tenantId, this.tenantId)))
      .limit(1);
    const row = rows[0];
    if (!row) {
      throw new KernelError("RESOURCE_NOT_FOUND", `样品不存在：${sampleId}`, {
        resourceType: "sample",
        resourceId: sampleId,
      });
    }
    return mapSample(row);
  }

  /** 工具内部使用：按 ID 批量取样品。 */
  async getManyByIds(sampleIds: string[]): Promise<Map<string, FabricSample>> {
    if (sampleIds.length === 0) return new Map();
    const rows = await this.db
      .select()
      .from(samples)
      .where(and(inArray(samples.id, sampleIds), eq(samples.tenantId, this.tenantId)));
    return new Map(rows.map((row) => [row.id, mapSample(row)]));
  }
}
