import Link from "next/link";
import type { UsageOverview } from "@weave-order/schema";
import { money } from "@/src/format";
import { platformFetch } from "@/src/server-api";

export const dynamic = "force-dynamic";

export default async function UsagePage() {
  const data = await platformFetch<UsageOverview>("/usage/overview");
  const maxActions = Math.max(1, ...data.topConsumers.map((item) => item.agentActions));

  return (
    <>
      <div className="page-head">
        <div>
          <div className="crumbs">经营</div>
          <h1>用量</h1>
          <p>agent 动作、存储、短信与 LLM token。token 只核算成本，不进账单金额。</p>
        </div>
        <div className="muted small">当前周期 {data.period}</div>
      </div>

      <div className="grid cols-4">
        <div className="stat">
          <div className="label">agent 动作</div>
          <div className="value">{data.totalAgentActions.toLocaleString()}</div>
          <div className="hint">计费项，超出额度按 ¥0.05 / 次</div>
        </div>
        <div className="stat">
          <div className="label">存储</div>
          <div className="value">
            {data.totalStorageGb.toFixed(1)} <span style={{ fontSize: 15 }}>GB</span>
          </div>
          <div className="hint">超额才收费</div>
        </div>
        <div className="stat">
          <div className="label">短信</div>
          <div className="value">{data.totalSms.toLocaleString()}</div>
          <div className="hint">成本价计量</div>
        </div>
        <div className="stat">
          <div className="label">LLM token 成本</div>
          <div className="value">{money(data.totalLlmCostCents)}</div>
          <div className="hint">{(data.totalLlmTokens / 1000).toFixed(1)}K tokens · 不收费</div>
        </div>
      </div>

      <div className="grid cols-2" style={{ marginTop: 16 }}>
        <div className="card">
          <div className="card-head">
            <div>
              <h2>Top 消耗</h2>
              <p>按 agent 动作排序</p>
            </div>
          </div>
          <div className="stack">
            {data.topConsumers.map((tenant) => (
              <div className="bar-row" key={tenant.tenantId}>
                <Link className="name" href={`/tenants/${tenant.tenantId}`}>
                  {tenant.tenantName}
                </Link>
                <span className="bar">
                  <span
                    style={{ width: `${Math.round((tenant.agentActions / maxActions) * 100)}%` }}
                  />
                </span>
                <span className="value">{tenant.agentActions.toLocaleString()}</span>
              </div>
            ))}
            {data.topConsumers.length === 0 ? <p className="muted small">暂无用量。</p> : null}
          </div>
        </div>

        <div className="card">
          <div className="card-head">
            <div>
              <h2>异常</h2>
              <p>超额或异常增长，供客户成功介入</p>
            </div>
          </div>
          {data.anomalies.length === 0 ? (
            <div className="alert alert-ok">没有检测到用量异常。</div>
          ) : (
            <div className="stack">
              {data.anomalies.map((item, index) => (
                <div className="alert alert-warn" key={`${item.tenantId}-${index}`}>
                  <Link href={`/tenants/${item.tenantId}`}>{item.tenantName}</Link>：{item.message}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
