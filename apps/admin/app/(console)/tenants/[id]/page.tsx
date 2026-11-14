import Link from "next/link";
import { notFound } from "next/navigation";
import type { Invoice, Plan, TenantDetail } from "@weave-order/schema";
import {
  APPROVAL_STATUS_LABEL,
  INVOICE_STATUS_LABEL,
  TENANT_STATUS_LABEL,
  date,
  day,
  money,
  statusClass,
} from "@/src/format";
import { PlatformApiError, platformFetch } from "@/src/server-api";
import { OnboardingLinkPanel, SubscriptionForm, TenantStatusActions } from "@/src/actions";

export const dynamic = "force-dynamic";

export default async function TenantDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let detail: TenantDetail;
  try {
    detail = await platformFetch<TenantDetail>(`/tenants/${id}`);
  } catch (error) {
    if (error instanceof PlatformApiError && error.status === 404) notFound();
    throw error;
  }
  const [{ plans }, { invoices }] = await Promise.all([
    platformFetch<{ plans: Plan[] }>("/pricing/plans"),
    platformFetch<{ invoices: Invoice[] }>(`/invoices?tenantId=${id}`),
  ]);

  const tenant = detail.tenant;
  const usage = detail.usage;
  const maxActions = Math.max(1, ...usage.map((item) => item.agentActions));
  const last14 = usage.slice(-14);
  const quotaRatio =
    tenant.agentActionsQuota > 0 ? tenant.agentActionsUsed / tenant.agentActionsQuota : 0;

  return (
    <>
      <div className="page-head">
        <div>
          <div className="crumbs">
            <Link href="/tenants">租户</Link> / {tenant.name}
          </div>
          <h1>{tenant.name}</h1>
          <p>
            <span className="mono">{tenant.slug}</span> · {tenant.region} ·{" "}
            <span className={statusClass(tenant.status)}>{TENANT_STATUS_LABEL[tenant.status]}</span>
          </p>
        </div>
        <div className="btn-row">
          <Link className="btn" href={`/billing?tenantId=${id}`}>
            账单
          </Link>
          <Link className="btn" href={`/support?tenantId=${id}`}>
            开工单
          </Link>
        </div>
      </div>

      <OnboardingLinkPanel tenantId={id} ownerEmail={detail.contactEmail ?? null} />

      <div className="grid cols-4">
        <div className="stat">
          <div className="label">月费（含席位）</div>
          <div className="value">{money(tenant.effectiveMonthlyCents)}</div>
          <div className="hint">
            {tenant.planCode ?? "无套餐"} × {tenant.seats} 席 ·{" "}
            {tenant.billingCycle === "ANNUAL" ? "年付" : "月付"}
          </div>
        </div>
        <div className="stat">
          <div className="label">本月 agent 动作</div>
          <div className="value">{tenant.agentActionsUsed.toLocaleString()}</div>
          <div className="hint">
            额度 {tenant.agentActionsQuota.toLocaleString()} · 使用 {Math.round(quotaRatio * 100)}%
          </div>
        </div>
        <div className="stat">
          <div className="label">健康度</div>
          <div className="value">{tenant.healthScore}</div>
          <div className="hint">按用量/逾期/暂停状态综合</div>
        </div>
        <div className="stat">
          <div className="label">下次扣费</div>
          <div className="value" style={{ fontSize: 20 }}>
            {day(tenant.nextDueAt)}
          </div>
          <div className="hint">开通于 {day(tenant.createdAt)}</div>
        </div>
      </div>

      <div className="grid cols-2" style={{ marginTop: 16 }}>
        <div className="card">
          <div className="card-head">
            <div>
              <h2>套餐与席位</h2>
              <p>普通变更即时生效；强制定价（合同价）必须走 owner 双人复核。</p>
            </div>
          </div>
          {detail.subscription ? (
            <SubscriptionForm
              tenantId={id}
              plans={plans}
              current={{
                planCode: detail.subscription.planCode,
                seats: detail.subscription.seats,
                billingCycle: detail.subscription.billingCycle,
              }}
            />
          ) : (
            <div className="alert alert-warn">该租户没有订阅，请先补订阅。</div>
          )}

          <div className="divider" />
          <div className="card-head">
            <div>
              <h2>暂停 / 恢复 / 注销</h2>
              <p>暂停 = 只读，不阻断查看与导出；注销必须第二平台 owner 复核。</p>
            </div>
          </div>
          <TenantStatusActions tenantId={id} status={tenant.status} />
        </div>

        <div className="card">
          <div className="card-head">
            <div>
              <h2>用量趋势（近 14 天）</h2>
              <p>只保留日聚合，不存业务明细。</p>
            </div>
          </div>
          <div className="stack">
            {last14.length === 0 ? <p className="muted small">暂无用量。</p> : null}
            {last14.map((item) => (
              <div className="bar-row" key={item.day}>
                <span className="name tiny mono">{item.day.slice(5)}</span>
                <span className="bar">
                  <span
                    style={{ width: `${Math.round((item.agentActions / maxActions) * 100)}%` }}
                  />
                </span>
                <span className="value tiny">{item.agentActions} 次</span>
              </div>
            ))}
          </div>
          <div className="divider" />
          <dl className="kv">
            <dt>存储</dt>
            <dd>
              {usage.reduce((sum, item) => sum + item.storageGb, 0).toFixed(1)} GB（近 30
              天累计新增）
            </dd>
            <dt>短信</dt>
            <dd>{usage.reduce((sum, item) => sum + item.smsCount, 0)} 条</dd>
            <dt>LLM token</dt>
            <dd>
              {(
                usage.reduce((sum, item) => sum + item.llmInputTokens + item.llmOutputTokens, 0) /
                1000
              ).toFixed(1)}
              K
            </dd>
            <dt>LLM 成本</dt>
            <dd>{money(usage.reduce((sum, item) => sum + item.llmCostCents, 0))}</dd>
          </dl>
        </div>
      </div>

      <div className="grid cols-2" style={{ marginTop: 16 }}>
        <div className="card">
          <div className="card-head">
            <div>
              <h2>账单与发票</h2>
              <p>价税分离展示；红冲走财务复核。</p>
            </div>
            <Link className="btn btn-sm" href={`/billing?tenantId=${id}`}>
              全部账单
            </Link>
          </div>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>发票号</th>
                  <th>状态</th>
                  <th className="num">含税总额</th>
                  <th>开具时间</th>
                </tr>
              </thead>
              <tbody>
                {invoices.slice(0, 6).map((invoice) => (
                  <tr key={invoice.id}>
                    <td className="mono">{invoice.number}</td>
                    <td>
                      <span className={statusClass(invoice.status)}>
                        {INVOICE_STATUS_LABEL[invoice.status]}
                      </span>
                    </td>
                    <td className="num">{money(invoice.totalCents)}</td>
                    <td className="tiny">{date(invoice.issuedAt)}</td>
                  </tr>
                ))}
                {invoices.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="muted">
                      还没有账单。
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
              <h2>账号配置</h2>
              <p>隔离模式、LLM 覆盖、功能开关与开票资料。</p>
            </div>
          </div>
          <dl className="kv">
            <dt>隔离模式</dt>
            <dd>
              {tenant.isolationMode === "SHARED_RLS"
                ? "共享库 + RLS"
                : tenant.isolationMode === "SCHEMA"
                  ? "schema-per-tenant"
                  : "独立数据库"}
            </dd>
            <dt>LLM 覆盖</dt>
            <dd>
              {detail.llmOverride
                ? `${detail.llmOverride.provider} · ${detail.llmOverride.defaultModel}`
                : "继承全局"}
            </dd>
            <dt>功能开关</dt>
            <dd>{detail.featureFlags.length ? detail.featureFlags.join("、") : "无灰度"}</dd>
            <dt>联系人</dt>
            <dd>
              {detail.contactName ?? "—"}
              {detail.contactEmail ? ` · ${detail.contactEmail}` : ""}
            </dd>
            <dt>开票资料</dt>
            <dd>
              {detail.taxProfile
                ? `${detail.taxProfile.title} · ${(detail.taxProfile.taxRateBp / 100).toFixed(0)}%`
                : "未配置（按平台默认）"}
            </dd>
            <dt>备注</dt>
            <dd>{detail.notes ?? "—"}</dd>
          </dl>

          <div className="divider" />
          <h2 style={{ fontSize: 15, margin: "0 0 8px" }}>合同价覆盖</h2>
          {detail.overrides.length === 0 ? (
            <p className="small muted">没有租户级覆盖，按标准价格表计费。</p>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>套餐</th>
                  <th className="num">月价</th>
                  <th>生效</th>
                  <th>状态</th>
                  <th>原因</th>
                </tr>
              </thead>
              <tbody>
                {detail.overrides.map((override) => (
                  <tr key={override.id}>
                    <td>{override.planCode}</td>
                    <td className="num">{money(override.monthlyPriceCents)}</td>
                    <td className="tiny">
                      {day(override.effectiveFrom)} →{" "}
                      {override.effectiveTo ? day(override.effectiveTo) : "长期"}
                    </td>
                    <td>
                      <span className={statusClass(override.status)}>
                        {APPROVAL_STATUS_LABEL[override.status] ?? override.status}
                      </span>
                    </td>
                    <td className="tiny">{override.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </>
  );
}
