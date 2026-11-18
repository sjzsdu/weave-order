"use client";

import { cloneElement, createContext, isValidElement, useContext } from "react";
import type { ChangeEvent, ReactNode } from "react";

/**
 * 字段容器：统一 label 关联、必填标识、字段级错误与 aria 状态。
 * 错误来源是 FormShell 的校验状态（按 name 索引），因此各表单不需要自己维护。
 */

type FieldContextValue = {
  idPrefix: string;
  errors: Record<string, string>;
};

const FieldContext = createContext<FieldContextValue>({ idPrefix: "field", errors: {} });

export function FieldContextProvider({
  idPrefix,
  errors,
  children,
}: FieldContextValue & { children: ReactNode }) {
  return <FieldContext.Provider value={{ idPrefix, errors }}>{children}</FieldContext.Provider>;
}

type ControlProps = {
  id?: string;
  name?: string;
  "aria-required"?: boolean;
  "aria-invalid"?: boolean;
  "aria-describedby"?: string;
};

function withFieldAria(
  children: ReactNode,
  id: string,
  name: string,
  required: boolean,
  hasError: boolean,
  describedBy?: string,
) {
  if (!isValidElement<ControlProps>(children)) return children;
  return cloneElement(children, {
    id,
    name,
    "aria-required": required || undefined,
    "aria-invalid": hasError || undefined,
    "aria-describedby": describedBy,
  });
}

export function Field({
  label,
  name,
  required = false,
  hint,
  children,
}: {
  label: string;
  name: string;
  required?: boolean;
  hint?: ReactNode;
  children: ReactNode;
}) {
  const { idPrefix, errors } = useContext(FieldContext);
  const id = `${idPrefix}-${name}`;
  const error = errors[name];
  // 出错时 hint 不渲染，因此不能把它算进 aria-describedby，否则会指向不存在的节点。
  const showHint = Boolean(hint) && !error;
  const hintId = showHint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  // 保留控件自己声明的描述节点（例如配置页的 JSON 预览错误），再合并当前确实存在的提示。
  const childDescribedBy = isValidElement<ControlProps>(children)
    ? children.props["aria-describedby"]
    : undefined;
  const describedBy = [childDescribedBy, hintId, errorId].filter(Boolean).join(" ") || undefined;

  return (
    <div className="field">
      <label htmlFor={id}>
        {label}
        {required ? (
          <span className="field-required" aria-hidden="true">
            *
          </span>
        ) : null}
      </label>
      {withFieldAria(children, id, name, required, Boolean(error), describedBy)}
      {showHint ? (
        <span className="hint" id={hintId}>
          {hint}
        </span>
      ) : null}
      {error ? (
        <span className="field-error" id={errorId} role="alert">
          {error}
        </span>
      ) : null}
    </div>
  );
}

/** 复选框行：勾选框本身无法套用 .field 的上下布局，单独提供错误位。 */
export function CheckboxField({
  name,
  label,
  checked,
  onChange,
  required = false,
  errorMessage,
}: {
  name: string;
  label: ReactNode;
  checked: boolean;
  onChange: (event: ChangeEvent<HTMLInputElement>) => void;
  required?: boolean;
  /** 未勾选时的提示文案；默认会带上整段说明，过长时用它收敛。 */
  errorMessage?: string;
}) {
  const { idPrefix, errors } = useContext(FieldContext);
  const id = `${idPrefix}-${name}`;
  const error = errors[name];
  const errorId = error ? `${id}-error` : undefined;

  return (
    <div className="check-field">
      <label className="check" htmlFor={id}>
        <input
          id={id}
          name={name}
          type="checkbox"
          checked={checked}
          onChange={onChange}
          required={required}
          data-error-message={errorMessage}
          aria-required={required || undefined}
          aria-invalid={error ? true : undefined}
          aria-describedby={errorId}
        />
        <span>{label}</span>
      </label>
      {error ? (
        <span className="field-error" id={errorId} role="alert">
          {error}
        </span>
      ) : null}
    </div>
  );
}
