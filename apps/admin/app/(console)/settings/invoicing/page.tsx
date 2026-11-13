import type { InvoiceSettings } from "@weave-order/schema";
import { bps, date } from "@/src/format";
import { platformFetch } from "@/src/server-api";
import { InvoiceSettingsForm } from "@/src/actions";

export const dynamic = "force-dynamic";

export default async function InvoicingSettingsPage() {
  const settings = await platformFetch<InvoiceSettings>("/settings/invoicing");
  return (
    <>
      <div className="page-head">
        <div>
          <div className="crumbs">商业化</div>
          <h1>开票设置</h1>
          <p>发票类型、税率、开票主体、时机与红冲规则。改税率需 owner + finance 双人复核。</p>
        </div>
        <div className="muted small">
          当前版本 v{settings.version} · {date(settings.updatedAt)}
        </div>
      </div>

      <div className="grid cols-2">
        <div className="card">
          <div className="card-head">
            <div>
              <h2>平台默认开票设置</h2>
              <p>租户可在 tax_profile 覆盖税率与抬头</p>
            </div>
          </div>
          <InvoiceSettingsForm settings={settings} />
        </div>
        <div className="card">
          <div className="card-head">
            <div>
              <h2>国内 SaaS 惯例</h2>
              <p>默认值来自产品设计 §14.3</p>
            </div>
          </div>
          <dl className="kv">
            <dt>发票类型</dt>
            <dd>电子增值税专用发票（可切普票/数电票）</dd>
            <dt>税率</dt>
            <dd>{bps(settings.taxRateBp)} SaaS 服务；可改 13% 或免税，需财务确认</dd>
            <dt>价格展示</dt>
            <dd>价税分离：列表价不含税，账单显示税额与含税总额</dd>
            <dt>开票主体</dt>
            <dd>{settings.issuerEntity}</dd>
            <dt>开票时机</dt>
            <dd>
              {settings.issueTiming === "AFTER_PAYMENT_3D"
                ? "收款后 3 个工作日"
                : settings.issueTiming === "AFTER_PAYMENT"
                  ? "收款后"
                  : "先票后款（需审批）"}
            </dd>
            <dt>红冲/重开</dt>
            <dd>{settings.redFlushRule === "FINANCE_REVIEW" ? "财务审核" : "Owner 审核"}</dd>
          </dl>
          <div className="divider" />
          <div className="alert alert-warn">
            改税率会触发双人复核：提交后不会立即生效，需另一位 owner 或 finance 在「待复核」批准。
          </div>
        </div>
      </div>
    </>
  );
}
