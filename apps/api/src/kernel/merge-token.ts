import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * 合并预览 / 撤销票据。
 *
 * 为什么用签名票据而不是服务端会话：合并是「预览 → 确认」两步动作，
 * 票据把「用户看到的那次预览」绑定到「这次合并」，避免两次请求之间目标客户
 * 或数据量发生变化却仍然执行。撤销窗口同样是「有截止时间的承诺」，
 * 自包含签名票据比内存表更耐进程重启。
 */
export interface MergeTokenPayload {
  purpose: "preview" | "undo";
  tenantId: string;
  sourceCustomerId: string;
  targetCustomerId: string;
  /** Unix 毫秒。 */
  exp: number;
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

function sign(secret: string, body: string): string {
  return createHmac("sha256", secret).update(body).digest("base64url");
}

export function createMergeToken(secret: string, payload: MergeTokenPayload): string {
  const body = base64url(JSON.stringify(payload));
  return `${body}.${sign(secret, body)}`;
}

export function verifyMergeToken(secret: string, token: string): MergeTokenPayload {
  const [body, signature] = token.split(".");
  if (!body || !signature) throw new Error("TOKEN_MALFORMED");
  const expected = sign(secret, body);
  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (
    actualBuffer.length !== expectedBuffer.length ||
    !timingSafeEqual(actualBuffer, expectedBuffer)
  ) {
    throw new Error("TOKEN_SIGNATURE_INVALID");
  }
  const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as MergeTokenPayload;
  if (typeof payload.exp !== "number" || payload.exp < Date.now()) {
    throw new Error("TOKEN_EXPIRED");
  }
  return payload;
}
