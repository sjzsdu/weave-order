import type { CodeEntityType } from "@weave-order/schema";
import { uniqueViolationConstraint } from "./errors";

/**
 * 各实体的编号唯一索引约束名。只有命中这些冲突才允许重算编号；
 * 草稿幂等键（customers/samples_tenant_draft_source_idx）、主图唯一等
 * 其他唯一约束必须原样冒泡，绝不能被当成撞码吞掉。
 */
export const CODE_CONFLICT_CONSTRAINTS: Readonly<Record<CodeEntityType, string>> = {
  customer: "customers_tenant_code_idx",
  sample: "samples_tenant_code_idx",
  quote: "quotes_tenant_code_idx",
  order: "orders_tenant_code_idx",
  sample_shipment: "sample_shipments_tenant_code_idx",
};

/** 该异常是否为「本实体的编号撞码」（否则应原样冒泡给调用方）。 */
export function isCodeConflict(error: unknown, entityType: CodeEntityType): boolean {
  const constraint = uniqueViolationConstraint(error);
  return constraint === CODE_CONFLICT_CONSTRAINTS[entityType];
}
