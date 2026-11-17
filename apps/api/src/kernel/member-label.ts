/**
 * 成员可展示名的唯一口径。
 *
 * 为什么单独一个模块：`memberships.subject` 是 Casdoor 主键（UUID），历史上被当成姓名
 * 直接返回给页面（WAN-151）。凡是要把成员展示给人看的地方都走这里，才能保证
 * 「宁可显示兜底文案，也不泄漏 UUID」这条规则只有一份实现。
 */

const TECHNICAL_ID_PATTERN =
  /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{32})$/i;

/** 看起来像 SSO 主键 / 内部 ID（UUID 或 32 位十六进制），不能当人名显示。 */
export function isTechnicalId(value: string | null | undefined): boolean {
  if (!value) return false;
  return TECHNICAL_ID_PATTERN.test(value.trim());
}

/**
 * 从候选值里取第一个「能给人看」的展示名。
 *
 * 依次尝试姓名、邮箱；都不可用返回 null，由调用方给出「未分配 / 我 / 同事」这类兜底，
 * **绝不**回退到 subject。
 */
export function memberDisplayName(...candidates: Array<string | null | undefined>): string | null {
  for (const candidate of candidates) {
    const value = candidate?.trim();
    if (!value || isTechnicalId(value)) continue;
    return value;
  }
  return null;
}
