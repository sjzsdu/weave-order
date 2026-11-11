import { samples } from "@weave-order/db";
import type { Db } from "@weave-order/db";
import { CreateSampleInput } from "@weave-order/schema";
import type { FabricSample } from "@weave-order/schema";
import { eq, inArray } from "drizzle-orm";
import { appendAudit } from "./audit";
import type { KernelContext } from "./audit";
import { KernelError, isUniqueViolation } from "./errors";
import { toIso } from "./mappers";

type SampleRow = typeof samples.$inferSelect;

export function mapSample(row: SampleRow): FabricSample {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    composition: row.composition,
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

/** 样品内核服务：samples 的唯一写入入口。 */
export class SampleService {
  constructor(private readonly db: Db) {}

  async create(input: unknown, ctx: KernelContext): Promise<FabricSample> {
    const parsed = CreateSampleInput.parse(input);
    try {
      return await this.db.transaction(async (tx) => {
        const rows = await tx
          .insert(samples)
          .values({
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
        await appendAudit(tx, ctx, {
          action: "SAMPLE_CREATED",
          entityType: "sample",
          entityId: row.id,
          before: null,
          after: {
            code: row.code,
            name: row.name,
            unit: row.unit,
            costFloorAmount: row.costFloorAmount,
          },
        });
        return mapSample(row);
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new KernelError("KERNEL_REJECTED", `样品编号已存在：${parsed.code}`, {
          reason: "SAMPLE_CODE_EXISTS",
        });
      }
      throw error;
    }
  }

  async getById(sampleId: string): Promise<FabricSample> {
    const rows = await this.db.select().from(samples).where(eq(samples.id, sampleId)).limit(1);
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
    const rows = await this.db.select().from(samples).where(inArray(samples.id, sampleIds));
    return new Map(rows.map((row) => [row.id, mapSample(row)]));
  }
}
