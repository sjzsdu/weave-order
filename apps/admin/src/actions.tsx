"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import type {
  BreakGlassRequest,
  FeatureFlag,
  Invoice,
  InvoiceSettings,
  Plan,
  PlatformIdentitySettings,
  PlatformLlmSettings,
  PriceBookDetail,
  SupportTicket,
  PlatformTenantStatus,
  TenantSummary,
} from "@weave-order/schema";
import { mutate } from "./client-api";

type Method = "POST" | "PATCH" | "PUT" | "DELETE";

/** 统一动作按钮：成功后刷新服务端组件，失败把控制面错误原样展示。 */
export function ActionButton({
  label,
  path,
  method = "POST",
  body,
  promptBody,
  confirmText,
  promptLabel,
  variant = "",
  small = true,
}: {
  label: string;
  path: string;
  method?: Method;
  body?: unknown;
  promptBody?: (input: string | null) => unknown;
  confirmText?: string;
  promptLabel?: string;
  variant?: "" | "btn-primary" | "btn-danger" | "btn-ghost";
  small?: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const run = () => {
    if (confirmText && !window.confirm(confirmText)) return;
    const input = promptLabel ? window.prompt(promptLabel) : null;
    const payload = promptBody ? promptBody(input) : body;
    setError(null);
    startTransition(async () => {
      try {
        await mutate(path, method, payload);
        router.refresh();
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "操作失败");
      }
    });
  };

  return (
    <span>
      <button
        type="button"
        className={`btn ${small ? "btn-sm" : ""} ${variant}`.trim()}
        disabled={pending}
        onClick={run}
        title={error ?? undefined}
      >
        {pending ? "处理中…" : label}
      </button>
      {error ? (
        <span className="tiny" style={{ color: "var(--danger)", marginLeft: 6 }}>
          {error}
        </span>
      ) : null}
    </span>
  );
}

function ErrorLine({ error }: { error: string | null }) {
  return error ? (
    <p className="alert alert-error" style={{ margin: 0 }}>
      {error}
    </p>
  ) : null;
}

function FormShell({
  children,
  onSubmit,
  submitLabel,
  pending,
  error,
  success,
  disabled,
  hint,
}: {
  children: React.ReactNode;
  onSubmit: (event: React.FormEvent<HTMLFormElement>) => void;
  submitLabel: string;
  pending: boolean;
  error: string | null;
  success?: string | null;
  /** 前置条件不满足时禁用提交（例如还没有任何套餐）。 */
  disabled?: boolean;
  hint?: string | null;
}) {
  return (
    <form className="form" onSubmit={onSubmit}>
      {children}
      {hint ? (
        <p className="alert alert-info" style={{ margin: 0 }}>
          {hint}
        </p>
      ) : null}
      <ErrorLine error={error} />
      {success ? (
        <p className="alert alert-ok" style={{ margin: 0 }}>
          {success}
        </p>
      ) : null}
      <div className="btn-row">
        <button className="btn btn-primary" type="submit" disabled={pending || disabled}>
          {pending ? "提交中…" : submitLabel}
        </button>
      </div>
    </form>
  );
}

function useSubmit() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const submit = (path: string, method: Method, body: unknown, message: string) => {
    setError(null);
    setSuccess(null);
    startTransition(async () => {
      try {
        await mutate(path, method, body);
        setSuccess(message);
        router.refresh();
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "操作失败");
      }
    });
  };
  return { pending, error, success, submit };
}

/* --------------------------- 开通公司 --------------------------- */

export function ProvisionTenantForm({ plans }: { plans: Plan[] }) {
  const { pending, error, success, submit } = useSubmit();
  // 没有套餐时订阅无从创建：明确说明原因并禁用提交，而不是让用户撞上参数错误。
  const noPlans = plans.length === 0;
  const [form, setForm] = useState({
    name: "",
    slug: "",
    contactName: "",
    contactEmail: "",
    planCode: plans.find((plan) => plan.code === "PRO")?.code ?? plans[0]?.code ?? "",
    seats: "10",
    billingCycle: "MONTHLY",
    isolationMode: "SHARED_RLS",
    region: "cn-east",
    trialDays: "3",
    notes: "",
  });
  const set =
    (key: keyof typeof form) =>
    (event: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
      setForm((current) => ({ ...current, [key]: event.target.value }));

  return (
    <FormShell
      pending={pending}
      error={error}
      success={success}
      disabled={noPlans}
      hint={noPlans ? "尚未配置任何套餐，无法创建试用订阅。请先到「套餐与价格」新建套餐。" : null}
      submitLabel="开通公司 + 试用订阅"
      onSubmit={(event) => {
        event.preventDefault();
        submit(
          "/tenants",
          "POST",
          {
            name: form.name,
            slug: form.slug.trim().toLowerCase(),
            contactName: form.contactName || undefined,
            contactEmail: form.contactEmail || undefined,
            planCode: form.planCode,
            seats: Number(form.seats),
            billingCycle: form.billingCycle,
            isolationMode: form.isolationMode,
            region: form.region,
            trialDays: Number(form.trialDays),
            notes: form.notes || undefined,
          },
          `已开通「${form.name}」`,
        );
      }}
    >
      <div className="form row">
        <div className="field">
          <label>公司名称</label>
          <input required value={form.name} onChange={set("name")} placeholder="例如：青禾纺织" />
        </div>
        <div className="field">
          <label>租户标识（slug）</label>
          <input
            required
            pattern="[a-z0-9-]+"
            value={form.slug}
            onChange={set("slug")}
            placeholder="qinghe"
          />
        </div>
        <div className="field">
          <label>套餐</label>
          <select value={form.planCode} onChange={set("planCode")} disabled={noPlans}>
            {noPlans ? <option value="">暂无可用套餐</option> : null}
            {plans.map((plan) => (
              <option key={plan.code} value={plan.code}>
                {plan.name}
              </option>
            ))}
          </select>
          {noPlans ? <span className="hint">请先在「套餐与价格」创建套餐。</span> : null}
        </div>
        <div className="field">
          <label>席位数</label>
          <input type="number" min={1} value={form.seats} onChange={set("seats")} />
        </div>
        <div className="field">
          <label>账期</label>
          <select value={form.billingCycle} onChange={set("billingCycle")}>
            <option value="MONTHLY">月付</option>
            <option value="ANNUAL">年付</option>
          </select>
        </div>
        <div className="field">
          <label>试用天数</label>
          <input
            type="number"
            min={0}
            max={90}
            value={form.trialDays}
            onChange={set("trialDays")}
          />
        </div>
        <div className="field">
          <label>隔离模式</label>
          <select value={form.isolationMode} onChange={set("isolationMode")}>
            <option value="SHARED_RLS">共享库 + RLS</option>
            <option value="SCHEMA">独立 schema</option>
            <option value="DATABASE">独立数据库</option>
          </select>
        </div>
        <div className="field">
          <label>区域</label>
          <select value={form.region} onChange={set("region")}>
            <option value="cn-east">华东</option>
            <option value="cn-north">华北</option>
            <option value="cn-south">华南</option>
            <option value="hk">香港</option>
          </select>
        </div>
        <div className="field">
          <label>联系人</label>
          <input value={form.contactName} onChange={set("contactName")} placeholder="王经理" />
        </div>
        <div className="field">
          <label>联系邮箱</label>
          <input
            type="email"
            value={form.contactEmail}
            onChange={set("contactEmail")}
            placeholder="contact@example.com"
          />
        </div>
      </div>
      <div className="field">
        <label>备注</label>
        <textarea value={form.notes} onChange={set("notes")} placeholder="仅平台内部可见" />
      </div>
    </FormShell>
  );
}

/* --------------------------- 改套餐 / 状态 --------------------------- */

export function SubscriptionForm({
  tenantId,
  plans,
  current,
}: {
  tenantId: string;
  plans: Plan[];
  current: { planCode: string; seats: number; billingCycle: string };
}) {
  const { pending, error, success, submit } = useSubmit();
  const [planCode, setPlanCode] = useState(current.planCode);
  const [seats, setSeats] = useState(String(current.seats));
  const [cycle, setCycle] = useState(current.billingCycle);
  const [forcePrice, setForcePrice] = useState("");
  const [forceReason, setForceReason] = useState("");

  return (
    <FormShell
      pending={pending}
      error={error}
      success={success}
      submitLabel={forcePrice ? "提交双人复核" : "保存变更"}
      onSubmit={(event) => {
        event.preventDefault();
        const body: Record<string, unknown> = {
          planCode,
          seats: Number(seats),
          billingCycle: cycle,
        };
        if (forcePrice) {
          body.forceMonthlyPriceCents = Math.round(Number(forcePrice) * 100);
          body.forceReason = forceReason || "合同价调整";
        }
        submit(
          `/tenants/${tenantId}/subscription`,
          "PATCH",
          body,
          forcePrice ? "已提交复核" : "已更新订阅",
        );
      }}
    >
      <div className="form row">
        <div className="field">
          <label>套餐</label>
          <select value={planCode} onChange={(event) => setPlanCode(event.target.value)}>
            {plans.map((plan) => (
              <option key={plan.code} value={plan.code}>
                {plan.name}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>席位</label>
          <input
            type="number"
            min={1}
            value={seats}
            onChange={(event) => setSeats(event.target.value)}
          />
        </div>
        <div className="field">
          <label>账期</label>
          <select value={cycle} onChange={(event) => setCycle(event.target.value)}>
            <option value="MONTHLY">月付</option>
            <option value="ANNUAL">年付</option>
          </select>
        </div>
      </div>
      <div className="form row">
        <div className="field">
          <label>强制定价（元/席/月，可空）</label>
          <input
            type="number"
            min={0}
            step="0.01"
            value={forcePrice}
            onChange={(event) => setForcePrice(event.target.value)}
            placeholder="留空按标准价"
          />
          <span className="hint">填写后不会立即生效，会创建 owner 双人复核。</span>
        </div>
        <div className="field">
          <label>合同价原因</label>
          <input
            value={forceReason}
            onChange={(event) => setForceReason(event.target.value)}
            placeholder="三年锁价 / 试点价"
          />
        </div>
      </div>
    </FormShell>
  );
}

export function TenantStatusActions({
  tenantId,
  status,
}: {
  tenantId: string;
  status: PlatformTenantStatus;
}) {
  return (
    <div className="btn-row">
      {status !== "SUSPENDED" && status !== "CANCELLED" ? (
        <ActionButton
          label="暂停（只读）"
          path={`/tenants/${tenantId}/status`}
          body={{ status: "SUSPENDED", reason: "平台暂停（人工）" }}
          confirmText="暂停后租户只读：不能新增单据或调用 agent，但查看与导出不受影响。确认？"
        />
      ) : null}
      {status === "SUSPENDED" || status === "OVERDUE" ? (
        <ActionButton
          label="恢复为正式"
          path={`/tenants/${tenantId}/status`}
          body={{ status: "ACTIVE", reason: "平台恢复" }}
        />
      ) : null}
      {status === "TRIAL" ? (
        <ActionButton
          label="转为正式"
          path={`/tenants/${tenantId}/status`}
          body={{ status: "ACTIVE", reason: "试用转正式" }}
        />
      ) : null}
      <ActionButton
        label="注销申请（双人复核）"
        path={`/tenants/${tenantId}/purge-request`}
        promptLabel="注销原因（写入平台审计）"
        promptBody={(reason) => ({ reason: reason || "租户申请注销" })}
        confirmText="注销只匿名化控制面账号并保留账单与审计，不会触碰租户业务库。提交后需第二位 owner 复核。继续？"
        variant="btn-danger"
      />
    </div>
  );
}

/* --------------------------- 账单 --------------------------- */

export function InvoiceActions({ invoice }: { invoice: Invoice }) {
  return (
    <div className="btn-row">
      {invoice.status === "DRAFT" ? (
        <ActionButton
          label="开具"
          path={`/invoices/${invoice.id}/issue`}
          body={{}}
          variant="btn-primary"
        />
      ) : null}
      {invoice.status === "ISSUED" || invoice.status === "OVERDUE" ? (
        <ActionButton label="登记回款" path={`/invoices/${invoice.id}/paid`} body={{}} />
      ) : null}
      {invoice.status === "PAID" ? (
        <ActionButton
          label="退款申请"
          path={`/invoices/${invoice.id}/refund-request`}
          promptLabel="退款金额（元）与原因，格式：金额|原因"
          promptBody={(input) => {
            const [amount, ...rest] = (input ?? "").split("|");
            return {
              amountCents: Math.round(Number(amount || 0) * 100),
              reason: rest.join("|").trim() || "客户申请退款",
            };
          }}
          confirmText="退款需 owner + finance 双人复核，批准后写入退款记录。继续？"
          variant="btn-danger"
        />
      ) : null}
      {invoice.status !== "RED_FLUSH" && invoice.status !== "VOID" ? (
        <ActionButton
          label="红冲申请"
          path={`/invoices/${invoice.id}/void-request`}
          promptLabel="红冲原因（财务复核）"
          promptBody={(reason) => ({ reason: reason || "客户要求红冲" })}
          variant="btn-danger"
          confirmText="红冲会创建财务复核申请，批准后发票状态变为已红冲。继续？"
        />
      ) : null}
    </div>
  );
}

export function InvoiceCreateForm({
  tenants,
  defaultTenantId,
}: {
  tenants: TenantSummary[];
  defaultTenantId?: string;
}) {
  const { pending, error, success, submit } = useSubmit();
  const today = new Date();
  const start = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
  const end = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 0));
  const [tenantId, setTenantId] = useState(defaultTenantId ?? tenants[0]?.id ?? "");
  const [periodStart, setPeriodStart] = useState(start.toISOString().slice(0, 10));
  const [periodEnd, setPeriodEnd] = useState(end.toISOString().slice(0, 10));
  const [notes, setNotes] = useState("");

  return (
    <FormShell
      pending={pending}
      error={error}
      success={success}
      submitLabel="生成账单草稿"
      onSubmit={(event) => {
        event.preventDefault();
        submit(
          "/invoices",
          "POST",
          {
            tenantId,
            periodStart: `${periodStart}T00:00:00.000Z`,
            periodEnd: `${periodEnd}T23:59:59.000Z`,
            notes: notes || undefined,
            adjustments: [],
          },
          "账单草稿已生成，记得开具",
        );
      }}
    >
      <div className="form row">
        <div className="field">
          <label>租户</label>
          <select value={tenantId} onChange={(event) => setTenantId(event.target.value)} required>
            {tenants.map((tenant) => (
              <option key={tenant.id} value={tenant.id}>
                {tenant.name}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>账期开始</label>
          <input
            type="date"
            value={periodStart}
            onChange={(event) => setPeriodStart(event.target.value)}
            required
          />
        </div>
        <div className="field">
          <label>账期结束</label>
          <input
            type="date"
            value={periodEnd}
            onChange={(event) => setPeriodEnd(event.target.value)}
            required
          />
        </div>
        <div className="field">
          <label>备注</label>
          <input
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
            placeholder="可选"
          />
        </div>
      </div>
    </FormShell>
  );
}

/* --------------------------- 审批 --------------------------- */

export function ApprovalDecision({ id }: { id: string }) {
  const [reason, setReason] = useState("");
  return (
    <div className="stack" style={{ gap: 6 }}>
      <input
        className="field"
        style={{
          border: "1px solid var(--line)",
          borderRadius: 8,
          padding: "6px 8px",
          fontSize: 12,
        }}
        placeholder="复核意见（可选）"
        value={reason}
        onChange={(event) => setReason(event.target.value)}
      />
      <div className="btn-row">
        <ActionButton
          label="批准"
          path={`/approvals/${id}/decide`}
          body={{ decision: "approve", reason: reason || undefined }}
          variant="btn-primary"
        />
        <ActionButton
          label="拒绝"
          path={`/approvals/${id}/decide`}
          body={{ decision: "reject", reason: reason || undefined }}
          variant="btn-danger"
        />
      </div>
    </div>
  );
}

/* --------------------------- 价格 --------------------------- */

const PLAN_FEATURES = [
  { key: "customer_portal", label: "客户门户" },
  { key: "sso", label: "企业 SSO" },
  { key: "custom_domain", label: "自定义域名" },
  { key: "print_agent", label: "打印代理" },
] as const;

/**
 * 新建套餐：空控制面（迁移未带默认套餐 / 需要新增档位）时的自助入口。
 * 套餐代码不可修改，价格不在套餐里而在价格表中维护。
 */
export function PlanForm({ existingCodes }: { existingCodes: string[] }) {
  const { pending, error, success, submit } = useSubmit();
  const [form, setForm] = useState({
    code: "",
    name: "",
    tier: "1",
    seatMin: "5",
    seatMax: "5",
    credits: "20000",
    storageGb: "50",
  });
  const [features, setFeatures] = useState<Record<string, boolean>>({});
  const set =
    (key: keyof typeof form) =>
    (event: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
      setForm((current) => ({ ...current, [key]: event.target.value }));

  return (
    <FormShell
      pending={pending}
      error={error}
      success={success}
      submitLabel="新建套餐"
      onSubmit={(event) => {
        event.preventDefault();
        submit(
          "/pricing/plans",
          "POST",
          {
            code: form.code.trim().toUpperCase(),
            name: form.name,
            tier: Number(form.tier),
            seatMin: Number(form.seatMin),
            seatMax: form.seatMax.trim() ? Number(form.seatMax) : null,
            agentActionsQuota: Number(form.credits),
            storageGb: Number(form.storageGb),
            features,
          },
          `已新建套餐「${form.name}」；价格请到「新建价格版本」补齐`,
        );
      }}
    >
      <div className="form row">
        <div className="field">
          <label>套餐代码</label>
          <input
            required
            value={form.code}
            onChange={set("code")}
            placeholder="GROWTH"
            pattern="[A-Za-z][A-Za-z0-9_]*"
          />
          <span className="hint">大写字母、数字和下划线；创建后不可修改。</span>
        </div>
        <div className="field">
          <label>套餐名称</label>
          <input required value={form.name} onChange={set("name")} placeholder="成长版 Growth" />
        </div>
        <div className="field">
          <label>档位</label>
          <input type="number" min={0} max={9} value={form.tier} onChange={set("tier")} />
          <span className="hint">数值越大档位越高，用于排序与功能分层。</span>
        </div>
      </div>
      <div className="form row">
        <div className="field">
          <label>内含席位</label>
          <input type="number" min={0} value={form.seatMin} onChange={set("seatMin")} />
        </div>
        <div className="field">
          <label>席位上限定（留空不限）</label>
          <input type="number" min={1} value={form.seatMax} onChange={set("seatMax")} />
        </div>
        <div className="field">
          <label>每月 credits</label>
          <input type="number" min={0} value={form.credits} onChange={set("credits")} />
        </div>
        <div className="field">
          <label>存储（GB）</label>
          <input type="number" min={0} value={form.storageGb} onChange={set("storageGb")} />
        </div>
      </div>
      <div className="field">
        <label>功能开关</label>
        <div className="check-row">
          {PLAN_FEATURES.map((feature) => (
            <label key={feature.key} className="check">
              <input
                type="checkbox"
                checked={features[feature.key] === true}
                onChange={(event) =>
                  setFeatures((current) => ({ ...current, [feature.key]: event.target.checked }))
                }
              />
              {feature.label}
            </label>
          ))}
        </div>
      </div>
      {existingCodes.length > 0 ? (
        <p className="tiny muted">已有套餐：{existingCodes.join("、")}</p>
      ) : null}
    </FormShell>
  );
}

export function PriceBookForm({ plans, base }: { plans: Plan[]; base?: PriceBookDetail }) {
  const { pending, error, success, submit } = useSubmit();
  const initial = Object.fromEntries(
    plans.map((plan) => {
      const price = base?.prices.find((item) => item.planCode === plan.code);
      return [
        plan.code,
        {
          monthly: String((price?.monthlyPriceCents ?? 0) / 100),
          annual: String((price?.annualPriceCents ?? 0) / 100),
        },
      ];
    }),
  );
  const [rows, setRows] = useState(initial);
  const [notes, setNotes] = useState("");
  const update = (code: string, key: "monthly" | "annual", value: string) =>
    setRows((current) => ({
      ...current,
      [code]: { ...(current[code] ?? { monthly: "0", annual: "0" }), [key]: value },
    }));

  // 没有套餐就没有可定价的行：说明原因，避免提交出「请求参数校验失败」。
  if (plans.length === 0) {
    return (
      <p className="alert alert-info" style={{ margin: 0 }}>
        尚未配置任何套餐，无法创建价格版本。请先在上方「新建套餐」创建套餐。
      </p>
    );
  }

  return (
    <FormShell
      pending={pending}
      error={error}
      success={success}
      submitLabel="保存为草稿版本"
      onSubmit={(event) => {
        event.preventDefault();
        submit(
          "/pricing/books",
          "POST",
          {
            notes: notes || undefined,
            prices: plans.map((plan) => ({
              planCode: plan.code,
              monthlyPriceCents: Math.round(Number(rows[plan.code]?.monthly ?? 0) * 100),
              annualPriceCents: Math.round(Number(rows[plan.code]?.annual ?? 0) * 100),
              currency: "CNY",
            })),
          },
          "草稿已创建；生效请在版本列表点「提交生效」",
        );
      }}
    >
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>套餐</th>
              <th>月付（元/席）</th>
              <th>年付（元/席）</th>
            </tr>
          </thead>
          <tbody>
            {plans.map((plan) => (
              <tr key={plan.code}>
                <td>{plan.name}</td>
                <td>
                  <input
                    type="number"
                    min={0}
                    step="0.01"
                    value={rows[plan.code]?.monthly ?? "0"}
                    onChange={(event) => update(plan.code, "monthly", event.target.value)}
                    style={{
                      width: 110,
                      border: "1px solid var(--line)",
                      borderRadius: 6,
                      padding: "5px 7px",
                    }}
                  />
                </td>
                <td>
                  <input
                    type="number"
                    min={0}
                    step="0.01"
                    value={rows[plan.code]?.annual ?? "0"}
                    onChange={(event) => update(plan.code, "annual", event.target.value)}
                    style={{
                      width: 110,
                      border: "1px solid var(--line)",
                      borderRadius: 6,
                      padding: "5px 7px",
                    }}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="field">
        <label>版本说明</label>
        <input
          value={notes}
          onChange={(event) => setNotes(event.target.value)}
          placeholder="例如：2027 年调价，仅影响新合同"
        />
      </div>
    </FormShell>
  );
}

export function ActivatePriceBook({ bookId }: { bookId: string }) {
  return (
    <ActionButton
      label="提交生效"
      path={`/pricing/books/${bookId}/activate-request`}
      variant="btn-primary"
      confirmText="改价需 owner + finance 双人复核。提交后到「待复核」批准才会生效。继续？"
    />
  );
}

export function PricingPreviewForm({ plans }: { plans: Plan[] }) {
  const [planCode, setPlanCode] = useState(
    plans.find((plan) => plan.code === "PRO")?.code ?? plans[0]?.code ?? "",
  );
  const [seats, setSeats] = useState("20");
  const [cycle, setCycle] = useState("MONTHLY");
  const [monthly, setMonthly] = useState("");
  const [result, setResult] = useState<null | {
    monthlyTotalCents: number;
    annualTotalCents: number;
    effectiveMonthlyCents: number;
  }>(null);
  const [error, setError] = useState<string | null>(null);
  const { pending, startTransition } = useTransitionStore();

  if (plans.length === 0) {
    return (
      <p className="alert alert-info" style={{ margin: 0 }}>
        尚未配置任何套餐，无法试算。请先在上方「新建套餐」创建套餐。
      </p>
    );
  }

  return (
    <form
      className="form"
      onSubmit={(event) => {
        event.preventDefault();
        setError(null);
        startTransition(async () => {
          try {
            const response = await fetch("/api/pricing/preview", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                planCode,
                seats: Number(seats),
                billingCycle: cycle,
                monthlyPriceCents: monthly ? Math.round(Number(monthly) * 100) : undefined,
              }),
            });
            const body = (await response.json()) as {
              error?: { message?: string };
              monthlyTotalCents?: number;
              annualTotalCents?: number;
              effectiveMonthlyCents?: number;
            };
            if (!response.ok) throw new Error(body.error?.message ?? "试算失败");
            setResult({
              monthlyTotalCents: body.monthlyTotalCents ?? 0,
              annualTotalCents: body.annualTotalCents ?? 0,
              effectiveMonthlyCents: body.effectiveMonthlyCents ?? 0,
            });
          } catch (cause) {
            setError(cause instanceof Error ? cause.message : "试算失败");
          }
        });
      }}
    >
      <div className="form row">
        <div className="field">
          <label>套餐</label>
          <select value={planCode} onChange={(event) => setPlanCode(event.target.value)}>
            {plans.map((plan) => (
              <option key={plan.code} value={plan.code}>
                {plan.name}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>席位</label>
          <input
            type="number"
            min={1}
            value={seats}
            onChange={(event) => setSeats(event.target.value)}
          />
        </div>
        <div className="field">
          <label>账期</label>
          <select value={cycle} onChange={(event) => setCycle(event.target.value)}>
            <option value="MONTHLY">月付</option>
            <option value="ANNUAL">年付</option>
          </select>
        </div>
        <div className="field">
          <label>覆盖月价（元/席，可空）</label>
          <input
            type="number"
            min={0}
            step="0.01"
            value={monthly}
            onChange={(event) => setMonthly(event.target.value)}
            placeholder="按生效价格表"
          />
        </div>
      </div>
      <ErrorLine error={error} />
      {result ? (
        <div className="alert alert-ok">
          月费 <strong>¥{(result.monthlyTotalCents / 100).toLocaleString()}</strong> · 年费{" "}
          <strong>¥{(result.annualTotalCents / 100).toLocaleString()}</strong> · 折算月费{" "}
          <strong>¥{(result.effectiveMonthlyCents / 100).toLocaleString()}</strong>
        </div>
      ) : null}
      <div>
        <button className="btn" type="submit" disabled={pending}>
          {pending ? "试算中…" : "试算"}
        </button>
      </div>
    </form>
  );
}

function useTransitionStore() {
  const [pending, startTransition] = useTransition();
  return { pending, startTransition };
}

/* --------------------------- 开票设置 --------------------------- */

export function InvoiceSettingsForm({ settings }: { settings: InvoiceSettings }) {
  const { pending, error, success, submit } = useSubmit();
  const [form, setForm] = useState({
    invoiceType: settings.invoiceType,
    taxRateBp: String(settings.taxRateBp),
    priceDisplay: settings.priceDisplay,
    issuerEntity: settings.issuerEntity,
    issueTiming: settings.issueTiming,
    redFlushRule: settings.redFlushRule,
    reason: "",
  });
  const set =
    (key: keyof typeof form) => (event: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
      setForm((current) => ({ ...current, [key]: event.target.value }));

  return (
    <FormShell
      pending={pending}
      error={error}
      success={success}
      submitLabel={Number(form.taxRateBp) !== settings.taxRateBp ? "提交税率复核" : "保存设置"}
      onSubmit={(event) => {
        event.preventDefault();
        submit(
          "/settings/invoicing",
          "PATCH",
          {
            invoiceType: form.invoiceType,
            taxRateBp: Number(form.taxRateBp),
            priceDisplay: form.priceDisplay,
            issuerEntity: form.issuerEntity,
            issueTiming: form.issueTiming,
            redFlushRule: form.redFlushRule,
            reason: form.reason || undefined,
          },
          Number(form.taxRateBp) !== settings.taxRateBp ? "税率变更已提交双人复核" : "已保存",
        );
      }}
    >
      <div className="form row">
        <div className="field">
          <label>发票类型</label>
          <select value={form.invoiceType} onChange={set("invoiceType")}>
            <option value="VAT_SPECIAL">电子增值税专用发票</option>
            <option value="VAT_NORMAL">增值税普通发票</option>
            <option value="E_INVOICE">数电票</option>
          </select>
        </div>
        <div className="field">
          <label>税率（基点，600 = 6%）</label>
          <input
            type="number"
            min={0}
            max={10000}
            value={form.taxRateBp}
            onChange={set("taxRateBp")}
          />
        </div>
        <div className="field">
          <label>价格展示</label>
          <select value={form.priceDisplay} onChange={set("priceDisplay")}>
            <option value="TAX_EXCLUSIVE">价税分离</option>
            <option value="TAX_INCLUSIVE">含税价</option>
          </select>
        </div>
      </div>
      <div className="form row">
        <div className="field">
          <label>开票主体</label>
          <input value={form.issuerEntity} onChange={set("issuerEntity")} />
        </div>
        <div className="field">
          <label>开票时机</label>
          <select value={form.issueTiming} onChange={set("issueTiming")}>
            <option value="AFTER_PAYMENT_3D">收款后 3 个工作日</option>
            <option value="AFTER_PAYMENT">收款后</option>
            <option value="BEFORE_PAYMENT">先票后款（需审批）</option>
          </select>
        </div>
        <div className="field">
          <label>红冲规则</label>
          <select value={form.redFlushRule} onChange={set("redFlushRule")}>
            <option value="FINANCE_REVIEW">财务审核</option>
            <option value="OWNER_REVIEW">Owner 审核</option>
          </select>
        </div>
      </div>
      <div className="field">
        <label>变更原因（改税必填）</label>
        <input
          value={form.reason}
          onChange={set("reason")}
          placeholder="财务确认按 SaaS 服务 6% 开票"
        />
      </div>
    </FormShell>
  );
}

/* --------------------------- LLM --------------------------- */

export function LlmSettingsForm({ settings }: { settings: PlatformLlmSettings }) {
  const { pending, error, success, submit } = useSubmit();
  const [form, setForm] = useState({
    provider: settings.provider,
    baseUrl: settings.baseUrl ?? "",
    defaultModel: settings.defaultModel,
    dailyTokenBudget: settings.dailyTokenBudget?.toString() ?? "",
    monthlyTokenBudget: settings.monthlyTokenBudget?.toString() ?? "",
    keyRef: settings.keyRef ?? "",
  });
  const set = (key: keyof typeof form) => (event: React.ChangeEvent<HTMLInputElement>) =>
    setForm((current) => ({ ...current, [key]: event.target.value }));

  return (
    <FormShell
      pending={pending}
      error={error}
      success={success}
      submitLabel="保存全局配置"
      onSubmit={(event) => {
        event.preventDefault();
        submit(
          "/settings/llm",
          "PUT",
          {
            scope: "GLOBAL",
            provider: form.provider,
            baseUrl: form.baseUrl || null,
            defaultModel: form.defaultModel,
            dailyTokenBudget: form.dailyTokenBudget ? Number(form.dailyTokenBudget) : null,
            monthlyTokenBudget: form.monthlyTokenBudget ? Number(form.monthlyTokenBudget) : null,
            keyRef: form.keyRef || null,
          },
          "全局 LLM 配置已保存",
        );
      }}
    >
      <div className="form row">
        <div className="field">
          <label>Provider</label>
          <input value={form.provider} onChange={set("provider")} />
        </div>
        <div className="field">
          <label>网关地址</label>
          <input
            value={form.baseUrl}
            onChange={set("baseUrl")}
            placeholder="http://localhost:4000"
          />
        </div>
        <div className="field">
          <label>默认模型</label>
          <input value={form.defaultModel} onChange={set("defaultModel")} />
        </div>
        <div className="field">
          <label>Key 引用（环境变量名）</label>
          <input value={form.keyRef} onChange={set("keyRef")} placeholder="LITELLM_MASTER_KEY" />
        </div>
        <div className="field">
          <label>日 token 预算</label>
          <input
            type="number"
            min={0}
            value={form.dailyTokenBudget}
            onChange={set("dailyTokenBudget")}
          />
        </div>
        <div className="field">
          <label>月 token 预算</label>
          <input
            type="number"
            min={0}
            value={form.monthlyTokenBudget}
            onChange={set("monthlyTokenBudget")}
          />
        </div>
      </div>
    </FormShell>
  );
}

export function LlmOverrideForm({
  tenants,
  settings,
}: {
  tenants: TenantSummary[];
  settings: PlatformLlmSettings[];
}) {
  const { pending, error, success, submit } = useSubmit();
  const [tenantId, setTenantId] = useState(tenants[0]?.id ?? "");
  const [model, setModel] = useState("deepseek-chat");
  const [baseUrl, setBaseUrl] = useState("");
  const existing = settings.find((item) => item.tenantId === tenantId);

  return (
    <FormShell
      pending={pending}
      error={error}
      success={success}
      submitLabel="保存租户覆盖"
      onSubmit={(event) => {
        event.preventDefault();
        submit(
          "/settings/llm",
          "PUT",
          {
            scope: "TENANT",
            tenantId,
            defaultModel: model,
            baseUrl: baseUrl || existing?.baseUrl || null,
          },
          "租户 LLM 覆盖已保存",
        );
      }}
    >
      <div className="form row">
        <div className="field">
          <label>租户</label>
          <select value={tenantId} onChange={(event) => setTenantId(event.target.value)}>
            {tenants.map((tenant) => (
              <option key={tenant.id} value={tenant.id}>
                {tenant.name}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>默认模型</label>
          <input value={model} onChange={(event) => setModel(event.target.value)} />
        </div>
        <div className="field">
          <label>专用网关（可空）</label>
          <input
            value={baseUrl}
            onChange={(event) => setBaseUrl(event.target.value)}
            placeholder={existing?.baseUrl ?? "继承全局"}
          />
        </div>
      </div>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>租户</th>
              <th>模型</th>
              <th>网关</th>
              <th>预算</th>
              <th>版本</th>
            </tr>
          </thead>
          <tbody>
            {settings.map((item) => (
              <tr key={item.tenantId}>
                <td>
                  {tenants.find((tenant) => tenant.id === item.tenantId)?.name ?? item.tenantId}
                </td>
                <td className="mono tiny">{item.defaultModel}</td>
                <td className="tiny">{item.baseUrl ?? "继承"}</td>
                <td className="tiny">{item.monthlyTokenBudget?.toLocaleString() ?? "继承"}</td>
                <td className="num">v{item.version}</td>
              </tr>
            ))}
            {settings.length === 0 ? (
              <tr>
                <td colSpan={5} className="muted">
                  没有租户覆盖，全部继承全局。
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </FormShell>
  );
}

export function LlmTestButton({ baseUrl }: { baseUrl?: string }) {
  const [result, setResult] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  return (
    <div className="right">
      <button
        className="btn"
        type="button"
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            try {
              const response = await fetch("/api/settings/llm/test", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ baseUrl }),
              });
              const body = (await response.json()) as {
                ok?: boolean;
                latencyMs?: number;
                message?: string;
                error?: { message?: string };
              };
              setResult(
                body.ok
                  ? `连接正常 · ${body.latencyMs}ms`
                  : `失败：${body.message ?? body.error?.message ?? "未知"}`,
              );
            } catch (cause) {
              setResult(cause instanceof Error ? cause.message : "测试失败");
            }
          })
        }
      >
        {pending ? "测试中…" : "测试连接"}
      </button>
      {result ? (
        <div className="tiny muted" style={{ marginTop: 4 }}>
          {result}
        </div>
      ) : null}
    </div>
  );
}

/* --------------------------- 身份 --------------------------- */

export function IdentitySettingsForm({ settings }: { settings: PlatformIdentitySettings }) {
  const { pending, error, success, submit } = useSubmit();
  const [mfa, setMfa] = useState(settings.mfaRequired);
  const [sso, setSso] = useState(settings.ssoEnabled);
  const [template, setTemplate] = useState(settings.casdoorOrgTemplate);
  const [hours, setHours] = useState(String(settings.sessionMaxHours));

  return (
    <FormShell
      pending={pending}
      error={error}
      success={success}
      submitLabel="保存身份策略"
      onSubmit={(event) => {
        event.preventDefault();
        submit(
          "/settings/identity",
          "PATCH",
          {
            mfaRequired: mfa,
            ssoEnabled: sso,
            casdoorOrgTemplate: template,
            sessionMaxHours: Number(hours),
          },
          "身份策略已保存",
        );
      }}
    >
      <label className="check">
        <input type="checkbox" checked={mfa} onChange={(event) => setMfa(event.target.checked)} />{" "}
        强制 MFA（平台端不可关闭的唯一例外是本地 dev）
      </label>
      <label className="check">
        <input type="checkbox" checked={sso} onChange={(event) => setSso(event.target.checked)} />{" "}
        允许企业 SSO（Pro 及以上）
      </label>
      <div className="field">
        <label>Casdoor 组织模板</label>
        <input value={template} onChange={(event) => setTemplate(event.target.value)} />
      </div>
      <div className="field">
        <label>会话最长时长（小时）</label>
        <input
          type="number"
          min={1}
          value={hours}
          onChange={(event) => setHours(event.target.value)}
        />
      </div>
      <div className="alert alert-warn">
        社交登录在控制面被硬编码禁止（前后端双重校验），不提供开关。
      </div>
    </FormShell>
  );
}

/* --------------------------- 功能开关 --------------------------- */

export function FeatureFlagRow({ flag }: { flag: FeatureFlag }) {
  const { pending, error, success, submit } = useSubmit();
  const [enabled, setEnabled] = useState(flag.enabled);
  const [rollout, setRollout] = useState(String(flag.rolloutPercent));
  const [tenantIds, setTenantIds] = useState(flag.tenantIds.join(","));

  return (
    <tr>
      <td>
        <strong>{flag.name}</strong>
        <div className="tiny muted mono">{flag.key}</div>
      </td>
      <td className="tiny">{flag.description || "—"}</td>
      <td>
        <div className="tiny">启用：{enabled ? "是" : "否"}</div>
        <div className="tiny">{rollout}% 灰度</div>
      </td>
      <td className="tiny mono" style={{ maxWidth: 180 }}>
        {tenantIds || "—"}
      </td>
      <td className="tiny">
        {error ? <span style={{ color: "var(--danger)" }}>{error}</span> : null}
        {success ? <span style={{ color: "var(--ok)" }}>{success}</span> : null}
        {!error && !success ? "—" : null}
      </td>
      <td>
        <div className="stack" style={{ gap: 6 }}>
          <label className="check">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(event) => setEnabled(event.target.checked)}
            />{" "}
            启用
          </label>
          <input
            type="number"
            min={0}
            max={100}
            value={rollout}
            onChange={(event) => setRollout(event.target.value)}
            style={{
              width: 72,
              border: "1px solid var(--line)",
              borderRadius: 6,
              padding: "4px 6px",
            }}
          />
          <input
            value={tenantIds}
            onChange={(event) => setTenantIds(event.target.value)}
            placeholder="租户 ID，逗号分隔"
            style={{
              width: 180,
              border: "1px solid var(--line)",
              borderRadius: 6,
              padding: "4px 6px",
              fontSize: 11,
            }}
          />
          <button
            className="btn btn-sm"
            type="button"
            disabled={pending}
            onClick={() =>
              submit(
                `/settings/feature-flags/${flag.key}`,
                "PATCH",
                {
                  enabled,
                  rolloutPercent: Number(rollout),
                  tenantIds: tenantIds
                    .split(",")
                    .map((item) => item.trim())
                    .filter(Boolean),
                },
                "已保存",
              )
            }
          >
            {pending ? "保存中…" : "保存"}
          </button>
        </div>
      </td>
    </tr>
  );
}

/* --------------------------- 配置中心 --------------------------- */

export function ConfigForm() {
  const { pending, error, success, submit } = useSubmit();
  const [key, setKey] = useState("");
  const [scope, setScope] = useState("GLOBAL");
  const [scopeRef, setScopeRef] = useState("");
  const [value, setValue] = useState("{}");
  const [preview, setPreview] = useState<string | null>(null);

  const parse = (): unknown => JSON.parse(value);

  return (
    <FormShell
      pending={pending}
      error={error}
      success={success}
      submitLabel="发布新版本"
      onSubmit={(event) => {
        event.preventDefault();
        let parsed: unknown;
        try {
          parsed = parse();
        } catch {
          setPreview("JSON 格式不正确");
          return;
        }
        submit(
          "/settings/configs",
          "POST",
          { key, scope, scopeRef: scope === "GLOBAL" ? null : scopeRef || null, value: parsed },
          "配置已发布（旧版本自动标为 SUPERSEDED）",
        );
      }}
    >
      <div className="form row">
        <div className="field">
          <label>配置 Key</label>
          <input
            required
            value={key}
            onChange={(event) => setKey(event.target.value)}
            placeholder="billing.overage_unit_cents"
          />
        </div>
        <div className="field">
          <label>作用域</label>
          <select value={scope} onChange={(event) => setScope(event.target.value)}>
            <option value="GLOBAL">全局</option>
            <option value="PLAN">套餐</option>
            <option value="TENANT">租户</option>
          </select>
        </div>
        <div className="field">
          <label>作用域引用</label>
          <input
            value={scopeRef}
            onChange={(event) => setScopeRef(event.target.value)}
            disabled={scope === "GLOBAL"}
            placeholder="PRO / tenant-id"
          />
        </div>
      </div>
      <div className="field">
        <label>JSON 值</label>
        <textarea value={value} onChange={(event) => setValue(event.target.value)} />
      </div>
      {preview ? <div className="alert alert-warn">{preview}</div> : null}
      <div className="btn-row">
        <button
          className="btn btn-sm"
          type="button"
          onClick={() => {
            void (async () => {
              try {
                const response = await fetch("/api/settings/configs/preview", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    key,
                    scope,
                    scopeRef: scope === "GLOBAL" ? null : scopeRef || null,
                    value: parse(),
                  }),
                });
                const body = (await response.json()) as {
                  affectedTenants?: number;
                  before?: unknown;
                  error?: { message?: string };
                };
                if (!response.ok) throw new Error(body.error?.message ?? "预览失败");
                setPreview(
                  `影响租户 ${body.affectedTenants ?? 0} 家 · 变更前：${JSON.stringify(body.before)?.slice(0, 120) ?? "无"}`,
                );
              } catch (cause) {
                setPreview(cause instanceof Error ? cause.message : "预览失败");
              }
            })();
          }}
        >
          影响预览
        </button>
      </div>
    </FormShell>
  );
}

export function ConfigRollback({ id }: { id: string }) {
  return (
    <ActionButton
      label="回滚到此版本"
      path={`/settings/configs/${id}/rollback`}
      confirmText="回滚会创建一个内容相同的新版本（不删除历史）。继续？"
    />
  );
}

/* --------------------------- 支持 --------------------------- */

export function TicketForm({
  tenants,
  defaultTenantId,
}: {
  tenants: TenantSummary[];
  defaultTenantId?: string;
}) {
  const { pending, error, success, submit } = useSubmit();
  const [tenantId, setTenantId] = useState(defaultTenantId ?? tenants[0]?.id ?? "");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [priority, setPriority] = useState("NORMAL");

  return (
    <FormShell
      pending={pending}
      error={error}
      success={success}
      submitLabel="开工单"
      onSubmit={(event) => {
        event.preventDefault();
        submit("/support/tickets", "POST", { tenantId, title, body, priority }, "工单已创建");
      }}
    >
      <div className="form row">
        <div className="field">
          <label>租户</label>
          <select value={tenantId} onChange={(event) => setTenantId(event.target.value)}>
            {tenants.map((tenant) => (
              <option key={tenant.id} value={tenant.id}>
                {tenant.name}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>优先级</label>
          <select value={priority} onChange={(event) => setPriority(event.target.value)}>
            <option value="LOW">低</option>
            <option value="NORMAL">普通</option>
            <option value="HIGH">高</option>
            <option value="URGENT">紧急</option>
          </select>
        </div>
        <div className="field">
          <label>标题</label>
          <input required value={title} onChange={(event) => setTitle(event.target.value)} />
        </div>
      </div>
      <div className="field">
        <label>描述</label>
        <textarea required value={body} onChange={(event) => setBody(event.target.value)} />
      </div>
    </FormShell>
  );
}

export function TicketStatusSelect({
  id,
  status,
}: {
  id: string;
  status: SupportTicket["status"];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  return (
    <select
      value={status}
      disabled={pending}
      onChange={(event) => {
        const next = event.target.value;
        startTransition(async () => {
          try {
            await mutate(`/support/tickets/${id}/status`, "PATCH", { status: next });
            router.refresh();
          } catch {
            router.refresh();
          }
        });
      }}
      style={{ border: "1px solid var(--line)", borderRadius: 6, padding: "3px 6px", fontSize: 12 }}
    >
      <option value="OPEN">OPEN</option>
      <option value="PENDING">PENDING</option>
      <option value="RESOLVED">RESOLVED</option>
    </select>
  );
}

export function BreakGlassForm({
  tenants,
  defaultTenantId,
}: {
  tenants: TenantSummary[];
  defaultTenantId?: string;
}) {
  const { pending, error, success, submit } = useSubmit();
  const [tenantId, setTenantId] = useState(defaultTenantId ?? tenants[0]?.id ?? "");
  const [ticketNo, setTicketNo] = useState("");
  const [reason, setReason] = useState("");
  const [consent, setConsent] = useState(false);

  return (
    <FormShell
      pending={pending}
      error={error}
      success={success}
      submitLabel="申请只读授权"
      onSubmit={(event) => {
        event.preventDefault();
        submit(
          "/break-glass",
          "POST",
          { tenantId, ticketNo, reason, tenantConsent: consent },
          "申请已提交；需租户同意 + 第二位 owner 复核",
        );
      }}
    >
      <div className="form row">
        <div className="field">
          <label>租户</label>
          <select value={tenantId} onChange={(event) => setTenantId(event.target.value)}>
            {tenants.map((tenant) => (
              <option key={tenant.id} value={tenant.id}>
                {tenant.name}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>工单号</label>
          <input
            required
            value={ticketNo}
            onChange={(event) => setTicketNo(event.target.value)}
            placeholder="TCK-2026-001"
          />
        </div>
      </div>
      <div className="field">
        <label>原因</label>
        <textarea
          required
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          placeholder="客户反馈报价单金额异常，需要核对单据"
        />
      </div>
      <label className="check">
        <input
          type="checkbox"
          checked={consent}
          onChange={(event) => setConsent(event.target.checked)}
        />{" "}
        租户管理员已在应用内 / 工单中明确同意（没有同意不能申请业务数据授权）
      </label>
    </FormShell>
  );
}

export function BreakGlassAccess({ id }: { id: string }) {
  return (
    <ActionButton
      label="记录一次只读访问"
      path={`/break-glass/${id}/access`}
      body={{ resource: "quote-detail (grant only; no control-plane data)" }}
      confirmText="控制台不会返回任何业务数据；本次访问只写平台审计。继续？"
    />
  );
}

export type { BreakGlassRequest };

/**
 * 开通链接：平台开通公司后，把这条链接发给客户老板。
 * 客户打开 → 用统一账号登录 → 公司空间当场建好，不需要我们进数据库。
 */
export function OnboardingLinkPanel({
  tenantId,
  ownerEmail,
}: {
  tenantId: string;
  ownerEmail: string | null;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [link, setLink] = useState<{ url: string; expiresAt: string } | null>(null);

  const generate = () => {
    setError(null);
    startTransition(async () => {
      try {
        const result = await mutate<{ url: string; expiresAt: string }>(
          `/tenants/${tenantId}/onboarding-link`,
          "POST",
        );
        setLink({ url: result.url, expiresAt: result.expiresAt });
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "生成开通链接失败");
      }
    });
  };

  const copy = async () => {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link.url);
    } catch {
      setError("复制失败，请手动选中链接复制");
    }
  };

  return (
    <div className="card" style={{ marginTop: 16 }}>
      <div className="between" style={{ alignItems: "flex-start", gap: 16 }}>
        <div>
          <div style={{ fontWeight: 600 }}>开通链接</div>
          <p className="small muted" style={{ margin: "6px 0 0", maxWidth: "46em" }}>
            发给客户老板，让他用统一账号登录。打开后公司空间当场建好，他自动成为老板；
            {ownerEmail
              ? `链接会核对登录邮箱必须是 ${ownerEmail}。`
              : "该租户没填联系人邮箱，链接不校验邮箱，请确认收件人。"}
          </p>
        </div>
        <button
          type="button"
          className="btn btn-primary btn-sm"
          disabled={pending}
          onClick={generate}
        >
          {pending ? "生成中…" : link ? "重新生成" : "生成开通链接"}
        </button>
      </div>

      {link ? (
        <div style={{ marginTop: 12 }}>
          <div className="field">
            <label>链接（7 天内有效）</label>
            <input readOnly value={link.url} onFocus={(event) => event.currentTarget.select()} />
          </div>
          <div className="btn-row">
            <button type="button" className="btn btn-sm" onClick={() => void copy()}>
              复制链接
            </button>
            <a className="btn btn-sm btn-ghost" href={link.url} target="_blank" rel="noreferrer">
              自己先打开看看
            </a>
            <span className="tiny muted">
              到期：{new Date(link.expiresAt).toLocaleString("zh-CN")}
            </span>
          </div>
        </div>
      ) : null}

      {error ? (
        <p className="tiny" style={{ color: "var(--danger)", marginTop: 8 }}>
          {error}
        </p>
      ) : null}
    </div>
  );
}
