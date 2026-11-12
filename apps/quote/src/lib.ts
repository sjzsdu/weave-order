import type { Lang } from "./i18n";

const UNIT_LABEL: Record<string, { zh: string; en: string }> = {
  meter: { zh: "米", en: "m" },
  kilogram: { zh: "公斤", en: "kg" },
  yard: { zh: "码", en: "yd" },
  piece: { zh: "件", en: "pc" },
};

export function formatMoney(cents: number, currency: string, lang: Lang): string {
  return new Intl.NumberFormat(lang === "zh" ? "zh-CN" : "en-US", {
    style: "currency",
    currency,
    currencyDisplay: "narrowSymbol",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(cents / 100);
}

export function formatQuantity(value: number, unit: string, lang: Lang): string {
  const label = UNIT_LABEL[unit]?.[lang] ?? unit;
  const quantity = new Intl.NumberFormat(lang === "zh" ? "zh-CN" : "en-US", {
    maximumFractionDigits: 3,
  }).format(value);
  return lang === "zh" ? `${quantity} ${label}` : `${quantity} ${label}`;
}

export function formatDate(iso: string, lang: Lang): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat(lang === "zh" ? "zh-CN" : "en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "Asia/Shanghai",
  }).format(date);
}

export function formatDateTime(iso: string, lang: Lang): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat(lang === "zh" ? "zh-CN" : "en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Shanghai",
  }).format(date);
}

/**
 * 有效期进度条：没有「报价总天数」字段，用剩余 30 天作为满格参照。
 * 只用于视觉提示，不参与任何业务判断（是否过期由服务端判定）。
 */
export function validityRatio(remainingDays: number): number {
  return Math.max(0, Math.min(1, remainingDays / 30));
}

export function lineLabel(index: number, lang: Lang): string {
  return lang === "zh" ? `第 ${index + 1} 行` : `Line ${index + 1}`;
}
