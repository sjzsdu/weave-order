import { and, eq, lt, or } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";

/**
 * 审批队列底层列表的读取选项。
 *
 * 分页必须发生在数据库里：先按数据范围过滤、再按排序键翻页，最后才
 * 在应用层把报价与寄样合并。反过来（先取前 N 条再过滤）会随数据量增长
 * 把第 N+1 条起真正待审的单据永久藏起来。
 */
export interface ApprovalListQuery {
  /** 只取 pending（DRAFT）单据，避免「取前 N 条再过滤」。 */
  pendingOnly?: boolean;
  /** 按 id 精确取一条，用于审批卡详情，不受分页影响。 */
  id?: string;
  /** 上一页最后一条的排序键；null / 缺省表示第一页。 */
  after?: { createdAt: string; id: string } | null;
}

/**
 * 队列的 WHERE 追加条件：DRAFT / 单条 / keyset 翻页。
 *
 * 顺序与 SQL 语义无关，但必须与 ownerScopeFilter 一起放进同一个 WHERE，
 * 才能保证「先过滤再分页」。
 */
export function approvalListConditions(
  createdAtColumn: AnyPgColumn,
  idColumn: AnyPgColumn,
  query: ApprovalListQuery,
): SQL[] {
  const conditions: SQL[] = [];
  if (query.id) conditions.push(eq(idColumn, query.id));
  if (query.after) {
    const at = new Date(query.after.createdAt);
    conditions.push(
      or(lt(createdAtColumn, at), and(eq(createdAtColumn, at), lt(idColumn, query.after.id)))!,
    );
  }
  return conditions;
}
