import type { Metadata } from "next";
import Link from "next/link";
import type { Plan, TenantSummary } from "@weave-order/schema";
import { TENANT_STATUS_LABEL, money, statusClass } from "@/src/format";
import { Time } from "@/src/time";
import { platformFetch } from "@/src/server-api";
import { ProvisionTenantDialog } from "@/src/actions";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "租户" };

const STATUSES = ["", "TRIAL", "ACTIVE", "OVERDUE", "SUSPENDED", "CANCELLED"];

export default async function TenantsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; status?: string; plan?: string; provision?: string }>;
}) {
  const params = await searchParams;
  const query = new URLSearchParams();
  if (params.q) query.set("q", params.q);
  if (params.status) query.set("status", params.status);
  if (params.plan) query.set("plan", params.plan);
  const [{ tenants }, { plans }] = await Promise.all([
    platformFetch<{ tenants: TenantSummary[] }>(`/tenants?${query.toString()}`),
    platformFetch<{ plans: Plan[] }>("/pricing/plans"),
  ]);

  return (
    <>
      <div className="page-head">
        <div>
          <div className="crumbs">经营</div>
          <h1>租户</h1>
          <p>账号级信息：套餐、席位、用量、健康度、隔离模式与 LLM 覆盖。</p>
        </div>
        <ProvisionTenantDialog plans={plans} defaultOpen={params.provision === "1"} />
      </div>

      {plans.length === 0 ? (
        <p className="alert alert-info" style={{ marginBottom: 16 }}>
          尚未配置任何套餐，暂时无法开通租户。请先到 <Link href="/pricing">套餐与价格</Link>{" "}
          新建套餐。
        </p>
      ) : null}

      <div className="card">
        <div className="card-head tenant-list-head">
          <div>
            <h2>租户目录</h2>
            <p>当前显示 {tenants.length} 家租户</p>
          </div>
        </div>
        <form key={query.toString()} className="inline-form tenant-filter" method="get">
          <div className="field">
            <label htmlFor="q">搜索</label>
            <input id="q" name="q" defaultValue={params.q ?? ""} placeholder="公司名 / slug" />
          </div>
          <div className="field">
            <label htmlFor="status">状态</label>
            <select id="status" name="status" defaultValue={params.status ?? ""}>
              {STATUSES.map((status) => (
                <option key={status} value={status}>
                  {status ? TENANT_STATUS_LABEL[status] : "全部"}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="plan">套餐</label>
            <select id="plan" name="plan" defaultValue={params.plan ?? ""}>
              <option value="">全部</option>
              {plans.map((plan) => (
                <option key={plan.code} value={plan.code}>
                  {plan.name}
                </option>
              ))}
            </select>
          </div>
          <div className="btn-row">
            <button className="btn" type="submit">
              筛选
            </button>
            <Link className="btn btn-ghost" href="/tenants">
              重置
            </Link>
          </div>
        </form>

        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>公司</th>
                <th>状态</th>
                <th>套餐 / 席位</th>
                <th className="num">月费</th>
                <th>本月 agent 动作</th>
                <th>隔离</th>
                <th>下次扣费</th>
                <th>健康度</th>
              </tr>
            </thead>
            <tbody>
              {tenants.map((tenant) => {
                const ratio =
                  tenant.agentActionsQuota > 0
                    ? tenant.agentActionsUsed / tenant.agentActionsQuota
                    : 0;
                return (
                  <tr key={tenant.id}>
                    <td>
                      <Link href={`/tenants/${tenant.id}`}>
                        <strong>{tenant.name}</strong>
                      </Link>
                      <div className="tiny muted mono">
                        {tenant.slug} · {tenant.region}
                      </div>
                    </td>
                    <td>
                      <span className={statusClass(tenant.status)}>
                        {TENANT_STATUS_LABEL[tenant.status] ?? tenant.status}
                      </span>
                    </td>
                    <td>
                      {tenant.planCode ?? "—"} · {tenant.seats} 席
                      <div className="tiny muted">
                        {tenant.billingCycle === "ANNUAL" ? "年付" : "月付"}
                      </div>
                    </td>
                    <td className="num">{money(tenant.effectiveMonthlyCents)}</td>
                    <td>
                      <div className="tiny">
                        {tenant.agentActionsUsed.toLocaleString()} /{" "}
                        {tenant.agentActionsQuota.toLocaleString()}
                      </div>
                      <div
                        className={`meter${ratio >= 1 ? " danger" : ratio >= 0.8 ? " warn" : ""}`}
                        style={{ marginTop: 4, width: 110 }}
                      >
                        <span style={{ width: `${Math.min(100, Math.round(ratio * 100))}%` }} />
                      </div>
                    </td>
                    <td className="tiny">
                      {tenant.isolationMode === "SHARED_RLS"
                        ? "共享 RLS"
                        : tenant.isolationMode === "SCHEMA"
                          ? "独立 schema"
                          : "独立库"}
                    </td>
                    <td className="tiny nowrap">
                      <Time value={tenant.nextDueAt} mode="day" />
                    </td>
                    <td className="num">{tenant.healthScore}</td>
                  </tr>
                );
              })}
              {tenants.length === 0 ? (
                <tr>
                  <td colSpan={8} className="empty">
                    <div>没有匹配的租户</div>
                    <div className="tiny muted">可重置筛选条件，或点击右上角「开通公司」。</div>
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
