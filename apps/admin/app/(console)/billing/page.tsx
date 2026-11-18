import Link from "next/link";
import type { Invoice, TenantSummary } from "@weave-order/schema";
import { INVOICE_STATUS_LABEL, date, money, statusClass } from "@/src/format";
import { platformFetch } from "@/src/server-api";
import { InvoiceActions, InvoiceCreateForm } from "@/src/actions";

export const dynamic = "force-dynamic";

const STATUSES = ["", "DRAFT", "ISSUED", "PAID", "OVERDUE", "RED_FLUSH"];

export default async function BillingPage({
  searchParams,
}: {
  searchParams: Promise<{ tenantId?: string; status?: string }>;
}) {
  const params = await searchParams;
  const query = new URLSearchParams();
  if (params.tenantId) query.set("tenantId", params.tenantId);
  if (params.status) query.set("status", params.status);
  const [{ invoices }, { tenants }] = await Promise.all([
    platformFetch<{ invoices: Invoice[] }>(`/invoices?${query.toString()}`),
    platformFetch<{ tenants: TenantSummary[] }>("/tenants"),
  ]);
  const totalOpen = invoices
    .filter((invoice) => ["ISSUED", "OVERDUE"].includes(invoice.status))
    .reduce((sum, invoice) => sum + invoice.totalCents, 0);
  const totalPaid = invoices
    .filter((invoice) => invoice.status === "PAID")
    .reduce((sum, invoice) => sum + invoice.totalCents, 0);

  return (
    <>
      <div className="page-head">
        <div>
          <div className="crumbs">经营</div>
          <h1>订阅账单</h1>
          <p>合同、账单、回款、逾期、红冲与发票。金额价税分离，税率按租户开票资料或平台默认。</p>
        </div>
      </div>

      <div className="grid cols-3">
        <div className="stat">
          <div className="label">账单数</div>
          <div className="value">{invoices.length}</div>
          <div className="hint">当前筛选</div>
        </div>
        <div className="stat">
          <div className="label">待收款</div>
          <div className="value">{money(totalOpen)}</div>
          <div className="hint">已开具 + 逾期</div>
        </div>
        <div className="stat">
          <div className="label">已回款</div>
          <div className="value">{money(totalPaid)}</div>
          <div className="hint">当前筛选中的 PAID</div>
        </div>
      </div>

      <details className="card" style={{ marginTop: 16 }} open={params.tenantId ? true : undefined}>
        <summary style={{ cursor: "pointer", fontWeight: 600 }}>开一张账单</summary>
        <p className="small muted">
          按订阅席位费 + agent 动作超额自动计费；对手工调整行由服务端重新计算小计、税额与总额。
        </p>
        <InvoiceCreateForm tenants={tenants} defaultTenantId={params.tenantId} />
      </details>

      <div className="card" style={{ marginTop: 16 }}>
        <form className="inline-form" method="get" style={{ marginBottom: 14 }}>
          <div className="field">
            <label htmlFor="tenantId">租户</label>
            <select id="tenantId" name="tenantId" defaultValue={params.tenantId ?? ""}>
              <option value="">全部</option>
              {tenants.map((tenant) => (
                <option key={tenant.id} value={tenant.id}>
                  {tenant.name}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="status">状态</label>
            <select id="status" name="status" defaultValue={params.status ?? ""}>
              {STATUSES.map((status) => (
                <option key={status} value={status}>
                  {status ? INVOICE_STATUS_LABEL[status] : "全部"}
                </option>
              ))}
            </select>
          </div>
          <div className="btn-row">
            <button className="btn" type="submit">
              筛选
            </button>
            <Link className="btn btn-ghost" href="/billing">
              重置
            </Link>
          </div>
        </form>

        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>发票号</th>
                <th>租户</th>
                <th>状态</th>
                <th>账期</th>
                <th className="num">不含税</th>
                <th className="num">税额</th>
                <th className="num">含税总额</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {invoices.map((invoice) => (
                <tr key={invoice.id}>
                  <td className="mono">
                    {invoice.number}
                    <div className="tiny muted">{date(invoice.createdAt)}</div>
                  </td>
                  <td>
                    <Link href={`/tenants/${invoice.tenantId}`}>{invoice.tenantName}</Link>
                  </td>
                  <td>
                    <span className={statusClass(invoice.status)}>
                      {INVOICE_STATUS_LABEL[invoice.status]}
                    </span>
                  </td>
                  <td className="tiny">
                    {invoice.periodStart.slice(0, 10)} → {invoice.periodEnd.slice(0, 10)}
                    <div className="muted">到期 {invoice.dueAt?.slice(0, 10) ?? "—"}</div>
                  </td>
                  <td className="num">{money(invoice.subtotalCents)}</td>
                  <td className="num">
                    {money(invoice.taxCents)}{" "}
                    <span className="tiny muted">({(invoice.taxRateBp / 100).toFixed(0)}%)</span>
                  </td>
                  <td className="num">
                    <strong>{money(invoice.totalCents)}</strong>
                  </td>
                  <td>
                    <InvoiceActions invoice={invoice} />
                  </td>
                </tr>
              ))}
              {invoices.length === 0 ? (
                <tr>
                  <td colSpan={8} className="muted">
                    没有账单。
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
