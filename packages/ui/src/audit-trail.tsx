import { ACTOR_TYPE_LABEL, auditActionLabel } from "@weave-order/schema";
import type { AuditLogEntry } from "@weave-order/schema";

/** 审计只追加：这里只读展示，不提供任何编辑入口。 */
export function AuditTrail({ entries, limit = 6 }: { entries: AuditLogEntry[]; limit?: number }) {
  const visible = entries.slice(0, limit);
  if (visible.length === 0) {
    return <p className="text-sm text-ink-400">还没有审计记录。</p>;
  }
  return (
    <ol className="space-y-2">
      {visible.map((entry) => (
        <li key={entry.id} className="flex items-start gap-3 text-[13px]">
          <span className="mt-1 text-moss-600" aria-hidden>
            ✓
          </span>
          <div className="min-w-0">
            <div className="truncate text-ink-700">{auditActionLabel(entry.action)}</div>
            <div className="text-xs text-ink-400">
              {ACTOR_TYPE_LABEL[entry.actorType]} ·{" "}
              {new Date(entry.createdAt).toLocaleString("zh-CN")}
            </div>
          </div>
        </li>
      ))}
    </ol>
  );
}
