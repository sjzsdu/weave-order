"use client";

import { useRouter } from "next/navigation";
import { useEffect, useId, useMemo, useRef, useState, useTransition } from "react";
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
import { toFormError, toErrorMessage, type FormError } from "./api-error";
import { currentMonthRange } from "./format";
import { describeJsonError } from "./json-error";
import { featureFlagPayload, validateFeatureFlagDraft } from "./feature-flag";
import { CheckboxField, Field, FieldContextProvider } from "./form-field";
import { collectFormIssues, focusField, summaryText, type FieldIssue } from "./form-validation";
import { Time } from "./time";

type Method = "POST" | "PATCH" | "PUT" | "DELETE";

/** 统一动作按钮：成功后刷新服务端组件，失败展示映射后的中文错误。 */
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
  const [error, setError] = useState<FormError | null>(null);

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
        setError(toFormError(cause));
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
        title={error?.message}
      >
        {pending ? "处理中…" : label}
      </button>
      {error ? (
        <span className="tiny" style={{ color: "var(--danger)", marginLeft: 6 }} role="alert">
          {error.message}
        </span>
      ) : null}
    </span>
  );
}

function ErrorLine({ error }: { error: FormError | null }) {
  if (!error) return null;
  return (
    <div className="alert alert-error" role="alert" aria-live="polite" style={{ margin: 0 }}>
      <p style={{ margin: 0 }}>{error.message}</p>
      {error.fields.length > 0 ? (
        <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
          {error.fields.map((field) => (
            <li key={`${field.label}-${field.message}`}>
              <strong>{field.label}</strong>：{field.message}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
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
  validate,
  onCancel,
}: {
  children: React.ReactNode;
  onSubmit: (event: React.FormEvent<HTMLFormElement>) => void;
  submitLabel: string;
  pending: boolean;
  error: FormError | null;
  success?: string | null;
  /** 前置条件不满足时禁用提交（例如还没有任何套餐）。 */
  disabled?: boolean;
  hint?: string | null;
  /** 原生约束校验之外的表单级规则（日期区间、JSON 解析等）。 */
  validate?: () => FieldIssue[];
  onCancel?: () => void;
}) {
  const idPrefix = useId();
  const formRef = useRef<HTMLFormElement>(null);
  const [issues, setIssues] = useState<FieldIssue[]>([]);
  const errors = useMemo(
    () => Object.fromEntries(issues.map((issue) => [issue.name, issue.message])),
    [issues],
  );

  // 用户一改输入，旧的服务端错误就应该消失：否则改完仍看到过期提示，不知道是否已经改对。
  const lastError = useRef(error);
  const [dirtySinceError, setDirtySinceError] = useState(false);
  useEffect(() => {
    if (lastError.current !== error) {
      lastError.current = error;
      setDirtySinceError(false);
    }
  }, [error]);
  const visibleError = dirtySinceError ? null : error;

  // 关闭原生校验气泡（noValidate），先收集全部字段错误再决定是否提交，
  // 这样用户一次能看到所有问题，而不是被逐个字段的原生提示打断。
  const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const found = [...collectFormIssues(form), ...(validate?.() ?? [])];
    if (found.length > 0) {
      setIssues(found);
      focusField(form, found[0]!.name);
      return;
    }
    setIssues([]);
    onSubmit(event);
  };

  // 用户修正某个字段后立即清掉它的错误，避免旧提示一直挂着。
  const handleChange = (event: React.FormEvent<HTMLFormElement>) => {
    setDirtySinceError(true);
    const name = (event.target as HTMLInputElement | null)?.name;
    if (!name) return;
    setIssues((current) =>
      current.some((issue) => issue.name === name)
        ? current.filter((issue) => issue.name !== name)
        : current,
    );
  };

  return (
    <FieldContextProvider idPrefix={idPrefix} errors={errors}>
      <form
        ref={formRef}
        className="form"
        noValidate
        onSubmit={handleSubmit}
        onChange={handleChange}
      >
        {issues.length > 0 ? (
          <div className="alert alert-error form-error-summary" role="alert">
            <strong>{summaryText(issues.length)}</strong>
            <ul>
              {issues.map((issue) => (
                <li key={issue.name}>
                  <button
                    type="button"
                    className="summary-link"
                    onClick={() => focusField(formRef.current, issue.name)}
                  >
                    {issue.message}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {children}
        {hint ? (
          <p className="alert alert-info" style={{ margin: 0 }}>
            {hint}
          </p>
        ) : null}
        <ErrorLine error={visibleError} />
        {success ? (
          <p className="alert alert-ok" style={{ margin: 0 }}>
            {success}
          </p>
        ) : null}
        <div className="btn-row">
          {onCancel ? (
            <button className="btn btn-ghost" type="button" onClick={onCancel} disabled={pending}>
              取消
            </button>
          ) : null}
          <button className="btn btn-primary" type="submit" disabled={pending || disabled}>
            {pending ? "提交中…" : submitLabel}
          </button>
        </div>
      </form>
    </FieldContextProvider>
  );
}

function useSubmit(onSuccess?: () => void) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<FormError | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const submit = (path: string, method: Method, body: unknown, message: string) => {
    setError(null);
    setSuccess(null);
    startTransition(async () => {
      try {
        await mutate(path, method, body);
        onSuccess?.();
        setSuccess(message);
        router.refresh();
      } catch (cause) {
        setError(toFormError(cause));
      }
    });
  };
  const clearError = () => setError(null);
  return { pending, error, success, submit, clearError };
}

/* --------------------------- 开通公司 --------------------------- */

export function ProvisionTenantForm({
  plans,
  onSuccess,
  onCancel,
}: {
  plans: Plan[];
  onSuccess?: () => void;
  onCancel?: () => void;
}) {
  const router = useRouter();
  const { pending, error, success, submit } = useSubmit(() => {
    onSuccess?.();
    // 新租户可能不符合旧筛选条件；回到完整目录，确保创建结果立即可见。
    router.replace("/tenants");
  });
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
      onCancel={onCancel}
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
        <Field label="公司名称" name="name" required>
          <input required value={form.name} onChange={set("name")} placeholder="例如：青禾纺织" />
        </Field>
        <Field
          label="租户标识（slug）"
          name="slug"
          required
          hint="2–64 位小写字母、数字或连字符，创建后不可修改。"
        >
          <input
            required
            minLength={2}
            maxLength={64}
            pattern="[a-z0-9-]+"
            title="只允许小写字母、数字和连字符"
            value={form.slug}
            onChange={set("slug")}
            placeholder="qinghe"
          />
        </Field>
        <Field
          label="套餐"
          name="planCode"
          required={!noPlans}
          hint={noPlans ? "请先在「套餐与价格」创建套餐。" : undefined}
        >
          <select
            value={form.planCode}
            onChange={set("planCode")}
            disabled={noPlans}
            required={!noPlans}
          >
            {noPlans ? <option value="">暂无可用套餐</option> : null}
            {plans.map((plan) => (
              <option key={plan.code} value={plan.code}>
                {plan.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="席位数" name="seats" required>
          <input
            type="number"
            min={1}
            max={10000}
            value={form.seats}
            onChange={set("seats")}
            required
          />
        </Field>
        <Field label="账期" name="billingCycle">
          <select value={form.billingCycle} onChange={set("billingCycle")}>
            <option value="MONTHLY">月付</option>
            <option value="ANNUAL">年付</option>
          </select>
        </Field>
        <Field label="试用天数" name="trialDays">
          <input
            type="number"
            min={0}
            max={90}
            value={form.trialDays}
            onChange={set("trialDays")}
          />
        </Field>
        <Field label="隔离模式" name="isolationMode">
          <select value={form.isolationMode} onChange={set("isolationMode")}>
            <option value="SHARED_RLS">共享库 + RLS</option>
            <option value="SCHEMA">独立 schema</option>
            <option value="DATABASE">独立数据库</option>
          </select>
        </Field>
        <Field label="区域" name="region">
          <select value={form.region} onChange={set("region")}>
            <option value="cn-east">华东</option>
            <option value="cn-north">华北</option>
            <option value="cn-south">华南</option>
            <option value="hk">香港</option>
          </select>
        </Field>
        <Field label="联系人" name="contactName">
          <input value={form.contactName} onChange={set("contactName")} placeholder="王经理" />
        </Field>
        <Field label="联系邮箱" name="contactEmail">
          <input
            type="email"
            value={form.contactEmail}
            onChange={set("contactEmail")}
            placeholder="contact@example.com"
          />
        </Field>
      </div>
      <Field label="备注" name="notes">
        <textarea value={form.notes} onChange={set("notes")} placeholder="仅平台内部可见" />
      </Field>
    </FormShell>
  );
}

export function ProvisionTenantDialog({
  plans,
  defaultOpen = false,
}: {
  plans: Plan[];
  defaultOpen?: boolean;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  const close = () => dialogRef.current?.close();

  useEffect(() => {
    const dialog = dialogRef.current;
    if (defaultOpen && dialog && !dialog.open) dialog.showModal();
  }, [defaultOpen]);

  return (
    <>
      <button
        className="btn btn-primary"
        type="button"
        disabled={plans.length === 0}
        onClick={() => dialogRef.current?.showModal()}
      >
        开通公司
      </button>
      <dialog
        ref={dialogRef}
        className="modal provision-dialog"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
      >
        <div className="modal-head">
          <div>
            <h2 id={titleId}>开通公司</h2>
            <p id={descriptionId}>
              新建租户账号与试用订阅，仅写控制面，不会创建或读取任何业务数据。
            </p>
          </div>
          <button className="modal-close" type="button" aria-label="关闭" onClick={close}>
            ×
          </button>
        </div>
        <ProvisionTenantForm plans={plans} onSuccess={close} onCancel={close} />
      </dialog>
    </>
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
        <Field label="套餐" name="planCode">
          <select value={planCode} onChange={(event) => setPlanCode(event.target.value)}>
            {plans.map((plan) => (
              <option key={plan.code} value={plan.code}>
                {plan.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="席位" name="seats" required>
          <input
            type="number"
            min={1}
            max={10000}
            value={seats}
            onChange={(event) => setSeats(event.target.value)}
            required
          />
        </Field>
        <Field label="账期" name="billingCycle">
          <select value={cycle} onChange={(event) => setCycle(event.target.value)}>
            <option value="MONTHLY">月付</option>
            <option value="ANNUAL">年付</option>
          </select>
        </Field>
      </div>
      <div className="form row">
        <Field
          label="强制定价（元/席/月，可空）"
          name="forcePrice"
          hint="填写后不会立即生效，会创建 owner 双人复核。"
        >
          <input
            type="number"
            min={0}
            step="0.01"
            value={forcePrice}
            onChange={(event) => setForcePrice(event.target.value)}
            placeholder="留空按标准价"
          />
        </Field>
        <Field label="合同价原因" name="forceReason">
          <input
            value={forceReason}
            onChange={(event) => setForceReason(event.target.value)}
            placeholder="三年锁价 / 试点价"
          />
        </Field>
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
  const { start, end } = currentMonthRange();
  const [tenantId, setTenantId] = useState(defaultTenantId ?? tenants[0]?.id ?? "");
  const [periodStart, setPeriodStart] = useState(start);
  const [periodEnd, setPeriodEnd] = useState(end);
  const [notes, setNotes] = useState("");

  return (
    <FormShell
      pending={pending}
      error={error}
      success={success}
      submitLabel="生成账单草稿"
      validate={() =>
        periodStart && periodEnd && periodEnd < periodStart
          ? [{ name: "periodEnd", message: "「账期结束」不能早于账期开始" }]
          : []
      }
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
        <Field label="租户" name="tenantId" required>
          <select
            value={tenantId}
            onChange={(event) => setTenantId(event.target.value)}
            required
            data-error-message={
              tenants.length === 0 ? "尚无租户，请先到「租户」开通公司" : undefined
            }
          >
            {tenants.map((tenant) => (
              <option key={tenant.id} value={tenant.id}>
                {tenant.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="账期开始" name="periodStart" required>
          <input
            type="date"
            value={periodStart}
            onChange={(event) => setPeriodStart(event.target.value)}
            required
          />
        </Field>
        <Field label="账期结束" name="periodEnd" required>
          <input
            type="date"
            value={periodEnd}
            onChange={(event) => setPeriodEnd(event.target.value)}
            required
          />
        </Field>
        <Field label="备注" name="notes">
          <input
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
            placeholder="可选"
          />
        </Field>
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
        aria-label="复核意见（可选）"
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
        <Field
          label="套餐代码"
          name="code"
          required
          hint="大写字母、数字和下划线；创建后不可修改。"
        >
          <input
            required
            value={form.code}
            onChange={set("code")}
            placeholder="GROWTH"
            pattern="[A-Za-z][A-Za-z0-9_]*"
            title="以字母开头，只允许字母、数字和下划线"
          />
        </Field>
        <Field label="套餐名称" name="name" required>
          <input required value={form.name} onChange={set("name")} placeholder="成长版 Growth" />
        </Field>
        <Field label="档位" name="tier" hint="数值越大档位越高，用于排序与功能分层。">
          <input type="number" min={0} max={9} value={form.tier} onChange={set("tier")} />
        </Field>
      </div>
      <div className="form row">
        <Field label="内含席位" name="seatMin">
          <input type="number" min={0} value={form.seatMin} onChange={set("seatMin")} />
        </Field>
        <Field label="席位上限定（留空不限）" name="seatMax">
          <input type="number" min={1} value={form.seatMax} onChange={set("seatMax")} />
        </Field>
        <Field label="每月 credits" name="credits">
          <input type="number" min={0} value={form.credits} onChange={set("credits")} />
        </Field>
        <Field label="存储（GB）" name="storageGb">
          <input type="number" min={0} value={form.storageGb} onChange={set("storageGb")} />
        </Field>
      </div>
      <fieldset className="field">
        <legend>功能开关</legend>
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
      </fieldset>
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
                    name={`${plan.code}-monthly`}
                    aria-label={`${plan.name} 月付单价`}
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
                    name={`${plan.code}-annual`}
                    aria-label={`${plan.name} 年付单价`}
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
      <Field label="版本说明" name="notes">
        <input
          value={notes}
          onChange={(event) => setNotes(event.target.value)}
          placeholder="例如：2027 年调价，仅影响新合同"
        />
      </Field>
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
  const [error, setError] = useState<FormError | null>(null);
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
      onInput={() => setError(null)}
      onChange={() => setError(null)}
      onSubmit={(event) => {
        event.preventDefault();
        setError(null);
        startTransition(async () => {
          try {
            const body = await mutate<{
              monthlyTotalCents?: number;
              annualTotalCents?: number;
              effectiveMonthlyCents?: number;
            }>("/pricing/preview", "POST", {
              planCode,
              seats: Number(seats),
              billingCycle: cycle,
              monthlyPriceCents: monthly ? Math.round(Number(monthly) * 100) : undefined,
            });
            setResult({
              monthlyTotalCents: body.monthlyTotalCents ?? 0,
              annualTotalCents: body.annualTotalCents ?? 0,
              effectiveMonthlyCents: body.effectiveMonthlyCents ?? 0,
            });
          } catch (cause) {
            setError(toFormError(cause));
          }
        });
      }}
    >
      <div className="form row">
        <Field label="套餐" name="preview-plan">
          <select value={planCode} onChange={(event) => setPlanCode(event.target.value)}>
            {plans.map((plan) => (
              <option key={plan.code} value={plan.code}>
                {plan.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="席位" name="preview-seats">
          <input
            type="number"
            min={1}
            value={seats}
            onChange={(event) => setSeats(event.target.value)}
          />
        </Field>
        <Field label="账期" name="preview-cycle">
          <select value={cycle} onChange={(event) => setCycle(event.target.value)}>
            <option value="MONTHLY">月付</option>
            <option value="ANNUAL">年付</option>
          </select>
        </Field>
        <Field label="覆盖月价（元/席，可空）" name="preview-monthly">
          <input
            type="number"
            min={0}
            step="0.01"
            value={monthly}
            onChange={(event) => setMonthly(event.target.value)}
            placeholder="按生效价格表"
          />
        </Field>
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
        <Field label="发票类型" name="invoiceType">
          <select value={form.invoiceType} onChange={set("invoiceType")}>
            <option value="VAT_SPECIAL">电子增值税专用发票</option>
            <option value="VAT_NORMAL">增值税普通发票</option>
            <option value="E_INVOICE">数电票</option>
          </select>
        </Field>
        <Field label="税率（基点，600 = 6%）" name="taxRateBp">
          <input
            type="number"
            min={0}
            max={10000}
            value={form.taxRateBp}
            onChange={set("taxRateBp")}
          />
        </Field>
        <Field label="价格展示" name="priceDisplay">
          <select value={form.priceDisplay} onChange={set("priceDisplay")}>
            <option value="TAX_EXCLUSIVE">价税分离</option>
            <option value="TAX_INCLUSIVE">含税价</option>
          </select>
        </Field>
      </div>
      <div className="form row">
        <Field label="开票主体" name="issuerEntity">
          <input value={form.issuerEntity} onChange={set("issuerEntity")} />
        </Field>
        <Field label="开票时机" name="issueTiming">
          <select value={form.issueTiming} onChange={set("issueTiming")}>
            <option value="AFTER_PAYMENT_3D">收款后 3 个工作日</option>
            <option value="AFTER_PAYMENT">收款后</option>
            <option value="BEFORE_PAYMENT">先票后款（需审批）</option>
          </select>
        </Field>
        <Field label="红冲规则" name="redFlushRule">
          <select value={form.redFlushRule} onChange={set("redFlushRule")}>
            <option value="FINANCE_REVIEW">财务审核</option>
            <option value="OWNER_REVIEW">Owner 审核</option>
          </select>
        </Field>
      </div>
      <Field label="变更原因（改税必填）" name="reason">
        <input
          value={form.reason}
          onChange={set("reason")}
          placeholder="财务确认按 SaaS 服务 6% 开票"
        />
      </Field>
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
  const set =
    (key: keyof typeof form) => (event: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
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
        <Field label="Provider" name="provider">
          <select value={form.provider} onChange={set("provider")}>
            <option value="openai-compatible">openai-compatible（企业网关）</option>
            <option value="local-rule">local-rule（本地规则）</option>
          </select>
        </Field>
        <Field label="OpenAI 兼容企业网关地址" name="baseUrl">
          <input
            value={form.baseUrl}
            onChange={set("baseUrl")}
            placeholder="https://gateway.example.com/v1"
          />
        </Field>
        <Field label="默认模型" name="defaultModel">
          <input value={form.defaultModel} onChange={set("defaultModel")} />
        </Field>
        <Field label="Key 引用（环境变量名）" name="keyRef">
          <input value={form.keyRef} onChange={set("keyRef")} placeholder="LLM_API_KEY" />
        </Field>
        <Field label="日 token 预算" name="dailyTokenBudget">
          <input
            type="number"
            min={0}
            value={form.dailyTokenBudget}
            onChange={set("dailyTokenBudget")}
          />
        </Field>
        <Field label="月 token 预算" name="monthlyTokenBudget">
          <input
            type="number"
            min={0}
            value={form.monthlyTokenBudget}
            onChange={set("monthlyTokenBudget")}
          />
        </Field>
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
  const [model, setModel] = useState(
    settings.find((item) => item.scope === "GLOBAL")?.defaultModel ?? "unconfigured",
  );
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
        <Field label="租户" name="tenantId" required>
          <select
            value={tenantId}
            onChange={(event) => setTenantId(event.target.value)}
            required
            data-error-message={
              tenants.length === 0 ? "尚无租户，请先到「租户」开通公司" : undefined
            }
          >
            {tenants.map((tenant) => (
              <option key={tenant.id} value={tenant.id}>
                {tenant.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="默认模型" name="defaultModel">
          <input value={model} onChange={(event) => setModel(event.target.value)} />
        </Field>
        <Field label="专用网关（可空）" name="baseUrl">
          <input
            value={baseUrl}
            onChange={(event) => setBaseUrl(event.target.value)}
            placeholder={existing?.baseUrl ?? "继承全局"}
          />
        </Field>
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

export function LlmTestButton({ baseUrl, keyRef }: { baseUrl?: string; keyRef?: string }) {
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
              const body = await mutate<{ ok?: boolean; latencyMs?: number; message?: string }>(
                "/settings/llm/test",
                "POST",
                { baseUrl, keyRef: keyRef || "LLM_API_KEY" },
              );
              setResult(
                body.ok
                  ? `连接正常 · ${body.latencyMs}ms`
                  : `连接失败：${readableGatewayMessage(body.message)}`,
              );
            } catch (cause) {
              setResult(`连接失败：${toErrorMessage(cause)}`);
            }
          })
        }
      >
        {pending ? "测试中…" : "测试连接"}
      </button>
      {result ? (
        <div className="tiny muted" style={{ marginTop: 4 }} role="status">
          {result}
        </div>
      ) : null}
    </div>
  );
}

/** 网关探测的失败原因由服务端拼接，可能夹带底层英文；只展示可读的中文部分。 */
function readableGatewayMessage(message?: string): string {
  if (
    !message ||
    !/[\u4e00-\u9fff]/.test(message) ||
    /\b(econn|enotfound|fetch|json)\b/i.test(message)
  ) {
    return "网关不可达，请检查网关地址、白名单与网络";
  }
  return message;
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
      <CheckboxField
        name="mfaRequired"
        checked={mfa}
        onChange={(event) => setMfa(event.target.checked)}
        label="强制 MFA（平台端不可关闭的唯一例外是本地 dev）"
      />
      <CheckboxField
        name="ssoEnabled"
        checked={sso}
        onChange={(event) => setSso(event.target.checked)}
        label="允许企业 SSO（Pro 及以上）"
      />
      <Field label="Casdoor 组织模板" name="casdoorOrgTemplate">
        <input value={template} onChange={(event) => setTemplate(event.target.value)} />
      </Field>
      <Field label="会话最长时长（小时）" name="sessionMaxHours">
        <input
          type="number"
          min={1}
          value={hours}
          onChange={(event) => setHours(event.target.value)}
        />
      </Field>
      <div className="alert alert-warn">
        社交登录在控制面被硬编码禁止（前后端双重校验），不提供开关。
      </div>
    </FormShell>
  );
}

/* --------------------------- 功能开关 --------------------------- */

/** 空环境必须先能创建第一个开关，否则整页只有一个空表（WAN-171）。 */
export function FeatureFlagCreateForm({ defaultOpen }: { defaultOpen: boolean }) {
  const { pending, error, success, submit } = useSubmit();
  // open 由组件自己持有：创建成功后 router.refresh() 会让 defaultOpen 变 false，
  // 若直接绑到 props，表单会立刻收起，连「已创建」提示都看不到。
  const [open, setOpen] = useState(defaultOpen);
  const [key, setKey] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [enabled, setEnabled] = useState(false);
  const [rollout, setRollout] = useState("0");
  const [tenantIds, setTenantIds] = useState("");
  const [problems, setProblems] = useState<{ label: string; message: string }[]>([]);
  // 服务端有校验，这里先挡一遍，让用户在不发请求的情况下看到所有问题。
  const draft = { key, name, description, rollout, tenantIds, enabled };

  return (
    // 空环境默认展开，已有开关时收起来，避免挤压列表。
    <details
      className="card card-toggle"
      id="new-flag"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>
        <span>新建开关</span>
        <span className="tiny muted">key 创建后不可修改，灰度与租户可在列表中随时调整</span>
      </summary>
      <FormShell
        pending={pending}
        error={
          error ??
          (problems.length > 0 ? { message: "请先修正以下内容再提交", fields: problems } : null)
        }
        success={success}
        submitLabel="创建开关"
        onSubmit={(event) => {
          event.preventDefault();
          const found = validateFeatureFlagDraft(draft);
          setProblems(found);
          if (found.length > 0) return;
          submit(
            "/settings/feature-flags",
            "POST",
            featureFlagPayload(draft),
            `已创建「${name.trim()}」`,
          );
        }}
      >
        <div className="form row">
          <div className="field">
            <label htmlFor="flag-key">
              开关 Key <span style={{ color: "var(--danger)" }}>*</span>
            </label>
            <input
              id="flag-key"
              value={key}
              onChange={(event) => setKey(event.target.value)}
              placeholder="billing.overage_preview"
              aria-required="true"
              autoComplete="off"
            />
            <span className="hint">服务端网关按此 key 校验，创建后不可修改。</span>
          </div>
          <div className="field">
            <label htmlFor="flag-name">
              名称 <span style={{ color: "var(--danger)" }}>*</span>
            </label>
            <input
              id="flag-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="超额用量预览"
              aria-required="true"
            />
          </div>
          <div className="field">
            <label htmlFor="flag-rollout">灰度比例（%）</label>
            <input
              id="flag-rollout"
              type="number"
              min={0}
              max={100}
              step={1}
              value={rollout}
              onChange={(event) => setRollout(event.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="flag-tenants">指定租户</label>
            <input
              id="flag-tenants"
              value={tenantIds}
              onChange={(event) => setTenantIds(event.target.value)}
              placeholder="租户 ID，逗号分隔"
            />
          </div>
        </div>
        <div className="field">
          <label htmlFor="flag-description">说明</label>
          <input
            id="flag-description"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder="给运营同事看的用途说明"
          />
        </div>
        <label className="check">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(event) => setEnabled(event.target.checked)}
          />
          创建后立即启用
        </label>
      </FormShell>
    </details>
  );
}

export function FeatureFlagRow({ flag }: { flag: FeatureFlag }) {
  const { pending, error, success, submit } = useSubmit();
  const [enabled, setEnabled] = useState(flag.enabled);
  const [rollout, setRollout] = useState(String(flag.rolloutPercent));
  const [tenantIds, setTenantIds] = useState(flag.tenantIds.join(","));
  const flagTenantIds = flag.tenantIds.join(",");

  // 保存 / 回滚后 router.refresh() 会带来新 props，本地输入要跟着重置，否则页面显示旧值。
  useEffect(() => {
    setEnabled(flag.enabled);
    setRollout(String(flag.rolloutPercent));
    setTenantIds(flagTenantIds);
  }, [flag.key, flag.enabled, flag.rolloutPercent, flagTenantIds]);

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
        {error ? (
          <span style={{ color: "var(--danger)" }} role="alert">
            {error.message}
          </span>
        ) : null}
        {success ? <span style={{ color: "var(--ok)" }}>{success}</span> : null}
        {!error && !success ? "—" : null}
      </td>
      <td>
        <div className="stack" style={{ gap: 6 }}>
          <label className="check">
            <input
              aria-label={`${flag.name} 启用`}
              type="checkbox"
              checked={enabled}
              onChange={(event) => setEnabled(event.target.checked)}
            />{" "}
            启用
          </label>
          <input
            aria-label={`${flag.name} 灰度比例（%）`}
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
            aria-label={`${flag.name} 生效租户 ID（逗号分隔）`}
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
          <button
            className="btn btn-sm btn-ghost"
            type="button"
            disabled={pending}
            title="立即对全部租户关闭此开关，并清空灰度与指定租户"
            onClick={() => {
              if (!window.confirm(`回滚「${flag.name}」会立即对全部租户关闭，确定？`)) return;
              submit(
                `/settings/feature-flags/${flag.key}`,
                "PATCH",
                { enabled: false, rolloutPercent: 0, tenantIds: [] },
                "已回滚",
              );
            }}
          >
            一键回滚
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
  const [preview, setPreview] = useState<null | { kind: "ok" | "error"; text: string }>(null);

  // 改动任意输入就收起旧预览/错误，避免「已经改对了却还看到上一轮报错」。
  const clearPreview = () => setPreview(null);

  return (
    <FormShell
      pending={pending}
      error={error}
      success={success}
      submitLabel="发布新版本"
      validate={() => {
        try {
          JSON.parse(value);
          return [];
        } catch (cause) {
          return [{ name: "value", message: describeJsonError(value, cause) }];
        }
      }}
      onSubmit={(event) => {
        event.preventDefault();
        let parsed: unknown;
        try {
          parsed = JSON.parse(value);
        } catch (cause) {
          setPreview({ kind: "error", text: describeJsonError(value, cause) });
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
        <Field label="配置 Key" name="key" required>
          <input
            required
            value={key}
            onChange={(event) => {
              setKey(event.target.value);
              clearPreview();
            }}
            placeholder="billing.overage_unit_cents"
          />
        </Field>
        <Field label="作用域" name="scope">
          <select
            value={scope}
            onChange={(event) => {
              setScope(event.target.value);
              clearPreview();
            }}
          >
            <option value="GLOBAL">全局</option>
            <option value="PLAN">套餐</option>
            <option value="TENANT">租户</option>
          </select>
        </Field>
        <Field
          label="作用域引用"
          name="scopeRef"
          hint={scope === "GLOBAL" ? "全局配置不需要引用。" : "套餐代码或租户 ID。"}
        >
          <input
            value={scopeRef}
            onChange={(event) => {
              setScopeRef(event.target.value);
              clearPreview();
            }}
            disabled={scope === "GLOBAL"}
            placeholder="PRO / tenant-id"
          />
        </Field>
      </div>
      <Field label="JSON 值" name="value">
        <textarea
          value={value}
          onChange={(event) => {
            setValue(event.target.value);
            clearPreview();
          }}
          aria-describedby={preview?.kind === "error" ? "config-json-error" : undefined}
        />
      </Field>
      {preview ? (
        <div
          id={preview.kind === "error" ? "config-json-error" : undefined}
          className={preview.kind === "error" ? "alert alert-error" : "alert alert-ok"}
          role={preview.kind === "error" ? "alert" : "status"}
          aria-live="polite"
        >
          {preview.text}
        </div>
      ) : null}
      <div className="btn-row">
        <button
          className="btn btn-sm"
          type="button"
          onClick={() => {
            void (async () => {
              let parsed: unknown;
              try {
                parsed = JSON.parse(value);
              } catch (cause) {
                setPreview({ kind: "error", text: describeJsonError(value, cause) });
                return;
              }
              try {
                const body = await mutate<{ affectedTenants?: number; before?: unknown }>(
                  "/settings/configs/preview",
                  "POST",
                  {
                    key,
                    scope,
                    scopeRef: scope === "GLOBAL" ? null : scopeRef || null,
                    value: parsed,
                  },
                );
                setPreview({
                  kind: "ok",
                  text: `影响租户 ${body.affectedTenants ?? 0} 家 · 变更前：${JSON.stringify(body.before)?.slice(0, 120) ?? "无"}`,
                });
              } catch (cause) {
                const info = toFormError(cause);
                const detail = info.fields
                  .map((field) => `${field.label}：${field.message}`)
                  .join("；");
                setPreview({
                  kind: "error",
                  text: detail ? `${info.message}（${detail}）` : info.message,
                });
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
        <Field
          label="租户"
          name="tenantId"
          required
          hint={tenants.length === 0 ? "尚无租户，请先到「租户」开通公司。" : undefined}
        >
          <select
            value={tenantId}
            onChange={(event) => setTenantId(event.target.value)}
            required
            data-error-message={
              tenants.length === 0 ? "尚无租户，请先到「租户」开通公司" : undefined
            }
          >
            {tenants.map((tenant) => (
              <option key={tenant.id} value={tenant.id}>
                {tenant.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="优先级" name="priority">
          <select value={priority} onChange={(event) => setPriority(event.target.value)}>
            <option value="LOW">低</option>
            <option value="NORMAL">普通</option>
            <option value="HIGH">高</option>
            <option value="URGENT">紧急</option>
          </select>
        </Field>
        <Field label="标题" name="title" required>
          <input required value={title} onChange={(event) => setTitle(event.target.value)} />
        </Field>
      </div>
      <Field label="描述" name="body" required>
        <textarea required value={body} onChange={(event) => setBody(event.target.value)} />
      </Field>
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
      aria-label="工单状态"
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
        <Field
          label="租户"
          name="tenantId"
          required
          hint={tenants.length === 0 ? "尚无租户，请先到「租户」开通公司。" : undefined}
        >
          <select
            value={tenantId}
            onChange={(event) => setTenantId(event.target.value)}
            required
            data-error-message={
              tenants.length === 0 ? "尚无租户，请先到「租户」开通公司" : undefined
            }
          >
            {tenants.map((tenant) => (
              <option key={tenant.id} value={tenant.id}>
                {tenant.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="工单号" name="ticketNo" required>
          <input
            required
            value={ticketNo}
            onChange={(event) => setTicketNo(event.target.value)}
            placeholder="TCK-2026-001"
          />
        </Field>
      </div>
      <Field label="原因" name="reason" required>
        <textarea
          required
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          placeholder="客户反馈报价单金额异常，需要核对单据"
        />
      </Field>
      <CheckboxField
        name="tenantConsent"
        required
        checked={consent}
        onChange={(event) => setConsent(event.target.checked)}
        label="租户管理员已在应用内 / 工单中明确同意（没有同意不能申请业务数据授权）"
        errorMessage="请先取得租户同意再申请只读授权"
      />
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
  const [error, setError] = useState<FormError | null>(null);
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
        setError(toFormError(cause));
      }
    });
  };

  const copy = async () => {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link.url);
    } catch {
      setError({ message: "复制失败，请手动选中链接复制", fields: [] });
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
          <Field label="链接（7 天内有效）" name="onboarding-link">
            <input readOnly value={link.url} onFocus={(event) => event.currentTarget.select()} />
          </Field>
          <div className="btn-row">
            <button type="button" className="btn btn-sm" onClick={() => void copy()}>
              复制链接
            </button>
            <a className="btn btn-sm btn-ghost" href={link.url} target="_blank" rel="noreferrer">
              自己先打开看看
            </a>
            <span className="tiny muted">
              到期：
              <Time value={link.expiresAt} />
            </span>
          </div>
        </div>
      ) : null}

      {error ? (
        <p className="tiny" style={{ color: "var(--danger)", marginTop: 8 }} role="alert">
          {error.message}
        </p>
      ) : null}
    </div>
  );
}
