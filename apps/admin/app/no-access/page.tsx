import type { Metadata } from "next";
import Link from "next/link";
import { LogoutForm } from "@/src/logout-form";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "无访问权限" };

/**
 * 会话有效、但当前账号没有平台控制台权限时落这里。
 *
 * 这是「无权限」，不是「会话失效」，所以绝不自动清 cookie、绝不自动登出。
 * 典型原因：账号不在 control.platform_users 名册、名册状态非 ACTIVE、
 * 平台强制 MFA 但名册未标记 mfa_enforced。需要平台 owner 处理名册，
 * 而不是让用户反复重新登录（重新登录多少次都不会改变名册结论）。
 */
export default async function NoAccessPage({
  searchParams,
}: {
  searchParams: Promise<{ reason?: string }>;
}) {
  const { reason } = await searchParams;

  return (
    <div className="login-page">
      <div className="login-card">
        <div className="card">
          <p className="tiny muted" style={{ letterSpacing: "0.18em", textTransform: "uppercase" }}>
            织序 · 内部管理
          </p>
          <h1>账号暂无管理权限</h1>
          <p className="sub">
            你的登录身份是有效的，但还没有开通平台总后台的访问权限。这不是登录问题——
            重新登录不会改变结果，请先联系平台管理员开通。
          </p>

          <div className="alert alert-warn" style={{ marginTop: 12 }}>
            常见原因：账号不在平台人员名册、名册被停用，或平台要求的两步验证尚未在名册中登记。
            请联系平台 owner 核对 <span className="mono">control.platform_users</span>{" "}
            中本账号的状态。
          </div>

          {reason ? (
            <p className="small muted" style={{ marginTop: 12 }}>
              控制面返回：<span className="mono">{reason}</span>
            </p>
          ) : null}

          <div className="btn-row" style={{ marginTop: 16 }}>
            <LogoutForm buttonClassName="btn btn-primary">改用其他管理员账号</LogoutForm>
            <Link className="btn" href="/">
              返回
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
