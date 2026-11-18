import type { Metadata } from "next";
import type { FeatureFlag } from "@weave-order/schema";
import { Time } from "@/src/time";
import { platformFetch } from "@/src/server-api";
import { FeatureFlagCreateForm, FeatureFlagRow } from "@/src/actions";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "设置 · 功能开关" };

export default async function FeatureFlagsPage() {
  const { flags } = await platformFetch<{ flags: FeatureFlag[] }>("/settings/feature-flags");
  const empty = flags.length === 0;
  return (
    <>
      <div className="page-head">
        <div>
          <div className="crumbs">平台</div>
          <h1>功能开关</h1>
          <p>按租户 / 批次灰度，一键回滚。功能开关不靠发版，服务端网关统一校验。</p>
        </div>
      </div>

      <FeatureFlagCreateForm defaultOpen={empty} />

      <div className="card">
        {empty ? (
          <div className="empty">
            <p style={{ margin: 0, fontWeight: 600 }}>还没有功能开关。</p>
            <p className="small muted" style={{ margin: "4px 0 12px" }}>
              创建第一个开关后，就能在这里调整灰度比例、指定租户，或一键回滚。
            </p>
            <a className="btn btn-sm btn-primary" href="#new-flag">
              创建第一个开关
            </a>
          </div>
        ) : (
          <>
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>开关</th>
                    <th>说明</th>
                    <th>灰度</th>
                    <th>指定租户</th>
                    <th>更新</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {flags.map((flag) => (
                    <FeatureFlagRow key={flag.key} flag={flag} />
                  ))}
                </tbody>
              </table>
            </div>
            <div className="divider" />
            <p className="small muted" style={{ margin: 0 }}>
              最近更新：
              {flags[0] ? (
                <>
                  {flags[0].key} · <Time value={flags[0].updatedAt} />
                </>
              ) : (
                "—"
              )}
              。灰度百分比与指定租户同时成立时取并集。
            </p>
          </>
        )}
      </div>
    </>
  );
}
