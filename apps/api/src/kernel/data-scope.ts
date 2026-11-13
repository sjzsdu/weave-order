import { memberships } from "@weave-order/db";
import type { Db } from "@weave-order/db";
import type { DataScope, Membership } from "@weave-order/schema";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import type { KernelContext } from "./audit";

/**
 * 应用层数据范围（OWN / TEAM / ALL）。
 *
 * 与 RLS 的分工：RLS 只挡跨租户，这里回答「同租户内同事之间能看到什么」。
 * 归属人统一是 `memberships.id`（业务表 `owner_id` 存的是成员 id，不是 Casdoor sub），
 * 因此网关注入的 `ctx.ownerId` 必须取自 membership.id。
 *
 * 只有 HUMAN 请求带范围；系统任务与智能体上下文不带 `dataScope`，
 * 内部读路径（报价计算、工具层）保持不受限，避免把权限判断塞进计价逻辑。
 */
export interface ScopeWindow {
  dataScope: DataScope;
  /** 当前成员 id；找不到归属人身份时为空。 */
  ownerId: string | null;
  /** 成员所属团队，TEAM 范围据此取同组负责人。 */
  teamId: string | null;
}

/** 从内核上下文取出可见范围；`null` 表示不受限。 */
export function scopeWindowOf(ctx?: KernelContext): ScopeWindow | null {
  if (!ctx?.dataScope) return null;
  return { dataScope: ctx.dataScope, ownerId: ctx.ownerId ?? null, teamId: ctx.teamId ?? null };
}

/**
 * 人类请求的数据范围来源：membership 是唯一事实。
 * `ownerId` 用 membership.id（业务表 owner_id 的取值域），不是 Casdoor sub。
 */
export function humanScopeOf(
  membership: Pick<Membership, "id" | "dataScope" | "teamId">,
): Pick<KernelContext, "dataScope" | "ownerId" | "teamId"> {
  return {
    dataScope: membership.dataScope,
    ownerId: membership.id,
    teamId: membership.teamId,
  };
}

/** 同租户同团队的成员 id 子查询。 */
function teamMemberIds(db: Db, tenantId: string, teamId: string) {
  return db
    .select({ id: memberships.id })
    .from(memberships)
    .where(and(eq(memberships.tenantId, tenantId), eq(memberships.teamId, teamId)));
}

/**
 * 统一的归属过滤条件，所有 `list` / `get` 都走这里。
 *
 * - `ALL` / 无上下文 → `undefined`（不加条件）
 * - `TEAM` → 负责人属于同组（没配团队时退化为本人，绝不放大）
 * - `OWN` → 负责人是本人；没有成员身份时恒假（fail-closed）
 */
export function ownerScopeFilter(
  db: Db,
  ctx: KernelContext | undefined,
  tenantId: string,
  ownerColumn: AnyPgColumn,
): SQL | undefined {
  const window = scopeWindowOf(ctx);
  if (!window || window.dataScope === "ALL") return undefined;
  if (window.dataScope === "TEAM" && window.teamId) {
    return inArray(ownerColumn, teamMemberIds(db, tenantId, window.teamId));
  }
  if (!window.ownerId) return sql`false`;
  return eq(ownerColumn, window.ownerId);
}

/**
 * 单条读取的可见性判定：越权一律当成不存在，避免用 403 枚举他人单据。
 * 返回 false 时调用方应抛 RESOURCE_NOT_FOUND / *_NOT_FOUND。
 */
export function isVisibleOwner(
  ctx: KernelContext | undefined,
  ownerId: string | null,
  teamMemberIds?: ReadonlySet<string> | null,
): boolean {
  const window = scopeWindowOf(ctx);
  if (!window || window.dataScope === "ALL") return true;
  if (!ownerId) return false;
  if (window.dataScope === "TEAM") {
    // 没有团队时退化为本人；有团队时需要调用方提供同组成员集合。
    if (!window.teamId) return ownerId === window.ownerId;
    return teamMemberIds ? teamMemberIds.has(ownerId) : ownerId === window.ownerId;
  }
  return ownerId === window.ownerId;
}
