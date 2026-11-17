import type { Metadata } from "next";
import Link from "next/link";
import type { ApprovalRequest } from "@weave-order/schema";
import { APPROVAL_ACTION_LABEL, APPROVAL_STATUS_LABEL, statusClass } from "@/src/format";
import { Time } from "@/src/time";
import { platformFetch } from "@/src/server-api";
import { ApprovalDecision } from "@/src/actions";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "待复核" };

export default async function ApprovalsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const params = await searchParams;
  const status = params.status ?? "PENDING";
  const [{ approvals }, actor] = await Promise.all([
    platformFetch<{ approvals: ApprovalRequest[] }>(
      `/approvals${status ? `?status=${status}` : ""}`,
    ),
    platformFetch<{ role: string; subject: string; permissions: string[] }>("/auth/me"),
  ]);

  return (
    <>
      <div className="page-head">
        <div>
          <div className="crumbs">经营</div>
          <h1>待复核</h1>
          <p>危险操作双人复核：发起人不能批准自己的申请；改价与改税需 owner + finance。</p>
        </div>
        <div className="btn-row">
          {["PENDING", "EXECUTED", "REJECTED", ""].map((value) => (
            <Link
              key={value || "all"}
              className={`btn btn-sm${status === value ? " btn-primary" : ""}`}
              href={`/approvals${value ? `?status=${value}` : ""}`}
            >
              {value ? APPROVAL_STATUS_LABEL[value] : "全部"}
            </Link>
          ))}
        </div>
      </div>

      <div className="card">
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>动作</th>
                <th>摘要</th>
                <th>发起人</th>
                <th>复核进度</th>
                <th>过期</th>
                <th>状态</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {approvals.map((approval) => {
                const votedRoles = new Set(approval.votes.map((vote) => vote.role));
                const isRequester = approval.requestedBy === actor.subject;
                const canDecide =
                  approval.status === "PENDING" &&
                  !isRequester &&
                  actor.permissions.includes("approval:decide");
                return (
                  <tr key={approval.id}>
                    <td>
                      <strong>{APPROVAL_ACTION_LABEL[approval.action] ?? approval.action}</strong>
                    </td>
                    <td>
                      {approval.summary}
                      <div className="tiny muted">{approval.reason}</div>
                      {approval.result ? (
                        <div className="tiny mono muted">
                          结果：{JSON.stringify(approval.result).slice(0, 160)}
                        </div>
                      ) : null}
                    </td>
                    <td className="tiny">
                      {approval.requestedByName}
                      <div className="muted mono">{approval.requestedBy}</div>
                    </td>
                    <td className="tiny">
                      {approval.requiredRoles.map((role) => (
                        <div key={role}>
                          {votedRoles.has(role) ? "✓" : "○"} {role}
                        </div>
                      ))}
                      <div className="muted">{approval.votes.length} 票</div>
                    </td>
                    <td className="tiny">
                      <Time value={approval.expiresAt} />
                    </td>
                    <td>
                      <span className={statusClass(approval.status)}>
                        {APPROVAL_STATUS_LABEL[approval.status]}
                      </span>
                    </td>
                    <td>
                      {canDecide ? (
                        <ApprovalDecision id={approval.id} />
                      ) : (
                        <span className="tiny muted">{isRequester ? "发起人不可自批" : "—"}</span>
                      )}
                    </td>
                  </tr>
                );
              })}
              {approvals.length === 0 ? (
                <tr>
                  <td colSpan={7} className="muted">
                    没有待复核申请。
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
