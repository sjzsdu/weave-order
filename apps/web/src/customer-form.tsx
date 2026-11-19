"use client";

import { useState } from "react";
import type { ReactNode } from "react";
import type { Customer, CustomerTierCode } from "@weave-order/schema";
import { ApiError } from "@weave-order/core";
import { Button } from "@weave-order/ui";
import { useApi } from "@/providers";
import { useFieldOptions } from "@/field-options-manager";

/** 选项接口失败时的兜底：预置四项仍可选，不把新建客户卡死。 */
export const CUSTOMER_TIER_OPTIONS: Array<{ value: CustomerTierCode; label: string }> = [
  { value: "NEW", label: "新客" },
  { value: "REGULAR", label: "常规" },
  { value: "VIP", label: "VIP" },
  { value: "COLD", label: "沉睡" },
];

export interface CustomerDraft {
  name: string;
  tier: CustomerTierCode;
  contactName: string;
  contactPhone: string;
  contactEmail: string;
}

export type CustomerDraftErrors = Partial<Record<keyof CustomerDraft, string>>;

export const EMPTY_CUSTOMER_DRAFT: CustomerDraft = {
  name: "",
  tier: "NEW",
  contactName: "",
  contactPhone: "",
  contactEmail: "",
};

const PHONE_PATTERN = /^[0-9+\-\s()]{5,32}$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** 工作台没有全局 `.input` 工具类，字段样式显式写在这里，避免样式悄悄丢失。 */
const FIELD_CLASS =
  "min-h-10 w-full rounded-md border border-line bg-surface px-3 text-sm text-ink-900 outline-none focus:border-indigo-600";

/** 字段级校验：只在有值时校验可选字段，避免「可选」变成事实上的必填。 */
export function validateCustomerDraft(draft: CustomerDraft): CustomerDraftErrors {
  const errors: CustomerDraftErrors = {};
  const name = draft.name.trim();
  if (!name) errors.name = "客户名称必填";
  else if (name.length > 255) errors.name = "客户名称最多 255 个字";

  // 新建客户必须先登记第一位联系人：这是「至少一位主联系人」的应用层保证，
  // 否则新客户在 360 里既没有主联系人、也没有默认外发对象。
  if (!draft.contactName.trim()) errors.contactName = "请先填第一位联系人的姓名";
  if (draft.contactPhone.trim() && !PHONE_PATTERN.test(draft.contactPhone.trim())) {
    errors.contactPhone = "手机号里请只填数字、空格、+ - ()";
  }
  if (draft.contactEmail.trim() && !EMAIL_PATTERN.test(draft.contactEmail.trim())) {
    errors.contactEmail = "邮箱格式不对，例如 zhou@example.com";
  }
  return errors;
}

/** 失败必须说人话：网络错误、校验错误、编号冲突分开讲。 */
export function customerSubmitError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === "CUSTOMER_CODE_EXISTS") {
      return "客户编号冲突了，再点一次「建客户」，系统会换一个编号。";
    }
    if (error.status === 401) return "登录已过期，请重新登录后再建客户。";
    if (error.status === 403) return "当前角色没有建客户的权限。";
    return error.message;
  }
  if (error instanceof Error && error.message) return error.message;
  return "客户没建成，请稍后重试。表单内容还在。";
}

/**
 * 新建客户抽屉。
 *
 * 不要求用户填客户编号：编号由服务端按日期生成，前端只收业务字段。
 * 提交中按钮 loading，失败就地红条并保留所有输入。
 */
export function CustomerForm({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (customer: Customer) => void;
}) {
  const api = useApi();
  const { options: tierOptions, error: tierError } = useFieldOptions("customer.tier");
  const [draft, setDraft] = useState<CustomerDraft>(EMPTY_CUSTOMER_DRAFT);
  const [errors, setErrors] = useState<CustomerDraftErrors>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const update = <K extends keyof CustomerDraft>(key: K, value: CustomerDraft[K]) => {
    setDraft((current) => ({ ...current, [key]: value }));
    setErrors((current) => ({ ...current, [key]: undefined }));
  };

  const activeTiers = tierOptions.filter((option) => option.active);
  // 兜底 + 保证当前值一定在下拉里（自定义等级或接口失败时不会变成空白选项）。
  const tierChoices =
    activeTiers.length > 0
      ? activeTiers.map((option) => ({ value: option.code, label: option.label }))
      : CUSTOMER_TIER_OPTIONS;
  const choicesWithCurrent = tierChoices.some((choice) => choice.value === draft.tier)
    ? tierChoices
    : [{ value: draft.tier, label: draft.tier }, ...tierChoices];

  async function submit() {
    if (busy) return;
    const found = validateCustomerDraft(draft);
    setErrors(found);
    if (Object.keys(found).length > 0) return;

    setBusy(true);
    setSubmitError(null);
    try {
      const customer = await api.createCustomer({
        name: draft.name.trim(),
        tier: draft.tier,
        ...(draft.contactName.trim() ? { contactName: draft.contactName.trim() } : {}),
        ...(draft.contactPhone.trim() ? { contactPhone: draft.contactPhone.trim() } : {}),
        ...(draft.contactEmail.trim() ? { contactEmail: draft.contactEmail.trim() } : {}),
      });
      onCreated(customer);
    } catch (caught) {
      setSubmitError(customerSubmitError(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="新建客户"
      className="fixed inset-0 z-40 flex justify-end bg-ink-900/20"
      onClick={busy ? undefined : onClose}
    >
      <form
        className="flex h-full w-full max-w-[520px] flex-col overflow-y-auto bg-surface shadow-xl"
        onClick={(event) => event.stopPropagation()}
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <header className="flex items-center justify-between border-b border-line px-5 py-4">
          <div>
            <h2 className="text-base font-semibold text-ink-900">新建客户</h2>
            <p className="mt-0.5 text-xs text-ink-400">
              编号自动生成；客户名与第一位联系人必填。
            </p>
          </div>
          <Button
            variant="ghost"
            className="min-h-9 px-3 text-xs"
            onClick={onClose}
            disabled={busy}
          >
            关闭
          </Button>
        </header>

        <div className="grid gap-4 px-5 py-5">
          {submitError && (
            <p
              role="alert"
              className="rounded-md border border-vermilion-600/40 bg-vermilion-600/10 px-3 py-2 text-sm text-vermilion-600"
            >
              {submitError}
            </p>
          )}

          <Field label="客户名称" required error={errors.name}>
            <input
              autoFocus
              value={draft.name}
              onChange={(event) => update("name", event.target.value)}
              className={FIELD_CLASS}
              placeholder="例如 杭州青禾服饰"
              aria-invalid={errors.name ? true : undefined}
            />
          </Field>

          <Field label="等级" error={errors.tier}>
            <select
              value={draft.tier}
              onChange={(event) => update("tier", event.target.value)}
              className={FIELD_CLASS}
            >
              {choicesWithCurrent.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            {tierError && (
              <p className="mt-1 text-xs text-amber-700">等级选项没加载出来，先用默认四项。</p>
            )}
          </Field>

          <Field label="联系人" required error={errors.contactName}>
            <input
              value={draft.contactName}
              onChange={(event) => update("contactName", event.target.value)}
              className={FIELD_CLASS}
              placeholder="例如 周敏"
            />
          </Field>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="手机" error={errors.contactPhone}>
              <input
                value={draft.contactPhone}
                onChange={(event) => update("contactPhone", event.target.value)}
                className={FIELD_CLASS}
                inputMode="tel"
                placeholder="13800000000"
              />
            </Field>
            <Field label="邮箱" error={errors.contactEmail}>
              <input
                value={draft.contactEmail}
                onChange={(event) => update("contactEmail", event.target.value)}
                className={FIELD_CLASS}
                inputMode="email"
                placeholder="zhou@example.com"
              />
            </Field>
          </div>
        </div>

        <footer className="mt-auto flex items-center justify-end gap-2 border-t border-line px-5 py-4">
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button type="submit" variant="primary" disabled={busy}>
            {busy ? "正在建客户…" : "建客户"}
          </Button>
        </footer>
      </form>
    </div>
  );
}

function Field({
  label,
  required,
  error,
  children,
}: {
  label: string;
  required?: boolean;
  error?: string;
  children: ReactNode;
}) {
  return (
    <label className="grid gap-1.5 text-sm text-ink-700">
      <span>
        {label}
        {required && <span className="ml-0.5 text-vermilion-600">*</span>}
      </span>
      {children}
      {error && <span className="text-xs text-vermilion-600">{error}</span>}
    </label>
  );
}
