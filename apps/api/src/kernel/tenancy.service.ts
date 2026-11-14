import { memberships, tenants } from "@weave-order/db";
import type { Db } from "@weave-order/db";
import { CreateMembershipInput, CreateTenantInput } from "@weave-order/schema";
import type { Membership, Tenant, TenantChoice } from "@weave-order/schema";
import { and, asc, eq, inArray } from "drizzle-orm";
import { appendAudit } from "./audit";
import type { KernelContext } from "./audit";
import { KernelError, isUniqueViolation } from "./errors";
import { toIso } from "./mappers";

type TenantRow = typeof tenants.$inferSelect;
type MembershipRow = typeof memberships.$inferSelect;

export function mapTenant(row: TenantRow): Tenant {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    brand: row.brand,
    bank: row.bank ?? null,
    currency: row.currency,
    settings: row.settings,
    status: row.status,
    isolationMode: row.isolationMode,
    createdAt: toIso(row.createdAt),
    updatedAt: toIso(row.updatedAt),
  };
}

export function mapMembership(row: MembershipRow): Membership {
  return {
    id: row.id,
    tenantId: row.tenantId,
    subject: row.subject,
    casdoorOrg: row.casdoorOrg,
    role: row.role,
    dataScope: row.dataScope,
    teamId: row.teamId,
    approvalLimitAmount: row.approvalLimitAmount,
    status: row.status,
    createdAt: toIso(row.createdAt),
    updatedAt: toIso(row.updatedAt),
  };
}

/**
 * 租户与成员内核服务。
 *
 * 开通租户属于**控制面**操作：生产环境由平台角色执行；
 * 本地/CI 用 owner 连接执行。业务请求永远只读 membership，不写。
 */
export class TenancyService {
  constructor(private readonly db: Db) {}

  async createTenant(input: unknown, ctx: KernelContext): Promise<Tenant> {
    const parsed = CreateTenantInput.parse(input);
    try {
      return await this.db.transaction(async (tx) => {
        const rows = await tx
          .insert(tenants)
          .values({ ...parsed })
          .returning();
        const row = rows[0];
        if (!row) {
          throw new KernelError("KERNEL_REJECTED", "租户写入未返回记录", {
            reason: "INSERT_RETURNED_NO_ROW",
          });
        }
        await appendAudit(
          tx,
          ctx,
          {
            action: "TENANT_CREATED",
            entityType: "tenant",
            entityId: row.id,
            before: null,
            after: { slug: row.slug, name: row.name },
          },
          row.id,
        );
        return mapTenant(row);
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new KernelError("KERNEL_REJECTED", `租户标识已存在：${parsed.slug}`, {
          reason: "TENANT_SLUG_EXISTS",
        });
      }
      throw error;
    }
  }

  async createMembership(input: unknown, ctx: KernelContext): Promise<Membership> {
    const parsed = CreateMembershipInput.parse(input);
    const tenant = await this.getTenant(parsed.tenantId);
    if (tenant.status === "CLOSED") {
      throw new KernelError("KERNEL_REJECTED", "租户已关闭，不能再添加成员", {
        reason: "TENANT_CLOSED",
      });
    }
    try {
      return await this.db.transaction(async (tx) => {
        const rows = await tx
          .insert(memberships)
          .values({
            tenantId: parsed.tenantId,
            subject: parsed.subject,
            casdoorOrg: parsed.casdoorOrg ?? null,
            role: parsed.role,
            dataScope: parsed.dataScope,
            teamId: parsed.teamId ?? null,
            approvalLimitAmount: parsed.approvalLimitAmount ?? null,
          })
          .returning();
        const row = rows[0];
        if (!row) {
          throw new KernelError("KERNEL_REJECTED", "成员写入未返回记录", {
            reason: "INSERT_RETURNED_NO_ROW",
          });
        }
        await appendAudit(
          tx,
          ctx,
          {
            action: "MEMBERSHIP_CREATED",
            entityType: "membership",
            entityId: row.id,
            before: null,
            after: { subject: row.subject, role: row.role, dataScope: row.dataScope },
          },
          row.tenantId,
        );
        return mapMembership(row);
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new KernelError("KERNEL_REJECTED", `成员已存在：${parsed.subject}`, {
          reason: "MEMBERSHIP_EXISTS",
        });
      }
      throw error;
    }
  }

  async getTenant(tenantId: string): Promise<Tenant> {
    const rows = await this.db.select().from(tenants).where(eq(tenants.id, tenantId)).limit(1);
    const row = rows[0];
    if (!row) {
      throw new KernelError("RESOURCE_NOT_FOUND", `租户不存在：${tenantId}`, {
        resourceType: "tenant",
        resourceId: tenantId,
      });
    }
    return mapTenant(row);
  }

  /**
   * 租户选择器的数据源：只返回该 subject 自己的成员关系（ACTIVE + DISABLED）。
   *
   * INVITED 不算成员，不出现；金额上限、teamId 等内部设置也不出现，
   * 因为「一个账号属于哪些公司」本身已经是敏感信息。
   * 必须用目录连接执行：memberships 受 RLS 保护，租户会话只能看到自己那一行。
   */
  async listTenantChoices(subject: string): Promise<TenantChoice[]> {
    const rows = await this.db
      .select({
        tenantId: tenants.id,
        slug: tenants.slug,
        name: tenants.name,
        brand: tenants.brand,
        tenantStatus: tenants.status,
        membershipStatus: memberships.status,
        role: memberships.role,
      })
      .from(memberships)
      .innerJoin(tenants, eq(tenants.id, memberships.tenantId))
      .where(
        and(eq(memberships.subject, subject), inArray(memberships.status, ["ACTIVE", "DISABLED"])),
      )
      .orderBy(asc(tenants.name));

    return rows.map((row) => ({
      tenantId: row.tenantId,
      slug: row.slug,
      name: row.name,
      brand: row.brand,
      role: row.membershipStatus === "ACTIVE" ? row.role : null,
      tenantStatus: row.tenantStatus,
      membershipStatus: row.membershipStatus,
      available: row.membershipStatus === "ACTIVE" && row.tenantStatus !== "CLOSED",
    }));
  }

  /** 该 subject 的 ACTIVE 成员关系条数，用于判断「单租户直进 / 多租户选择 / 零租户」。 */
  async countActiveMemberships(subject: string): Promise<number> {
    const rows = await this.db
      .select({ id: memberships.id })
      .from(memberships)
      .where(and(eq(memberships.subject, subject), eq(memberships.status, "ACTIVE")));
    return rows.length;
  }

  /**
   * `(sub, tenantId)` → 唯一 ACTIVE membership。
   *
   * 授权事实只来自 memberships 行：令牌的 `org` 不参与判断（ADR-3），否则
   * 切换到一个属于另一个 Casdoor Organization 的租户会被误拦。
   * 找不到（不存在 / 已禁用 / 不属于该 subject）一律同一个错误，避免枚举租户。
   */
  async resolveMembership(subject: string, tenantId: string): Promise<Membership> {
    const rows = await this.db
      .select()
      .from(memberships)
      .where(
        and(
          eq(memberships.subject, subject),
          eq(memberships.tenantId, tenantId),
          eq(memberships.status, "ACTIVE"),
        ),
      )
      .limit(1);
    const row = rows[0];
    if (!row) {
      throw new KernelError("PERMISSION_DENIED", "该账号没有这个租户的可用成员身份");
    }
    return mapMembership(row);
  }

  /**
   * 单租户（恰好 1 条 ACTIVE）自动绑定路径：保留 `org` 一致性校验作纵深防御。
   * 多租户账号不在这里处理，由选择流程显式挑一个租户。
   */
  async resolveSoleMembership(subject: string, org: string | null): Promise<Membership> {
    const rows = await this.db
      .select()
      .from(memberships)
      .where(and(eq(memberships.subject, subject), eq(memberships.status, "ACTIVE")))
      .limit(2);
    const row = rows[0];
    if (!row) {
      throw new KernelError("PERMISSION_DENIED", "该账号没有可用的租户成员身份");
    }
    if (rows.length > 1) {
      throw new KernelError("PERMISSION_DENIED", "该账号属于多个租户，请先选择租户");
    }
    if (org !== null && row.casdoorOrg !== null && row.casdoorOrg !== org) {
      throw new KernelError("PERMISSION_DENIED", "令牌组织与本地成员记录不一致");
    }
    return mapMembership(row);
  }

  /**
   * 记录一次选择 / 切换。
   *
   * 审计账本是按租户 RLS + append-only 的，跨租户事件只能落在一边：
   * - 成功：落 **to** 租户（目标租户的人能看到「谁进来了」）；
   * - 拒绝：落 **from** 租户（当前所在租户能看到「有人试图越权」），没有 from 时只打日志。
   * 写失败必须让切换失败：审计是硬要求，不能只切不记。
   */
  async recordTenantSwitch(input: {
    subject: string;
    fromTenantId: string | null;
    toTenantId: string;
    membershipId: string | null;
    result: "ALLOWED" | "DENIED";
  }): Promise<void> {
    const bucket = input.result === "ALLOWED" ? input.toTenantId : input.fromTenantId;
    if (!bucket) return;
    const ctx: KernelContext = { actor: { type: "HUMAN", id: input.subject } };
    await appendAudit(
      this.db,
      ctx,
      {
        action: "TENANT_SWITCHED",
        entityType: input.membershipId ? "membership" : "tenant",
        entityId: input.membershipId ?? input.toTenantId,
        before: { fromTenantId: input.fromTenantId, result: input.result },
        after: { toTenantId: input.toTenantId },
      },
      bucket,
    );
  }

  async listMemberships(tenantId: string): Promise<Membership[]> {
    const rows = await this.db.select().from(memberships).where(eq(memberships.tenantId, tenantId));
    return rows.map(mapMembership);
  }
}
