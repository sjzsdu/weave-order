/**
 * 出网前脱敏（铁律 G9）。
 *
 * 只做「识别得到的高风险字段」替换：手机号、银行账号、邮箱。
 * 成本底线、客户名单、合同价不进 prompt —— 这是调用方（agent）的约束，
 * 这里再做一层兜底，避免上游误把原文整段发出。
 */
const PHONE_CN = /(?<!\d)(?:\+?86[-\s]?)?1[3-9]\d{9}(?!\d)/g;
const PHONE_INTL = /(?<!\d)\+?\d{1,3}[-\s]\d{2,4}[-\s]\d{3,4}[-\s]\d{3,4}(?!\d)/g;
const BANK_ACCOUNT = /(?<!\d)\d{12,30}(?!\d)/g;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/** 保形脱敏：保留长度与可读性，便于模型理解但不可还原。 */
function mask(value: string): string {
  const digits = value.replace(/\D/g, "");
  if (digits.length <= 4) return "[REDACTED]";
  return `${"*".repeat(Math.max(0, digits.length - 4))}${digits.slice(-4)}`;
}

export function redactSensitiveText(text: string): string {
  return text
    .replace(EMAIL, "[EMAIL_REDACTED]")
    .replace(PHONE_CN, (match) => `[PHONE:${mask(match)}]`)
    .replace(PHONE_INTL, (match) => `[PHONE:${mask(match)}]`)
    .replace(BANK_ACCOUNT, (match) => `[ACCOUNT:${mask(match)}]`);
}

export interface RedactionReport {
  text: string;
  redacted: boolean;
}

export function redactWithReport(text: string): RedactionReport {
  const redactedText = redactSensitiveText(text);
  return { text: redactedText, redacted: redactedText !== text };
}
