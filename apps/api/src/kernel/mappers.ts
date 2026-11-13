import type { Currency, MemberRole, Timestamp } from "@weave-order/schema";

export function toIso(date: Date): Timestamp {
  return date.toISOString();
}

export function toIsoOrNull(date: Date | null): Timestamp | null {
  return date ? toIso(date) : null;
}

export function currencyOf(value: string): Currency {
  // 数据库枚举与契约枚举同步（边界测试会校验），这里仅做类型收窄。
  return value as Currency;
}

/**
 * 成本底线 / 毛利类字段的可见角色白名单（产品矩阵：sales 不可见）。
 * 无角色（系统任务 / 智能体内核路径）视为可见，保证计价逻辑拿得到底线；
 * 角色裁剪只发生在面向人的读模型上，不进入内核计算。
 */
const COST_VISIBLE_ROLES: ReadonlySet<MemberRole> = new Set(["OWNER", "MANAGER", "FINANCE"]);

export function mayViewCost(role?: MemberRole): boolean {
  if (!role) return true;
  return COST_VISIBLE_ROLES.has(role);
}
