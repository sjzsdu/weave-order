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
 * 范围取决于「谁在驱动这次调用」，而不取决于调用方是不是人类：
 * - HUMAN 路由由 membership 注入（`humanScopeOf`）；
 * - 智能体（`/api/tools/*`、`/api/agents/quote`）带的是**驱动者**的范围——
 *   它只是执行体，不能替调用者放大可见客户。写路径因此必须把 `ctx` 传进
 *   `customers.getById` / 单据 `getById`，漏传一次就是一个租户内越权；
 * - 只有确实没有人在驱动时（系统任务、本地匿名演示）才不带 `dataScope` = 不受限。
 * 计价解析不吃数据范围：权限判断收在入口的归属校验上，不塞进计价逻辑。
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

/**
 * 写入路径的归属判定。与 isVisibleOwner 同一套规则，
 * 只是 TEAM 范围要一次成员查询（写入前已经拿到单据，不需要在同一条 SQL 里过滤）。
 * `false` 时调用方应按「不存在」返回，避免用 403 枚举他人单据。
 */
export async function isOwnerInScope(
  db: Db,
  ctx: KernelContext | undefined,
  tenantId: string,
  ownerId: string | null,
): Promise<boolean> {
  const window = scopeWindowOf(ctx);
  if (!window || window.dataScope === "ALL") return true;
  if (!ownerId) return false;
  if (window.dataScope === "TEAM" && window.teamId) {
    if (ownerId === window.ownerId) return true;
    const teamMembers = await db
      .select({ id: memberships.id })
      .from(memberships)
      .where(and(eq(memberships.tenantId, tenantId), eq(memberships.teamId, window.teamId)));
    return teamMembers.some((member) => member.id === ownerId);
  }
  return ownerId === window.ownerId;
}
