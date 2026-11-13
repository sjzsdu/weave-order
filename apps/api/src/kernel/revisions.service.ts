import { revisionReasons } from "@weave-order/db";
import type { Db } from "@weave-order/db";
import { CreateRevisionReasonInput, RevisionReason } from "@weave-order/schema";
import type { RevisionEntityType } from "@weave-order/schema";
import { and, asc, eq } from "drizzle-orm";
import { appendAudit } from "./audit";
import type { KernelContext } from "./audit";
import { KernelError, isUniqueViolation } from "./errors";

type ReasonRow = typeof revisionReasons.$inferSelect;

function mapReason(row: ReasonRow): RevisionReason {
  return RevisionReason.parse({
    id: row.id,
    tenantId: row.tenantId,
    code: row.code,
    label: row.label,
    appliesTo: row.appliesTo,
    active: row.active,
    sortOrder: row.sortOrder,
  });
}

const DEFAULT_REASONS: Array<{
  code: string;
  label: string;
  sortOrder: number;
  appliesTo: RevisionEntityType[];
}> = [
  { code: "PRICE", label: "价格", sortOrder: 10, appliesTo: ["quote", "order"] },
  { code: "DELIVERY", label: "交期", sortOrder: 20, appliesTo: ["quote", "order"] },
  { code: "SPEC", label: "规格", sortOrder: 30, appliesTo: ["quote", "order", "sample_shipment"] },
  { code: "CUSTOMER_REQUEST", label: "客户要求", sortOrder: 40, appliesTo: ["quote", "order"] },
  { code: "OTHER", label: "其他", sortOrder: 90, appliesTo: ["quote", "order", "sample_shipment"] },
];

/**
 * 改稿原因字典：tenant 级配置，驳回必须选原因（不允许自由文本黑洞）。
 * `ensureDefaults` 幂等补齐五条默认原因，供 Track C/D 的驳回抽屉直接使用。
 */
export class RevisionService {
  constructor(
    private readonly db: Db,
    private readonly tenantId: string,
  ) {}

  async list(): Promise<RevisionReason[]> {
    const rows = await this.db
      .select()
      .from(revisionReasons)
      .where(eq(revisionReasons.tenantId, this.tenantId))
      .orderBy(asc(revisionReasons.sortOrder), asc(revisionReasons.code));
    return rows.map(mapReason);
  }

  async create(input: unknown, ctx: KernelContext): Promise<RevisionReason> {
    const parsed = CreateRevisionReasonInput.parse(input);
    try {
      return await this.db.transaction(async (tx) => {
        const rows = await tx
          .insert(revisionReasons)
          .values({
            tenantId: this.tenantId,
            code: parsed.code,
            label: parsed.label,
            appliesTo: parsed.appliesTo,
            active: parsed.active,
            sortOrder: parsed.sortOrder,
          })
          .returning();
        const row = rows[0];
        if (!row) {
          throw new KernelError("KERNEL_REJECTED", "改稿原因写入未返回记录", {
            reason: "INSERT_RETURNED_NO_ROW",
          });
        }
        await appendAudit(
          tx,
          ctx,
          {
            action: "REVISION_RESOLVED",
            entityType: "revision_reason",
            entityId: row.id,
            before: null,
            after: { code: row.code, label: row.label },
          },
          this.tenantId,
        );
        return mapReason(row);
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new KernelError("KERNEL_REJECTED", `改稿原因已存在：${parsed.code}`, {
          reason: "REVISION_REASON_EXISTS",
        });
      }
      throw error;
    }
  }

  /** 幂等补齐默认原因；已存在的不覆盖（租户可自行改名）。 */
  async ensureDefaults(ctx: KernelContext): Promise<RevisionReason[]> {
    const existing = await this.list();
    const existingCodes = new Set(existing.map((reason) => reason.code));
    for (const reason of DEFAULT_REASONS) {
      if (existingCodes.has(reason.code)) continue;
      try {
        await this.create(reason, ctx);
      } catch (error) {
        // 并发补齐时唯一键冲突可以忽略，其余错误继续抛出。
        if (error instanceof KernelError && error.details.reason === "REVISION_REASON_EXISTS") {
          continue;
        }
        throw error;
      }
    }
    return this.list();
  }

  async requireActive(reasonId: string): Promise<RevisionReason> {
    const rows = await this.db
      .select()
      .from(revisionReasons)
      .where(and(eq(revisionReasons.id, reasonId), eq(revisionReasons.tenantId, this.tenantId)))
      .limit(1);
    const row = rows[0];
    if (!row) {
      throw new KernelError("RESOURCE_NOT_FOUND", `改稿原因不存在：${reasonId}`, {
        resourceType: "revision_reason",
        resourceId: reasonId,
      });
    }
    return mapReason(row);
  }
}
