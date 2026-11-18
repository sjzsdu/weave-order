import type { Metadata } from "next";
import Link from "next/link";
import type { Overview } from "@weave-order/schema";
import { bps, money, percent, wan } from "@/src/format";
import { platformFetch } from "@/src/server-api";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "总览" };

export default async function OverviewPage() {
  const data = await platformFetch<Overview>("/overview");
  const maxFunnel = Math.max(1, ...data.trialFunnel.map((item) => item.count));

  return (
    <>
      <div className="page-head">
        <div>
          <div className="crumbs">控制面 · 只读聚合</div>
          <h1>总览</h1>
          <p>MRR / ARR、活跃租户、试用漏斗、毛利与待处置事项。这里不出现任何租户业务数据。</p>
        </div>
        <div className="btn-row">
          <Link className="btn" href="/tenants">
            租户目录
          </Link>
          <Link className="btn btn-primary" href="/tenants?provision=1">
            开通公司
          </Link>
        </div>
      </div>

      <div className="grid cols-4">
        <div className="stat">
          <div className="label">MRR</div>
          <div className="value">{wan(data.mrrCents)}</div>
          <div className="hint">标准套餐月费，企业合同价单列</div>
        </div>
        <div className="stat">
          <div className="label">ARR</div>
          <div className="value">{wan(data.arrCents)}</div>
          <div className="hint">MRR × 12</div>
        </div>
        <div className="stat">
          <div className="label">活跃租户 / 试用</div>
          <div className="value">
            {data.activeTenants}{" "}
            <span className="muted" style={{ fontSize: 16 }}>
              / {data.trialTenants}
            </span>
          </div>
          <div className="hint">
            试用转化 {percent(data.trialConversionRate)} · 近 30 天流失 {data.churnedLast30d}
          </div>
        </div>
        <div className="stat">
          <div className="label">毛利</div>
          <div className="value">{bps(data.grossMarginBps)}</div>
          <div className="hint">
            本月收入 {money(data.revenueCentsThisMonth)} · LLM 成本{" "}
            {money(data.llmCostCentsThisMonth)}
          </div>
        </div>
      </div>

      <div className="grid cols-2" style={{ marginTop: 16 }}>
        <div className="card">
          <div className="card-head">
            <div>
              <h2>试用漏斗</h2>
              <p>开通试用 → 转正式 → 30 天内流失</p>
            </div>
          </div>
          <div className="stack">
            {data.trialFunnel.map((item) => (
              <div className="bar-row" key={item.stage}>
                <span className="name">{item.stage}</span>
                <span className="bar">
                  <span style={{ width: `${Math.round((item.count / maxFunnel) * 100)}%` }} />
                </span>
                <span className="value">{item.count}</span>
              </div>
            ))}
          </div>
          <div className="divider" />
          <p className="small muted" style={{ margin: 0 }}>
            转化率按「已转正 /（已转正 + 已流失）」计算；试用中租户不计入分母，避免早期样本失真。
          </p>
        </div>

        <div className="card">
          <div className="card-head">
            <div>
              <h2>待处置</h2>
              <p>逾期账单、待复核与支持工单</p>
            </div>
          </div>
          <div className="grid cols-2">
            <div className="stat" style={{ padding: 14 }}>
              <div className="label">逾期/待收账单</div>
              <div className="value" style={{ fontSize: 22 }}>
                {data.overdueInvoices}
              </div>
              <div className="hint">
                <Link href="/billing">去账单</Link>
              </div>
            </div>
            <div className="stat" style={{ padding: 14 }}>
              <div className="label">待双人复核</div>
              <div className="value" style={{ fontSize: 22 }}>
                {data.pendingApprovals}
              </div>
              <div className="hint">
                <Link href="/approvals">去复核</Link>
              </div>
            </div>
            <div className="stat" style={{ padding: 14 }}>
              <div className="label">未关闭工单/事故</div>
              <div className="value" style={{ fontSize: 22 }}>
                {data.openIncidents}
              </div>
              <div className="hint">
                <Link href="/support">去支持</Link>
              </div>
            </div>
            <div className="stat" style={{ padding: 14 }}>
              <div className="label">LLM 成本本月</div>
              <div className="value" style={{ fontSize: 22 }}>
                {money(data.llmCostCentsThisMonth)}
              </div>
              <div className="hint">token 只计量不收费</div>
            </div>
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <div>
            <h2>隔离声明</h2>
            <p>控制面与租户业务库物理分离，这是产品信任的底线。</p>
          </div>
        </div>
        <div className="alert alert-info">
          控制台只连接 <span className="mono">PLATFORM_DATABASE_URL</span>（control
          schema），进程内不存在租户业务库连接。 需要查看业务单据时必须走 break-glass：租户同意 +
          双人复核 + ≤60 分钟只读 + 全程审计。
        </div>
      </div>
    </>
  );
}
