import type { Metadata } from "next";
import type { BreakGlassRequest, SupportTicket, TenantSummary } from "@weave-order/schema";
import { date, statusClass } from "@/src/format";
import { platformFetch } from "@/src/server-api";
import { BreakGlassAccess, BreakGlassForm, TicketForm, TicketStatusSelect } from "@/src/actions";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "支持 / Break-glass" };

export default async function SupportPage({
  searchParams,
}: {
  searchParams: Promise<{ tenantId?: string }>;
}) {
  const params = await searchParams;
  const [{ tickets }, { requests }, { tenants }] = await Promise.all([
    platformFetch<{ tickets: SupportTicket[] }>("/support/tickets"),
    platformFetch<{ requests: BreakGlassRequest[] }>("/break-glass"),
    platformFetch<{ tenants: TenantSummary[] }>("/tenants"),
  ]);

  return (
    <>
      <div className="page-head">
        <div>
          <div className="crumbs">平台</div>
          <h1>支持 / Break-glass</h1>
          <p>没有租户同意时只能看账号/账单/用量；业务数据只读授权 ≤60 分钟，且双人复核。</p>
        </div>
      </div>

      <div className="grid cols-2">
        <div className="card">
          <div className="card-head">
            <div>
              <h2>工单</h2>
              <p>客服可开单并记录处理结论</p>
            </div>
          </div>
          <TicketForm tenants={tenants} defaultTenantId={params.tenantId} />
          <div className="divider" />
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>工单</th>
                  <th>租户</th>
                  <th>优先级</th>
                  <th>状态</th>
                  <th>更新</th>
                </tr>
              </thead>
              <tbody>
                {tickets.map((ticket) => (
                  <tr key={ticket.id}>
                    <td>
                      <strong>{ticket.title}</strong>
                      <div className="tiny muted">{ticket.body.slice(0, 80)}</div>
                    </td>
                    <td className="tiny">{ticket.tenantName}</td>
                    <td className="tiny">{ticket.priority}</td>
                    <td>
                      <span className={statusClass(ticket.status)}>{ticket.status}</span>
                    </td>
                    <td>
                      <TicketStatusSelect id={ticket.id} status={ticket.status} />
                      <div className="tiny muted">{date(ticket.updatedAt)}</div>
                    </td>
                  </tr>
                ))}
                {tickets.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="muted">
                      没有工单。
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </div>

        <div className="card">
          <div className="card-head">
            <div>
              <h2>Break-glass 申请</h2>
              <p>租户同意 + 双人复核后才能激活</p>
            </div>
          </div>
          <BreakGlassForm tenants={tenants} defaultTenantId={params.tenantId} />
          <div className="divider" />
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>租户 / 工单</th>
                  <th>状态</th>
                  <th>同意</th>
                  <th>有效期</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {requests.map((request) => (
                  <tr key={request.id}>
                    <td>
                      {request.tenantName}
                      <div className="tiny muted mono">{request.ticketNo}</div>
                      <div className="tiny muted">{request.reason.slice(0, 60)}</div>
                    </td>
                    <td>
                      <span className={statusClass(request.status)}>{request.status}</span>
                    </td>
                    <td className="tiny">{request.tenantConsent ? "已同意" : "未同意"}</td>
                    <td className="tiny">{date(request.expiresAt)}</td>
                    <td>
                      {request.status === "ACTIVE" ? (
                        <BreakGlassAccess id={request.id} />
                      ) : (
                        <span className="tiny muted">—</span>
                      )}
                    </td>
                  </tr>
                ))}
                {requests.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="muted">
                      没有申请。
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
          <div className="divider" />
          <div className="alert alert-info">
            控制面不持有业务数据。激活授权只产生「只读凭证 +
            审计」；任何业务单据读取都由租户侧执行并记入租户审计。
          </div>
        </div>
      </div>
    </>
  );
}
