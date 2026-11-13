import type { FeatureFlag } from "@weave-order/schema";
import { date } from "@/src/format";
import { platformFetch } from "@/src/server-api";
import { FeatureFlagRow } from "@/src/actions";

export const dynamic = "force-dynamic";

export default async function FeatureFlagsPage() {
  const { flags } = await platformFetch<{ flags: FeatureFlag[] }>("/settings/feature-flags");
  return (
    <>
      <div className="page-head">
        <div>
          <div className="crumbs">平台</div>
          <h1>功能开关</h1>
          <p>按租户 / 批次灰度，一键回滚。功能开关不靠发版，服务端网关统一校验。</p>
        </div>
      </div>

      <div className="card">
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
              {flags.length === 0 ? (
                <tr>
                  <td colSpan={6} className="muted">
                    还没有功能开关。
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
        <div className="divider" />
        <p className="small muted" style={{ margin: 0 }}>
          最近更新：{flags[0] ? `${flags[0].key} · ${date(flags[0].updatedAt)}` : "—"}
          。灰度百分比与指定租户同时成立时取并集。
        </p>
      </div>
    </>
  );
}
