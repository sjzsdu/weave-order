import type { PricingContext } from "@weave-order/schema";
import { hasCapability } from "@weave-order/schema";
import type { KernelContext } from "./audit";
import { KernelError } from "./errors";

export interface PricingQueryScope {
  customerId?: string;
  teamId?: string;
  categoryId?: string;
  personId?: string;
}

/**
 * 收紧 `GET /api/policies/resolve` 的作用域参数。
 *
 * 原有实现把 `personId` / `teamId` 全部取自 query，任何成员都能探测他人的
 * 个人限额与团队策略。这里以登录成员身份为准：
 * - `teamId` 只来自成员归属，忽略 query（团队是人的属性，不是查询参数）；
 * - `personId` 只能是本人，除非角色具备跨人查看能力（OWNER / MANAGER）；
 * - 业务员不传 `personId` 时默认解析自己的个人档位，而不是把 PERSON 层整体跳过；
 * - 无数据范围上下文（本地演示 / 系统内部）保持原行为，避免打断既有调用。
 */
export function narrowPricingContext(
  query: PricingQueryScope,
  ctx?: KernelContext,
): PricingContext {
  if (!ctx?.dataScope) {
    return {
      ...(query.customerId ? { customerId: query.customerId } : {}),
      ...(query.teamId ? { teamId: query.teamId } : {}),
      ...(query.categoryId ? { categoryId: query.categoryId } : {}),
      ...(query.personId ? { personId: query.personId } : {}),
    };
  }

  const self = ctx.ownerId ?? null;
  const role = ctx.actor.role;
  // 能否替他人解析个人定价 / 审批额度：能力表 `pricing.cross_person.read`。
  const mayCrossPerson = role !== undefined && hasCapability(role, "pricing.cross_person.read");

  let personId: string | undefined;
  if (query.personId) {
    if (query.personId !== self && !mayCrossPerson) {
      throw new KernelError("PERMISSION_DENIED", "无权查看他人的个人定价与审批额度");
    }
    personId = query.personId;
  } else if (self && !mayCrossPerson) {
    personId = self;
  }

  // 客户 / 品类是业务对象，可以显式指定；团队取成员归属，不接受 query 指定。
  return {
    ...(query.customerId ? { customerId: query.customerId } : {}),
    ...(ctx.teamId ? { teamId: ctx.teamId } : {}),
    ...(query.categoryId ? { categoryId: query.categoryId } : {}),
    ...(personId ? { personId } : {}),
  };
}
