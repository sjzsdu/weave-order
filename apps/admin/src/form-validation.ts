/**
 * 表单校验：把浏览器原生约束校验（required / pattern / min / max / type）
 * 转成中文、字段级、可读的错误信息，替代样式不可控且会遮挡相邻字段的原生气泡。
 *
 * 只依赖 DOM 类型做读取，文案生成保持纯函数，便于在 node 环境下单测。
 */

export type FieldIssue = { name: string; message: string };

export type ControlSnapshot = {
  name: string;
  label: string;
  type: string;
  title?: string;
  /** 控件上的 data-error-message，用于覆盖通用文案（例如「尚无租户」）。 */
  customMessage?: string;
  min?: string;
  max?: string;
  minLength?: number;
  maxLength?: number;
  validity: {
    valueMissing: boolean;
    typeMismatch: boolean;
    patternMismatch: boolean;
    tooShort: boolean;
    tooLong: boolean;
    rangeUnderflow: boolean;
    rangeOverflow: boolean;
    stepMismatch: boolean;
    badInput: boolean;
    customError: boolean;
  };
};

const TYPE_HINTS: Record<string, string> = {
  email: "请输入形如 name@example.com 的邮箱地址",
  url: "请输入完整的网址，包含 http:// 或 https://",
  date: "请选择有效日期",
  number: "请输入有效数字",
  tel: "请输入有效电话号码",
};

/** 生成字段级中文错误；字段本身合法时返回 null。 */
export function describeValidity(control: ControlSnapshot): string | null {
  const label = control.label.trim() || control.name;
  const validity = control.validity;

  if (control.customMessage) {
    return control.customMessage;
  }
  if (validity.customError) {
    return `「${label}」填写不正确，请按提示修改`;
  }
  if (validity.valueMissing) {
    return control.type === "checkbox" ? `请勾选「${label}」后再提交` : `请填写「${label}」`;
  }
  if (validity.badInput) {
    return `「${label}」不是有效的数字`;
  }
  if (validity.typeMismatch) {
    return TYPE_HINTS[control.type] ?? `「${label}」格式不正确`;
  }
  if (validity.patternMismatch) {
    return control.title
      ? `「${label}」格式不正确：${control.title}`
      : `「${label}」格式不正确，请检查填写内容`;
  }
  if (validity.tooShort) {
    return `「${label}」至少需要 ${control.minLength ?? 0} 个字符`;
  }
  if (validity.tooLong) {
    return `「${label}」最多允许 ${control.maxLength ?? 0} 个字符`;
  }
  if (validity.rangeUnderflow) {
    return `「${label}」不能小于 ${control.min ?? "允许的最小值"}`;
  }
  if (validity.rangeOverflow) {
    return `「${label}」不能大于 ${control.max ?? "允许的最大值"}`;
  }
  if (validity.stepMismatch) {
    return `「${label}」的数值精度不符合要求`;
  }
  if (!validitySaysValid(validity)) {
    return `请检查「${label}」`;
  }
  return null;
}

function validitySaysValid(validity: ControlSnapshot["validity"]): boolean {
  return !(
    validity.valueMissing ||
    validity.typeMismatch ||
    validity.patternMismatch ||
    validity.tooShort ||
    validity.tooLong ||
    validity.rangeUnderflow ||
    validity.rangeOverflow ||
    validity.stepMismatch ||
    validity.badInput ||
    validity.customError
  );
}

export function summaryText(count: number): string {
  return count > 0 ? `请检查 ${count} 项未填写或格式不正确的内容` : "";
}

type FormControl = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;

function isFormControl(element: Element): element is FormControl {
  return (
    element instanceof HTMLInputElement ||
    element instanceof HTMLSelectElement ||
    element instanceof HTMLTextAreaElement
  );
}

/** 星号仅用于视觉提示，读屏依赖 aria-required，这里把它从 label 文本里去掉。 */
function labelOf(control: FormControl): string {
  const text = control.labels?.[0]?.textContent ?? "";
  return text.replace(/\*/g, "").replace(/\s+/g, " ").trim();
}

/** 收集表单内所有不合法的控件，按 DOM 顺序返回，第一项即焦点目标。 */
export function collectFormIssues(form: HTMLFormElement): FieldIssue[] {
  const issues: FieldIssue[] = [];
  const seen = new Set<string>();

  for (const element of Array.from(form.elements)) {
    if (!isFormControl(element)) continue;
    if (!element.name || element.disabled) continue;
    if (element instanceof HTMLInputElement) {
      if (["hidden", "button", "submit", "reset", "image"].includes(element.type)) continue;
    }
    // 单选组只提示一次。
    if (seen.has(element.name)) continue;
    if (element.validity.valid) continue;

    const message = describeValidity({
      name: element.name,
      label: labelOf(element),
      type: element.type,
      title: element.title || undefined,
      customMessage: element.dataset.errorMessage || undefined,
      min: element.getAttribute("min") ?? undefined,
      max: element.getAttribute("max") ?? undefined,
      minLength:
        typeof (element as HTMLInputElement).minLength === "number"
          ? (element as HTMLInputElement).minLength
          : undefined,
      maxLength:
        typeof (element as HTMLInputElement).maxLength === "number"
          ? (element as HTMLInputElement).maxLength
          : undefined,
      validity: {
        valueMissing: element.validity.valueMissing,
        typeMismatch: element.validity.typeMismatch,
        patternMismatch: element.validity.patternMismatch,
        tooShort: element.validity.tooShort,
        tooLong: element.validity.tooLong,
        rangeUnderflow: element.validity.rangeUnderflow,
        rangeOverflow: element.validity.rangeOverflow,
        stepMismatch: element.validity.stepMismatch,
        badInput: element.validity.badInput,
        customError: element.validity.customError,
      },
    });
    if (message) {
      issues.push({ name: element.name, message });
      seen.add(element.name);
    }
  }
  return issues;
}

/** 聚焦到指定字段；滚动由浏览器 focus 默认行为负责，减少长表单里看不到反馈的情况。 */
export function focusField(form: HTMLFormElement | null, name: string): void {
  if (!form) return;
  const element = form.elements.namedItem(name);
  if (element instanceof HTMLElement) {
    element.focus({ preventScroll: true });
    element.scrollIntoView({ block: "center", behavior: "smooth" });
  }
}
