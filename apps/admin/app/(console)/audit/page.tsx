import type { PlatformAuditEntry } from "@weave-order/schema";
import { date } from "@/src/format";
import { platformFetch } from "@/src/server-api";

export const dynamic = "force-dynamic";

export default async function AuditPage({
  searchParams,
}: {
  searchParams: Promise<{ action?: string }>;
}) {
  const params = await searchParams;
  const query = params.action ? `?action=${encodeURIComponent(params.action)}` : "";
  const { entries } = await platformFetch<{ entries: PlatformAuditEntry[] }>(`/audit${query}`);

  return (
    <>
      <div className="page-head">
        <div>
          <div className="crumbs">平台</div>
          <h1>平台审计</h1>
          <p>与租户审计完全分开；只追加，数据库触发器拒绝 UPDATE / DELETE。</p>
        </div>
      </div>

      <div className="card">
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>时间</th>
                <th>动作</th>
                <th>操作人</th>
                <th>对象</th>
                <th>变更</th>
                <th>原因</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <tr key={entry.id}>
                  <td className="tiny nowrap">{date(entry.createdAt)}</td>
                  <td className="mono">{entry.action}</td>
                  <td className="tiny">
                    {entry.actorName}
                    <div className="muted">{entry.actorRole}</div>
                  </td>
                  <td className="tiny">
                    {entry.targetType}
                    <div className="muted mono">{entry.targetId ?? "—"}</div>
                  </td>
                  <td className="tiny" style={{ maxWidth: 380 }}>
                    {entry.before ? (
                      <div className="muted mono">
                        - {JSON.stringify(entry.before).slice(0, 140)}
                      </div>
                    ) : null}
                    {entry.after ? (
                      <div className="mono">+ {JSON.stringify(entry.after).slice(0, 140)}</div>
                    ) : null}
                  </td>
                  <td className="tiny">{entry.reason ?? "—"}</td>
                </tr>
              ))}
              {entries.length === 0 ? (
                <tr>
                  <td colSpan={6} className="muted">
                    还没有平台审计记录。
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
