/**
 * 用户可见提示的统一清洗。
 *
 * 模型网关的错误原文（HTTP 状态码、令牌、request id、上游模型名）只适合进日志，
 * 不应该出现在业务用户的意图卡上。历史数据的 failureReason 已经落库，读侧也必须洗一遍，
 * 否则修好了生成逻辑，旧卡片仍然在泄露内部细节。
 */

const INTERNAL_MARKERS: readonly RegExp[] = [
  /模型网关/,
  /企业模型/,
  /HTTP\s*\d{3}/i,
  /request\s*id/i,
  /令牌/,
  /deepseek/i,
  /openai-compatible/i,
];

const MAX_NOTICE_LENGTH = 500;
const FALLBACK_NOTICE = "模型服务暂时不可用，本次已按本地规则整理，原话还在，可以重试。";

function hasInternalDetail(text: string): boolean {
  return INTERNAL_MARKERS.some((pattern) => pattern.test(text));
}

/**
 * 去掉含内部细节的整句，保留仍然对用户有意义的缺失项/重试说明。
 * 传 null / 空串时原样返回 null，调用方不用额外判空。
 */
export function sanitizeUserNotice(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const raw = value.trim();
  if (raw.length === 0) return null;
  if (!hasInternalDetail(raw)) return raw.slice(0, MAX_NOTICE_LENGTH);

  // 按中文句末标点切句：只丢掉泄露内部细节的那一句，不把「还差哪些信息」一起吞掉。
  const kept = raw
    .split(/(?<=[。！？])/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0 && !hasInternalDetail(sentence));

  const text = [...new Set(kept)].join("").trim();
  return (text || FALLBACK_NOTICE).slice(0, MAX_NOTICE_LENGTH);
}
