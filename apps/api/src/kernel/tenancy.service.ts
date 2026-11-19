import { controlSyncOutbox, memberships, tenants } from "@weave-order/db";
import type { Db } from "@weave-order/db";
import {
  CreateMembershipInput,
  CreateTenantInput,
  hasCapability,
} from "@weave-order/schema";
import type { DataScope, MemberRole, Membership, Tenant, TenantChoice } from "@weave-order/schema";
import { and, asc, eq, inArray } from "drizzle-orm";
import { appendAudit } from "./audit";
import type { KernelContext } from "./audit";
import { KernelError, isUniqueViolation } from "./errors";
import { seedFieldOptions } from "./field-options.service";
import { isTechnicalId } from "./member-label";
import { toIso } from "./mappers";

type TenantRow = typeof tenants.$inferSelect;
type MembershipRow = typeof memberships.$inferSelect;

/** 登录 claims 的姓名：空白与 UUID（某些 IdP 会拿 sub 回填 name）都不算展示名。 */
function cleanProfileName(value: string | null | undefined): string | null {
  const name = value?.trim();
  if (!name || isTechnicalId(name)) return null;
  return name.slice(0, 128);
}

/** 登录 claims 的邮箱：只有像邮箱的值才落库，避免把用户名塞进 email 列。 */
function normalizeEmail(value: string | null | undefined): string | null {
  const email = value?.trim().toLowerCase();
  if (!email || !email.includes("@")) return null;
  return email.slice(0, 255);
}

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
    displayName: row.displayName ?? null,
    email: row.email ?? null,
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

  /**
   * 控制面登记意图（Transactional Outbox）。
   *
   * 传入时，outbox 行与租户、审计在**同一个事务**写入：租户落地 ⟺ 登记意图落地，
   * 杜绝「公司建好了但总后台没有」。outbox 由 apps/api 的投递 worker 可靠消费。
   */
  async createTenant(
    input: unknown,
    ctx: KernelContext,
    controlSync?: { slug: string; name: string; ownerEmail: string | null },
  ): Promise<Tenant> {
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
        // 新公司的等级/品类/成分/联系人角色预置项：与租户同事务，避免「新公司打开下拉是空的」。
        // 0024/0025 迁移只覆盖迁移时刻已存在的租户。
        await seedFieldOptions(tx, row.id);
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
        if (controlSync) {
          // 与租户同事务：投递失败也不会留下「有租户、无登记意图」的半瘸状态。
          await tx.insert(controlSyncOutbox).values({
            tenantId: row.id,
            slug: controlSync.slug,
            name: controlSync.name,
            ownerEmail: controlSync.ownerEmail,
          });
        }
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
            displayName: parsed.displayName ?? null,
            email: parsed.email ?? null,
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
   * 按 slug 找租户，找不到返回 null。
   *
   * 开通流程用它做幂等键：同一个开通链接被打开两次，第二次必须落到同一间公司。
   */
  async findTenantBySlug(slug: string): Promise<Tenant | null> {
    const rows = await this.db.select().from(tenants).where(eq(tenants.slug, slug)).limit(1);
    const row = rows[0];
    return row ? mapTenant(row) : null;
  }

  /**
   * 该 subject 在指定租户下的成员关系（任意状态），找不到返回 null。
   *
   * 多租户下不能再用「按 subject 查唯一身份」：同一个人可能同时属于几家公司，
   * 开通与邀请都必须落到具体租户。
   */
  async findMembershipForTenant(subject: string, tenantId: string): Promise<Membership | null> {
    const rows = await this.db
      .select()
      .from(memberships)
      .where(and(eq(memberships.subject, subject), eq(memberships.tenantId, tenantId)))
      .limit(1);
    const row = rows[0];
    return row ? mapMembership(row) : null;
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

  /**
   * 调整成员角色 / 数据范围 / 审批额度（WAN-175「成员与权限」）。
   *
   * 规则写在内核而不是控制器：前端隐藏只是减少误触，真正的边界在这里。
   * - 只有具备 `member.invite` 的角色能改（OWNER / MANAGER）；
   * - 不能修改 OWNER 成员，也不能把别人提成 OWNER（只有 OWNER 能授予 OWNER）；
   * - 不能改自己的角色：否则一次误操作就把自己锁在门外；
   * - 降级最后一位 OWNER 直接拒绝，避免公司失去管理员。
   * 每个实际变化的字段各写一条审计，且与 UPDATE 同事务。
   */
  async updateMembership(
    input: {
      tenantId: string;
      membershipId: string;
      role?: MemberRole;
      dataScope?: DataScope;
      approvalLimitAmount?: number | null;
    },
    ctx: KernelContext,
  ): Promise<Membership> {
    if (!ctx.actor.role || !hasCapability(ctx.actor.role, "member.invite")) {
      throw new KernelError("PERMISSION_DENIED", "只有老板或主管可以调整成员权限");
    }
    return await this.db.transaction(async (tx) => {
      const rows = await tx
        .select()
        .from(memberships)
        .where(
          and(eq(memberships.id, input.membershipId), eq(memberships.tenantId, input.tenantId)),
        )
        .limit(1);
      const row = rows[0];
      if (!row) throw new KernelError("RESOURCE_NOT_FOUND", "这条成员记录不存在");

      const isSelf = ctx.ownerId === row.id;
      if (
        row.role === "OWNER" &&
        (!ctx.actor.role || !hasCapability(ctx.actor.role, "member.owner.grant"))
      ) {
        throw new KernelError("PERMISSION_DENIED", "只有老板可以调整老板的权限");
      }
      if (
        input.role === "OWNER" &&
        (!ctx.actor.role || !hasCapability(ctx.actor.role, "member.owner.grant"))
      ) {
        throw new KernelError("PERMISSION_DENIED", "只有老板可以授予老板角色");
      }
      if (row.role === "OWNER" && input.role !== undefined && input.role !== "OWNER") {
        const owners = await tx
          .select({ id: memberships.id })
          .from(memberships)
          .where(
            and(
              eq(memberships.tenantId, input.tenantId),
              eq(memberships.role, "OWNER"),
              eq(memberships.status, "ACTIVE"),
            ),
          );
        if (owners.length <= 1) {
          throw new KernelError("KERNEL_REJECTED", "至少保留一位老板，不能把最后一位老板降级");
        }
      }

      const changed: Array<{
        action: "MEMBERSHIP_ROLE_CHANGED" | "MEMBERSHIP_SCOPE_CHANGED" | "MEMBERSHIP_LIMIT_CHANGED";
        before: string | number | null;
        after: string | number | null;
      }> = [];
      const next: Partial<MembershipRow> = {};
      if (input.role !== undefined && input.role !== row.role) {
        next.role = input.role;
        changed.push({ action: "MEMBERSHIP_ROLE_CHANGED", before: row.role, after: input.role });
      }
      if (input.dataScope !== undefined && input.dataScope !== row.dataScope) {
        next.dataScope = input.dataScope;
        changed.push({
          action: "MEMBERSHIP_SCOPE_CHANGED",
          before: row.dataScope,
          after: input.dataScope,
        });
      }
      if (
        input.approvalLimitAmount !== undefined &&
        input.approvalLimitAmount !== row.approvalLimitAmount
      ) {
        next.approvalLimitAmount = input.approvalLimitAmount;
        changed.push({
          action: "MEMBERSHIP_LIMIT_CHANGED",
          before: row.approvalLimitAmount,
          after: input.approvalLimitAmount,
        });
      }

      if (changed.length === 0) {
        throw new KernelError("KERNEL_REJECTED", "没有需要修改的内容");
      }
      // 自己改自己的角色 / 范围 / 额度，轻则把自己锁在门外，重则自抬审批上限；
      // 一律要求另一位管理员操作。UI 同样不给自己这一行渲染编辑入口。
      if (isSelf) {
        throw new KernelError("KERNEL_REJECTED", "不能修改自己的权限，请让另一位管理员操作");
      }

      const updated = await tx
        .update(memberships)
        .set({ ...next, updatedAt: new Date() })
        .where(eq(memberships.id, row.id))
        .returning();
      const fresh = updated[0];
      if (!fresh) throw new KernelError("KERNEL_REJECTED", "成员更新未返回记录");

      for (const entry of changed) {
        await appendAudit(
          tx,
          ctx,
          {
            action: entry.action,
            entityType: "membership",
            entityId: row.id,
            before: { value: entry.before },
            after: { value: entry.after, email: fresh.email, displayName: fresh.displayName },
          },
          input.tenantId,
        );
      }
      return mapMembership(fresh);
    });
  }

  /**
   * 撤销一条待接受的邀请。
   *
   * 只允许删 `INVITED`：邀请链接里的票据没有落库，删掉这条 membership
   * 就等于让票据失效（`activateMembership` 找不到行）。`ACTIVE` 成员是
   * 「停用」语义，需要保留成员行以还原历史归属，不在这里删。
   * 条件写在 DELETE 里，避免「查完刚好被对方接受」的竞态。
   */
  async revokeMembership(
    tenantId: string,
    membershipId: string,
    ctx: KernelContext,
  ): Promise<Membership> {
    return await this.db.transaction(async (tx) => {
      const rows = await tx
        .select()
        .from(memberships)
        .where(and(eq(memberships.id, membershipId), eq(memberships.tenantId, tenantId)))
        .limit(1);
      const row = rows[0];
      if (!row) throw new KernelError("RESOURCE_NOT_FOUND", "这条邀请不存在或已被撤销");
      if (row.status !== "INVITED") {
        throw new KernelError("KERNEL_REJECTED", "对方已经接受了邀请，不能再撤销");
      }

      const deleted = await tx
        .delete(memberships)
        .where(
          and(
            eq(memberships.id, membershipId),
            eq(memberships.tenantId, tenantId),
            eq(memberships.status, "INVITED"),
          ),
        )
        .returning();
      if (deleted.length === 0) {
        throw new KernelError("KERNEL_REJECTED", "对方已经接受了邀请，不能再撤销");
      }

      await appendAudit(
        tx,
        ctx,
        {
          action: "MEMBERSHIP_REVOKED",
          entityType: "membership",
          entityId: membershipId,
          before: { email: row.subject, role: row.role, status: row.status },
        },
        tenantId,
      );
      return mapMembership(row);
    });
  }

  /**
   * 邀请同事：先落一条 `INVITED` 成员，`subject` 暂存邮箱。
   *
   * 为什么不直接按邮箱建 ACTIVE：登录身份是 Casdoor 的 `sub`，在对方接受之前
   * 我们拿不到。邀请被接受时再把 `subject` 换成真实 sub（见 activateMembership），
   * 这样「待接受/已加入」都能在同一张表里看清楚，也不需要额外的邀请表。
   */
  async inviteMember(
    input: { tenantId: string; email: string; role: MemberRole; dataScope?: DataScope },
    ctx: KernelContext,
  ): Promise<Membership> {
    const email = input.email.trim().toLowerCase();
    try {
      return await this.db.transaction(async (tx) => {
        const rows = await tx
          .insert(memberships)
          .values({
            tenantId: input.tenantId,
            subject: email,
            email,
            role: input.role,
            dataScope: input.dataScope ?? "OWN",
            status: "INVITED",
          })
          .returning();
        const row = rows[0];
        if (!row) throw new KernelError("KERNEL_REJECTED", "邀请写入未返回记录");
        await appendAudit(
          tx,
          ctx,
          {
            action: "MEMBERSHIP_INVITED",
            entityType: "membership",
            entityId: row.id,
            after: { email, role: row.role },
          },
          row.tenantId,
        );
        return mapMembership(row);
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new KernelError(
          "KERNEL_REJECTED",
          `这个邮箱已经在公司里，或已有一条待接受的邀请：${email}`,
          {
            reason: "MEMBERSHIP_EXISTS",
          },
        );
      }
      throw error;
    }
  }

  /** 按邮箱找一条待接受的邀请。 */
  async findInvitedMembership(tenantId: string, email: string): Promise<Membership | null> {
    const rows = await this.db
      .select()
      .from(memberships)
      .where(
        and(
          eq(memberships.tenantId, tenantId),
          eq(memberships.subject, email.trim().toLowerCase()),
          eq(memberships.status, "INVITED"),
        ),
      )
      .limit(1);
    const row = rows[0];
    return row ? mapMembership(row) : null;
  }

  /** 按 membershipId 找一条成员行：邀请票据要拿它确认这条邀请仍然待接受。 */
  async findMembershipById(tenantId: string, membershipId: string): Promise<Membership | null> {
    const rows = await this.db
      .select()
      .from(memberships)
      .where(and(eq(memberships.id, membershipId), eq(memberships.tenantId, tenantId)))
      .limit(1);
    const row = rows[0];
    return row ? mapMembership(row) : null;
  }

  /** 接受邀请：把 INVITED 变成 ACTIVE，并把 subject 从邮箱换成真实登录身份。 */
  async activateMembership(
    membershipId: string,
    subject: string,
    casdoorOrg: string | null,
    ctx: KernelContext,
    profile?: { displayName?: string | null; email?: string | null },
  ): Promise<Membership> {
    return await this.db.transaction(async (tx) => {
      const before = await tx
        .select()
        .from(memberships)
        .where(eq(memberships.id, membershipId))
        .limit(1);
      const row = before[0];
      if (!row) throw new KernelError("RESOURCE_NOT_FOUND", "邀请不存在或已被撤销");
      if (row.status !== "INVITED")
        throw new KernelError("KERNEL_REJECTED", "这条邀请已经被接受了");

      const updated = await tx
        .update(memberships)
        .set({
          subject,
          casdoorOrg,
          status: "ACTIVE",
          // 邀请阶段只存了邮箱；接受时把 SSO 姓名补上，成员表与客户负责人从此有名字可显示。
          displayName: cleanProfileName(profile?.displayName) ?? row.displayName,
          email: normalizeEmail(profile?.email) ?? row.email,
          updatedAt: new Date(),
        })
        .where(and(eq(memberships.id, membershipId), eq(memberships.status, "INVITED")))
        .returning();
      const next = updated[0];
      if (!next) throw new KernelError("KERNEL_REJECTED", "这条邀请已经被接受了");

      await appendAudit(
        tx,
        ctx,
        {
          action: "MEMBERSHIP_ACTIVATED",
          entityType: "membership",
          entityId: next.id,
          before: { subject: row.subject, status: row.status },
          after: { subject: next.subject, status: next.status },
        },
        next.tenantId,
      );
      return mapMembership(next);
    });
  }

  /**
   * 用登录 claims 刷新成员的可展示姓名 / 邮箱。
   *
   * 为什么放在登录路径：Casdoor 是唯一持有姓名的系统，业务请求不能回调它；
   * 每次 `/api/auth/me` 顺带把 claims 落库，读取侧（客户负责人、成员表）才有非 UUID 的展示值。
   * 只在值真的变化时写，避免每次页面加载都产生一条 UPDATE。
   */
  async syncMemberProfile(
    subject: string,
    tenantId: string,
    profile: { displayName?: string | null; email?: string | null },
  ): Promise<void> {
    const displayName = cleanProfileName(profile.displayName);
    const email = normalizeEmail(profile.email);
    if (!displayName && !email) return;
    const rows = await this.db
      .select({ displayName: memberships.displayName, email: memberships.email })
      .from(memberships)
      .where(and(eq(memberships.subject, subject), eq(memberships.tenantId, tenantId)))
      .limit(1);
    const current = rows[0];
    if (!current) return;
    const nextDisplayName = displayName ?? current.displayName ?? null;
    const nextEmail = email ?? current.email ?? null;
    // 只在值真的变化时写：`/api/auth/me` 是每次页面加载都会走的路径。
    if (
      nextDisplayName === (current.displayName ?? null) &&
      nextEmail === (current.email ?? null)
    ) {
      return;
    }
    await this.db
      .update(memberships)
      .set({ displayName: nextDisplayName, email: nextEmail, updatedAt: new Date() })
      .where(and(eq(memberships.subject, subject), eq(memberships.tenantId, tenantId)));
  }
}
