import type { JsonValue } from "@weave-order/schema";
import {
  auditFieldLabel,
  diffAuditSnapshots,
  formatAuditValue,
  AUDIT_MASKED_PRICE,
} from "@weave-order/schema";

/**
 * 字段级差异表（WAN-179）。
 *
 * 审计页与后续审批卡共用这一份：只渲染「改了哪个字段、从什么到什么」，
 * 不把 before/after 的原始 JSON 直接倒给用户。被服务端裁剪的金额显示
 * 统一占位文案，前端不再判断角色。
 */
export function AuditDiff({
  before,
  after,
  maskedFields = [],
}: {
  before: JsonValue | null;
  after: JsonValue | null;
  maskedFields?: string[];
}) {
  const diffs = diffAuditSnapshots(before, after);
  if (diffs.length === 0) {
    return <p className="text-xs text-ink-400">这次操作没有字段级变更。</p>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[420px] text-xs">
        <thead className="text-left text-ink-400">
          <tr>
            <th className="py-1 pr-4 font-normal">字段</th>
            <th className="py-1 pr-4 font-normal">修改前</th>
            <th className="py-1 font-normal">修改后</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {diffs.map((diff) => {
            const masked = maskedFields.some(
              (field) => field === diff.field || field.startsWith(`${diff.field}.`),
            );
            return (
              <tr key={diff.field}>
                <td className="py-1.5 pr-4 text-ink-500">{auditFieldLabel(diff.field)}</td>
                <td className="py-1.5 pr-4 text-ink-700">
                  {masked ? AUDIT_MASKED_PRICE : formatAuditValue(diff.before)}
                </td>
                <td className="py-1.5 text-ink-900">
                  {masked ? AUDIT_MASKED_PRICE : formatAuditValue(diff.after)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
