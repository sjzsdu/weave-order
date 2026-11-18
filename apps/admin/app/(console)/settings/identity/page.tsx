import type { Metadata } from "next";
import type { PlatformIdentitySettings } from "@weave-order/schema";
import { date } from "@/src/format";
import { platformFetch } from "@/src/server-api";
import { IdentitySettingsForm } from "@/src/actions";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "设置 · 身份" };

interface IdentityPayload {
  settings: PlatformIdentitySettings;
  organizations: { tenantId: string; tenantName: string; slug: string; casdoorOrg: string }[];
}

export default async function IdentityPage() {
  const data = await platformFetch<IdentityPayload>("/settings/identity");
  return (
    <>
      <div className="page-head">
        <div>
          <div className="crumbs">平台</div>
          <h1>身份</h1>
          <p>
            独立 Casdoor 应用 weave-platform：强制 MFA、禁止社交登录；一个租户一个 Organization。
          </p>
        </div>
        <div className="muted small">更新于 {date(data.settings.updatedAt)}</div>
      </div>

      <div className="grid cols-2">
        <div className="card">
          <div className="card-head">
            <div>
              <h2>登录策略</h2>
              <p>服务端令牌校验同样强制 MFA 声明</p>
            </div>
          </div>
          <IdentitySettingsForm settings={data.settings} />
        </div>
        <div className="card">
          <div className="card-head">
            <div>
              <h2>Casdoor 组织</h2>
              <p>按模板为每个租户创建 Organization</p>
            </div>
          </div>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>租户</th>
                  <th>Casdoor Organization</th>
                </tr>
              </thead>
              <tbody>
                {data.organizations.map((org) => (
                  <tr key={org.tenantId}>
                    <td>
                      {org.tenantName}
                      <div className="tiny muted mono">{org.slug}</div>
                    </td>
                    <td className="mono">{org.casdoorOrg}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="divider" />
          <div className="alert alert-info">
            平台账号必须先由 Owner 写入 <span className="mono">platform_users</span> 名册；仅有
            Casdoor 令牌不足以进入控制台。
          </div>
        </div>
      </div>
    </>
  );
}
