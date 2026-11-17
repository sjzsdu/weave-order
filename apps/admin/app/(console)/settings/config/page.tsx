import type { Metadata } from "next";
import type { PlatformConfig } from "@weave-order/schema";
import { Time } from "@/src/time";
import { platformFetch } from "@/src/server-api";
import { ConfigForm, ConfigRollback } from "@/src/actions";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "设置 · 配置中心" };

export default async function ConfigPage() {
  const { configs } = await platformFetch<{ configs: PlatformConfig[] }>("/settings/configs");
  const histories = await Promise.all(
    configs.map((config) =>
      platformFetch<{ versions: PlatformConfig[] }>(
        `/settings/configs/history?key=${encodeURIComponent(config.key)}`,
      ).then((result) => result.versions),
    ),
  );

  return (
    <>
      <div className="page-head">
        <div>
          <div className="crumbs">平台</div>
          <h1>配置中心</h1>
          <p>
            作用域只有「全局 → 套餐 → 租户」三层，不做用户级平台配置；版本化 + 影响预览 + 回滚。
          </p>
        </div>
      </div>

      <div className="grid cols-2">
        <div className="card">
          <div className="card-head">
            <div>
              <h2>当前生效配置</h2>
              <p>{configs.length} 项</p>
            </div>
          </div>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Key</th>
                  <th>作用域</th>
                  <th>版本</th>
                  <th>值</th>
                  <th>更新</th>
                </tr>
              </thead>
              <tbody>
                {configs.map((config) => (
                  <tr key={config.id}>
                    <td className="mono">{config.key}</td>
                    <td className="tiny">
                      {config.scope}
                      {config.scopeRef ? ` · ${config.scopeRef}` : ""}
                    </td>
                    <td className="num">v{config.version}</td>
                    <td className="tiny mono" style={{ maxWidth: 260 }}>
                      {JSON.stringify(config.value).slice(0, 160)}
                    </td>
                    <td className="tiny">
                      <Time value={config.createdAt} />
                    </td>
                  </tr>
                ))}
                {configs.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="muted">
                      还没有配置项。
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
              <h2>发布新版本</h2>
              <p>发布前可预览影响租户数</p>
            </div>
          </div>
          <ConfigForm />
        </div>
      </div>

      {configs.map((config, index) => {
        const versions = histories[index] ?? [];
        return (
          <div className="card" key={config.key}>
            <div className="card-head">
              <div>
                <h2 className="mono">{config.key}</h2>
                <p>{versions.length} 个历史版本</p>
              </div>
            </div>
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>版本</th>
                    <th>状态</th>
                    <th>值</th>
                    <th>创建</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {versions.slice(0, 5).map((version) => (
                    <tr key={version.id}>
                      <td className="num">v{version.version}</td>
                      <td className="tiny">{version.status}</td>
                      <td className="tiny mono" style={{ maxWidth: 420 }}>
                        {JSON.stringify(version.value).slice(0, 200)}
                      </td>
                      <td className="tiny">
                        <Time value={version.createdAt} />
                      </td>
                      <td>
                        {version.status === "SUPERSEDED" ? (
                          <ConfigRollback id={version.id} />
                        ) : (
                          <span className="tiny muted">当前</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        );
      })}
    </>
  );
}
