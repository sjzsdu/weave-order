import Link from "next/link";
import { safeNext } from "@/src/safe-next";

export const dynamic = "force-dynamic";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; next?: string }>;
}) {
  const params = await searchParams;
  const next = safeNext(params.next);
  const dev = process.env.NODE_ENV !== "production";

  return (
    <div className="login-page">
      <div className="login-card">
        <div className="card">
          <p className="tiny muted" style={{ letterSpacing: "0.18em", textTransform: "uppercase" }}>
            织序 · 内部管理
          </p>
          <h1>登录管理后台</h1>
          <p className="sub">
            这里只管理公司账号、套餐、账单与用量。客户的业务数据默认看不到；需要查看时，由客户同意并留痕。
          </p>

          {params.error ? <div className="alert alert-error">{params.error}</div> : null}

          <div style={{ marginTop: 16 }}>
            <a
              className="btn btn-primary"
              style={{ width: "100%" }}
              href={`/auth/login?next=${encodeURIComponent(next)}`}
            >
              使用管理员账号登录
            </a>
          </div>

          <p className="small muted" style={{ marginTop: 12 }}>
            管理员账号必须已开通两步验证。忘记密码请在统一登录页重置。
          </p>

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
            只有管理员名册内的账号才能进入。需要开通或调整权限，联系平台负责人。
          </p>
        </div>
        <p className="login-foot" style={{ textAlign: "center" }}>
          <Link href="/auth/logout">清除会话</Link>
        </p>
      </div>
    </div>
  );
}
