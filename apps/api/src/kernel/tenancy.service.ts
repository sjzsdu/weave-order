import { memberships, tenants } from "@weave-order/db";
import type { Db } from "@weave-order/db";
import { CreateMembershipInput, CreateTenantInput } from "@weave-order/schema";
import type { Membership, Tenant } from "@weave-order/schema";
import { and, eq } from "drizzle-orm";
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
   * `(sub, org)` → membership。org 只用于校验，租户以本地记录为准。
   * 找不到或已禁用一律抛出同一错误，避免枚举用户。
   */
  async resolveMembership(subject: string, org: string | null): Promise<Membership> {
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
      throw new KernelError("PERMISSION_DENIED", "该账号属于多个租户，请选择组织后再登录");
    }
    if (org !== null && row.casdoorOrg !== null && row.casdoorOrg !== org) {
      throw new KernelError("PERMISSION_DENIED", "令牌组织与本地成员记录不一致");
    }
    return mapMembership(row);
  }

  async listMemberships(tenantId: string): Promise<Membership[]> {
    const rows = await this.db.select().from(memberships).where(eq(memberships.tenantId, tenantId));
    return rows.map(mapMembership);
  }
}
