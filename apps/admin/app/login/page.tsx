import Link from "next/link";

export const dynamic = "force-dynamic";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; next?: string }>;
}) {
  const params = await searchParams;
  const next = params.next ?? "/";
  const dev = process.env.NODE_ENV !== "production";

  return (
    <div className="login-page">
      <div className="login-card">
        <div className="card">
          <p className="tiny muted" style={{ letterSpacing: "0.18em", textTransform: "uppercase" }}>
            WeaveOrder Control Plane
          </p>
          <h1>平台总管理端</h1>
          <p className="sub">
            独立控制台。默认看不到租户业务数据；危险操作双人复核，所有平台动作独立审计。
          </p>

          {params.error ? <div className="alert alert-error">{params.error}</div> : null}

          <div style={{ marginTop: 16 }}>
            <a
              className="btn btn-primary"
              style={{ width: "100%" }}
              href={`/auth/login?next=${encodeURIComponent(next)}`}
            >
              使用 Casdoor 登录（weave-platform · 强制 MFA）
            </a>
          </div>

          {dev ? (
            <div style={{ marginTop: 18 }}>
              <p className="small muted" style={{ marginBottom: 8 }}>
                本地开发身份（生产环境不显示）：
              </p>
              <div className="identity-list">
                {[
                  ["owner", "平台 Owner", "全部权限"],
                  ["owner2", "平台 Owner（复核）", "危险操作第二人复核"],
                  ["finance", "平台财务", "账单 / 发票 / 改价复核"],
                  ["ops", "平台运维", "功能开关 / LLM / 配置"],
                  ["support", "平台客服", "只读 + 工单 + break-glass 申请"],
                  ["readonly", "只读", "全部只读"],
                ].map(([subject, label, role]) => (
                  <a
                    className="identity"
                    key={subject}
                    href={`/auth/dev?subject=${subject}&next=${encodeURIComponent(next)}`}
                  >
                    <span>{label}</span>
                    <span className="role">{role}</span>
                  </a>
                ))}
              </div>
            </div>
          ) : null}

          <p className="login-foot">
            平台管理员必须是 <span className="mono">platform_users</span>{" "}
            名册内成员。没有账号请联系平台 Owner。
          </p>
        </div>
        <p className="login-foot" style={{ textAlign: "center" }}>
          <Link href="/auth/logout">清除会话</Link>
        </p>
      </div>
    </div>
  );
}
