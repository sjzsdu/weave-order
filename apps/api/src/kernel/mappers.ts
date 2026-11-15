import type { Currency, MemberRole, Timestamp } from "@weave-order/schema";
import { hasCapability } from "@weave-order/schema";

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
 * 成本底线 / 毛利类字段的可见性（产品矩阵：sales 不可见）。
 * 规则本身在 `@weave-order/schema` 的 `sample.cost.view`，这里只保留调用形状。
 *
 * 无角色（系统任务 / 智能体内核路径）视为可见，保证计价逻辑拿得到底线；
 * 角色裁剪只发生在面向人的读模型上，不进入内核计算。
 *
 * 注意：样品写角色（OWNER / MANAGER / SAMPLE_ADMIN）必须都能看成本。
 * 「可写但不可读」会让编辑器把裁剪后的 null 回写，静默清空成本底线，
 * 该样品随后会被报价内核拒绝（`requireSampleCostFloor`）。SAMPLE_ADMIN
 * 的职责就是维护样品成本，看不到反而不合理。
 */
export function mayViewCost(role?: MemberRole): boolean {
  if (!role) return true;
  return hasCapability(role, "sample.cost.view");
}
