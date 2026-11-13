import { policyChangeLog, pricingPolicies } from "@weave-order/db";
import type { Db } from "@weave-order/db";
import {
  CreatePricingPolicyInput,
  PricingKey,
  PricingPolicy,
  PricingPolicyValue,
  ResolvedPricingValue,
  UpdatePricingPolicyInput,
  controlDirection,
} from "@weave-order/schema";
import type {
  JsonValue,
  PricingChainEntry,
  PricingContext,
  PricingScopeType,
  PricingSource,
} from "@weave-order/schema";
import { and, eq, lte } from "drizzle-orm";
import { appendAudit } from "./audit";
import type { KernelContext } from "./audit";
import { KernelError, isUniqueViolation } from "./errors";
import { scopeWindowOf } from "./data-scope";
import { toIso } from "./mappers";

type PolicyRow = typeof pricingPolicies.$inferSelect;

/** 作用域层级：越大越具体。团队/客户/品类同层，个人再高一层。 */
const SCOPE_RANK: Record<PricingScopeType, number> = {
  SYSTEM: 0,
  COMPANY: 1,
  TEAM: 2,
  CATEGORY: 2,
  CUSTOMER: 2,
  PERSON: 3,
};

/**
 * 内核内置默认值（没有任何租户策略时使用）。
 * 对齐 product-design §7.4：默认 5 万 / 20 万 / 无上限。
 */
const SYSTEM_DEFAULTS: Record<PricingKey, PricingPolicyValue> = {
  "pricing.min_margin_pct": 0,
  "pricing.default_margin_pct": 20,
  "pricing.cost_floor_amount": 0,
  "pricing.reprice_escalation_pct": 5,
  "pricing.reprice_escalation_amount": 1_000_000,
  "approval.sales.limit": 5_000_000,
  "approval.manager.limit": 20_000_000,
  "approval.owner.limit": null,
};

function numericValue(value: PricingPolicyValue): number | null {
  if (value === null || typeof value === "boolean") return null;
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (typeof value === "object") {
    if ("value" in value && typeof value.value === "number") return value.value;
    if ("amount" in value && typeof value.amount === "number") return value.amount;
    if ("marginPct" in value && typeof value.marginPct === "number") return value.marginPct;
  }
  return null;
}

function isNumericObject(
  value: PricingPolicyValue,
): value is
  | { value: number; unit?: string }
  | { amount: number; unit?: string }
  | { marginPct: number; unit?: string } {
  return typeof value === "object" && value !== null;
}

/** 把数值写回原对象形态，避免夹取后丢失 unit 等展示信息。 */
function withNumericValue(value: PricingPolicyValue, next: number): PricingPolicyValue {
  if (!isNumericObject(value)) return next;
  if ("value" in value) return { ...value, value: next };
  if ("amount" in value) return { ...value, amount: next };
  return { ...value, marginPct: next };
}

/**
 * 夹取后的值形态：
 * - 当前生效值本身是对象时，保留它的形态（改数值字段）；
 * - 当前是裸数字而管控策略是对象时，采用管控策略的对象形态（保留单位）；
 * - 其余保持裸数字。
 */
function revalued(
  current: PricingPolicyValue,
  boundaryRaw: PricingPolicyValue,
  boundary: number,
): PricingPolicyValue {
  if (isNumericObject(current)) return withNumericValue(current, boundary);
  if (isNumericObject(boundaryRaw)) return withNumericValue(boundaryRaw, boundary);
  return boundary;
}

function mapPolicy(row: PolicyRow): PricingPolicy {
  return PricingPolicy.parse({
    id: row.id,
    tenantId: row.tenantId,
    scopeType: row.scopeType,
    scopeId: row.scopeId,
    key: PricingKey.parse(row.key),
    value: PricingPolicyValue.parse(row.value),
    priority: row.priority,
    locked: row.locked,
    effectiveFrom: toIso(row.effectiveFrom),
    createdBy: row.createdBy,
    createdAt: toIso(row.createdAt),
  });
}

function scopeMatches(
  scopeType: PricingScopeType,
  scopeId: string | null,
  context: PricingContext,
  tenantId: string,
): boolean {
  switch (scopeType) {
    case "SYSTEM":
      return true;
    case "COMPANY":
      return scopeId === null || scopeId === tenantId;
    case "TEAM":
      return context.teamId !== undefined && scopeId === context.teamId;
    case "CUSTOMER":
      return context.customerId !== undefined && scopeId === context.customerId;
    case "CATEGORY":
      return context.categoryId !== undefined && scopeId === context.categoryId;
    case "PERSON":
      return context.personId !== undefined && scopeId === context.personId;
  }
}

function sourceOf(row: PolicyRow): PricingSource {
  return {
    policyId: row.id,
    scopeType: row.scopeType,
    scopeId: row.scopeId,
    priority: row.priority,
    locked: row.locked,
    kind: "POLICY",
  };
}

const SYSTEM_SOURCE: PricingSource = {
  policyId: null,
  scopeType: "SYSTEM",
  scopeId: null,
  priority: 0,
  locked: false,
  kind: "SYSTEM_DEFAULT",
};

/**
 * 定价策略内核服务：唯一写 pricing_policies 的入口。
 *
 * 继承链：系统 → 公司 → 团队/客户/品类 → 个人。
 * 管控类（locked）策略无论在哪一层都形成硬边界：
 * - 最低毛利 / 成本底线：只能往上抬（MIN）
 * - 审批上限：只能往下压（MAX）
 * 解析结果同时给出生效值与来源，供审批卡展示「这个数字是谁定的」。
 */
export class PricingService {
  constructor(
    private readonly db: Db,
    private readonly tenantId: string,
  ) {}

  async create(input: unknown, ctx: KernelContext): Promise<PricingPolicy> {
    const parsed = CreatePricingPolicyInput.parse(input);
    this.assertScope(parsed.scopeType, parsed.scopeId ?? null);
    this.assertCanManage(parsed.scopeType, ctx);
    try {
      return await this.db.transaction(async (tx) => {
        // COMPANY 层统一落成 tenantId，避免 NULL 让唯一索引失效、出现两条同键策略。
        const scopeId = parsed.scopeType === "COMPANY" ? this.tenantId : (parsed.scopeId ?? null);
        const rows = await tx
          .insert(pricingPolicies)
          .values({
            tenantId: this.tenantId,
            scopeType: parsed.scopeType,
            scopeId,
            key: parsed.key,
            value: parsed.value as JsonValue,
            priority: parsed.priority,
            locked: parsed.locked,
            effectiveFrom: parsed.effectiveFrom ? new Date(parsed.effectiveFrom) : new Date(),
            createdBy: ctx.actor.id,
          })
          .returning();
        const row = rows[0];
        if (!row) {
          throw new KernelError("KERNEL_REJECTED", "定价策略写入未返回记录", {
            reason: "INSERT_RETURNED_NO_ROW",
          });
        }
        await tx.insert(policyChangeLog).values({
          tenantId: this.tenantId,
          policyId: row.id,
          action: "CREATED",
          oldValue: null,
          newValue: parsed.value as JsonValue,
          actorId: ctx.actor.id,
        });
        await appendAudit(
          tx,
          ctx,
          {
            action: "PRICING_POLICY_CREATED",
            entityType: "pricing_policy",
            entityId: row.id,
            before: null,
            after: {
              scopeType: row.scopeType,
              scopeId: row.scopeId,
              key: row.key,
              value: row.value,
              locked: row.locked,
            },
          },
          this.tenantId,
        );
        return mapPolicy(row);
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new KernelError("KERNEL_REJECTED", `该作用域已存在同键策略：${parsed.key}`, {
          reason: "PRICING_POLICY_EXISTS",
        });
      }
      throw error;
    }
  }

  async update(policyId: string, input: unknown, ctx: KernelContext): Promise<PricingPolicy> {
    const parsed = UpdatePricingPolicyInput.parse(input);
    const current = await this.getById(policyId);
    this.assertCanManage(current.scopeType, ctx);
    return this.db.transaction(async (tx) => {
      const rows = await tx
        .update(pricingPolicies)
        .set({
          value: parsed.value !== undefined ? (parsed.value as JsonValue) : undefined,
          priority: parsed.priority,
          locked: parsed.locked,
          effectiveFrom: parsed.effectiveFrom ? new Date(parsed.effectiveFrom) : undefined,
          updatedAt: new Date(),
        })
        .where(and(eq(pricingPolicies.id, policyId), eq(pricingPolicies.tenantId, this.tenantId)))
        .returning();
      const row = rows[0];
      if (!row) {
        throw new KernelError("RESOURCE_NOT_FOUND", `定价策略不存在：${policyId}`, {
          resourceType: "pricing_policy",
          resourceId: policyId,
        });
      }
      await tx.insert(policyChangeLog).values({
        tenantId: this.tenantId,
        policyId,
        action: "UPDATED",
        oldValue: current.value as JsonValue,
        newValue:
          parsed.value !== undefined ? (parsed.value as JsonValue) : (current.value as JsonValue),
        actorId: ctx.actor.id,
      });
      await appendAudit(
        tx,
        ctx,
        {
          action: "PRICING_POLICY_UPDATED",
          entityType: "pricing_policy",
          entityId: policyId,
          before: { value: current.value, priority: current.priority, locked: current.locked },
          after: { value: row.value, priority: row.priority, locked: row.locked },
        },
        this.tenantId,
      );
      return mapPolicy(row);
    });
  }

  async getById(policyId: string): Promise<PricingPolicy> {
    const rows = await this.db
      .select()
      .from(pricingPolicies)
      .where(and(eq(pricingPolicies.id, policyId), eq(pricingPolicies.tenantId, this.tenantId)))
      .limit(1);
    const row = rows[0];
    if (!row) {
      throw new KernelError("RESOURCE_NOT_FOUND", `定价策略不存在：${policyId}`, {
        resourceType: "pricing_policy",
        resourceId: policyId,
      });
    }
    return mapPolicy(row);
  }

  /**
   * 策略列表。人的维度（PERSON / TEAM）按登录成员的可见范围过滤：
   * 没有 ALL 范围时只看自己的个人策略和本团队策略，公司/系统/品类/客户策略不受限。
   */
  async list(
    filter: { scopeType?: PricingScopeType; scopeId?: string } = {},
    ctx?: KernelContext,
  ): Promise<PricingPolicy[]> {
    const conditions = [eq(pricingPolicies.tenantId, this.tenantId)];
    if (filter.scopeType) conditions.push(eq(pricingPolicies.scopeType, filter.scopeType));
    if (filter.scopeId) conditions.push(eq(pricingPolicies.scopeId, filter.scopeId));
    const rows = await this.db
      .select()
      .from(pricingPolicies)
      .where(and(...conditions));
    const window = scopeWindowOf(ctx);
    return rows
      .filter((row) => {
        if (!window || window.dataScope === "ALL") return true;
        if (row.scopeType === "PERSON") return row.scopeId === window.ownerId;
        if (row.scopeType === "TEAM")
          return window.teamId !== null && row.scopeId === window.teamId;
        return true;
      })
      .map(mapPolicy)
      .sort((a, b) => SCOPE_RANK[a.scopeType] - SCOPE_RANK[b.scopeType] || a.priority - b.priority);
  }

  /** 解析一个策略键的生效值与来源（含完整继承链）。 */
  async resolve(keyInput: PricingKey, context: PricingContext): Promise<ResolvedPricingValue> {
    const key = PricingKey.parse(keyInput);
    const now = new Date();
    const rows = await this.db
      .select()
      .from(pricingPolicies)
      .where(
        and(
          eq(pricingPolicies.tenantId, this.tenantId),
          eq(pricingPolicies.key, key),
          lte(pricingPolicies.effectiveFrom, now),
        ),
      );

    const applicable = rows
      .filter((row) => scopeMatches(row.scopeType, row.scopeId, context, this.tenantId))
      .sort(
        (a, b) =>
          SCOPE_RANK[a.scopeType] - SCOPE_RANK[b.scopeType] ||
          a.priority - b.priority ||
          a.createdAt.getTime() - b.createdAt.getTime() ||
          a.id.localeCompare(b.id),
      );

    const baseRow = applicable[applicable.length - 1];
    let effective = baseRow ? PricingPolicyValue.parse(baseRow.value) : SYSTEM_DEFAULTS[key];
    let source: PricingSource = baseRow ? sourceOf(baseRow) : SYSTEM_SOURCE;
    let clamped = false;

    const direction = controlDirection(key);
    if (direction) {
      // 夹取边界只取 locked 的租户策略。系统推荐值不是边界：公司层（OWNER）是
      // 管控类的唯一出口，可以把自己的阈值设在推荐值之上；限制的是「下级不能放宽
      // 公司层」，而不是「公司不能放宽系统推荐值」（对齐 product-design §3.5）。
      for (const row of applicable) {
        if (!row.locked) continue;
        const boundaryRaw = PricingPolicyValue.parse(row.value);
        const boundary = numericValue(boundaryRaw);
        const current = numericValue(effective);
        if (boundary === null || current === null) continue;
        const tighten = direction === "MIN" ? boundary > current : boundary < current;
        if (tighten) {
          effective = revalued(effective, boundaryRaw, boundary);
          source = sourceOf(row);
          clamped = baseRow === row ? false : true;
        }
      }
    }

    const chain: PricingChainEntry[] = applicable.map((row) => {
      const isSource = source.policyId === row.id;
      return {
        policyId: row.id,
        scopeType: row.scopeType,
        scopeId: row.scopeId,
        value: PricingPolicyValue.parse(row.value),
        priority: row.priority,
        locked: row.locked,
        applied: isSource,
        note: isSource ? null : row.locked ? "管控策略，仅作为边界夹取" : "被更具体的作用域覆盖",
      };
    });
    if (!baseRow) {
      chain.unshift({
        policyId: null,
        scopeType: "SYSTEM",
        scopeId: null,
        value: SYSTEM_DEFAULTS[key],
        priority: 0,
        locked: false,
        applied: true,
        note: "内核内置默认值",
      });
    }

    return ResolvedPricingValue.parse({ key, value: effective, source, clamped, chain });
  }

  /** 批量解析：报价一次算完金额阈值 + 改幅阈值 + 毛利。 */
  async resolveMany(
    keys: readonly PricingKey[],
    context: PricingContext,
  ): Promise<Record<string, ResolvedPricingValue>> {
    // 顺序执行：调用方可能跑在单连接租户会话上，同一 client 并发 query 已被 pg 弃用。
    const entries: ResolvedPricingValue[] = [];
    for (const key of keys) {
      entries.push(await this.resolve(key, context));
    }
    return Object.fromEntries(entries.map((entry) => [entry.key, entry]));
  }

  private assertScope(scopeType: PricingScopeType, scopeId: string | null): void {
    if (scopeType === "SYSTEM" && scopeId !== null) {
      throw new KernelError("KERNEL_REJECTED", "SYSTEM 层策略不能带 scopeId", {
        reason: "INVALID_POLICY_SCOPE",
      });
    }
    if (scopeType === "COMPANY" && scopeId !== null && scopeId !== this.tenantId) {
      throw new KernelError("KERNEL_REJECTED", "COMPANY 层策略的 scopeId 必须是当前租户", {
        reason: "INVALID_POLICY_SCOPE",
      });
    }
    if (
      (scopeType === "TEAM" ||
        scopeType === "CUSTOMER" ||
        scopeType === "PERSON" ||
        scopeType === "CATEGORY") &&
      !scopeId
    ) {
      throw new KernelError("KERNEL_REJECTED", `${scopeType} 层策略必须提供 scopeId`, {
        reason: "INVALID_POLICY_SCOPE",
      });
    }
  }

  /** 定价政策是管控面：公司/系统层只有 OWNER 能改，其余至少 MANAGER。 */
  private assertCanManage(scopeType: PricingScopeType, ctx: KernelContext): void {
    const role = ctx.actor.role;
    if (role !== "OWNER" && role !== "MANAGER") {
      throw new KernelError("PERMISSION_DENIED", "只有 OWNER / MANAGER 可以维护定价策略");
    }
    if ((scopeType === "SYSTEM" || scopeType === "COMPANY") && role !== "OWNER") {
      throw new KernelError("PERMISSION_DENIED", "公司/系统层定价策略只有 OWNER 可以维护");
    }
  }
}

export { numericValue };
