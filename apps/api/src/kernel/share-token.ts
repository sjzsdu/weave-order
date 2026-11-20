import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * 客户报价链接的签名 token。
 *
 * 设计要点：
 * - token 自带 (tenantId, shareId)，校验签名后即可打开对应租户会话；
 *   公开路由因此不需要一条跨租户的 owner 连接去猜租户，RLS 始终生效。
 * - 数据库只存 `sha256(token)`，即使库被拖走也拿不到可用的链接。
 * - 签名用 HMAC-SHA256，密钥来自 `QUOTE_SHARE_SECRET`（生产必须覆盖）。
 */
export interface ShareTokenPayload {
  /** tenantId */
  t: string;
  /** shareId */
  s: string;
  /** 32 字节随机数（base64url），保证 token 不可枚举 */
  n: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

function sign(secret: string, encodedPayload: string): string {
  return createHmac("sha256", secret).update(encodedPayload).digest("base64url");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** 比较两个十六进制哈希（等长）；不等长直接 false，避免 timingSafeEqual 抛错。 */
export function tokenHashMatches(candidate: string, stored: string): boolean {
  if (candidate.length !== stored.length) return false;
  return timingSafeEqual(Buffer.from(candidate, "utf8"), Buffer.from(stored, "utf8"));
}

/** 与 IP/UA 一样做加盐哈希，避免明文或可彩虹表反查。 */
export function hashAnonymous(value: string, secret: string): string {
  return createHmac("sha256", secret).update(value).digest("hex");
}

/**
 * 客户报价链接的唯一拼装点。
 *
 * 生产门禁（`production-env-gate.test.ts`）与真实分享接口必须走同一个函数，
 * 否则「测试里断言的不是线上生成的那条链接」，localhost 回落在测试里就看不出来。
 */
export function buildShareUrl(publicAppUrl: string, token: string): string {
  return `${publicAppUrl.replace(/\/+$/, "")}/s/${token}`;
}

export function createShareToken(
  payload: Omit<ShareTokenPayload, "n">,
  secret: string,
): { token: string; tokenHash: string } {
  const full: ShareTokenPayload = { ...payload, n: randomBytes(24).toString("base64url") };
  const encoded = base64url(JSON.stringify(full));
  const token = `${encoded}.${sign(secret, encoded)}`;
  return { token, tokenHash: hashToken(token) };
}

/**
 * 校验签名并解析 token。任何格式/签名问题都返回 null，调用方统一按「链接无效」处理。
 */
export function parseShareToken(token: string, secret: string): ShareTokenPayload | null {
  const dot = token.indexOf(".");
  if (dot <= 0 || dot !== token.lastIndexOf(".")) return null;
  const encoded = token.slice(0, dot);
  const signature = token.slice(dot + 1);
  if (signature.length === 0) return null;

  const expected = Buffer.from(sign(secret, encoded));
  const actual = Buffer.from(signature);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const candidate = parsed as Record<string, unknown>;
  if (
    typeof candidate.t !== "string" ||
    typeof candidate.s !== "string" ||
    typeof candidate.n !== "string" ||
    !UUID_RE.test(candidate.t) ||
    !UUID_RE.test(candidate.s) ||
    candidate.n.length < 16
  ) {
    return null;
  }
  return { t: candidate.t, s: candidate.s, n: candidate.n };
}

/**
 * 样卡二维码 token。
 *
 * 与报价链接同一种签名，但用途不同：payload 里是 (tenantId, sampleCode)，
 * 公开页只回「样品编号 + 业务员联系方式」。签名保证 URL 不能被改成别的租户 /
 * 别的样品去探测；也不把租户 UUID 直接印在纸上。
 */
export interface SampleCardTokenPayload {
  /** tenantId */
  t: string;
  /** sample code（样品编号，非 UUID） */
  c: string;
}

/**
 * 样卡 token 刻意做成确定性：同一租户 + 同一编号每次得到同一段 token。
 * 这样「预览里的二维码」与「纸上打印的二维码」逐字节一致，补打也不会换码；
 * 而签名仍然阻止把链接改成别家租户 / 别的样品。
 */
export function createSampleCardToken(
  payload: { tenantId: string; sampleCode: string },
  secret: string,
): string {
  const encoded = base64url(JSON.stringify({ t: payload.tenantId, c: payload.sampleCode }));
  return `${encoded}.${sign(secret, encoded)}`;
}

export function parseSampleCardToken(token: string, secret: string): SampleCardTokenPayload | null {
  const dot = token.indexOf(".");
  if (dot <= 0 || dot !== token.lastIndexOf(".")) return null;
  const encoded = token.slice(0, dot);
  const signature = token.slice(dot + 1);
  if (signature.length === 0) return null;

  const expected = Buffer.from(sign(secret, encoded));
  const actual = Buffer.from(signature);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const candidate = parsed as Record<string, unknown>;
  if (
    typeof candidate.t !== "string" ||
    typeof candidate.c !== "string" ||
    !UUID_RE.test(candidate.t) ||
    candidate.c.length === 0 ||
    candidate.c.length > 64
  ) {
    return null;
  }
  return { t: candidate.t, c: candidate.c };
}

/** 样卡公开页地址；与报价链接分开命名空间，避免两类 token 混用。 */
export function buildSampleCardUrl(publicAppUrl: string, token: string): string {
  return `${publicAppUrl.replace(/\/+$/, "")}/s/sample/${token}`;
}
