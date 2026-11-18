import { createHmac, timingSafeEqual } from "node:crypto";
import { OnboardingTicket } from "@weave-order/schema";

/**
 * 开通链接的签名与验签。
 *
 * 控制面（apps/platform-api）签发，业务侧（apps/api）验签，两边共用一个
 * `ONBOARDING_SECRET`。业务侧不查控制面数据库，因此票据必须自带全部信息，
 * 并且不可伪造、不可改写。
 *
 * 格式：`base64url(payload) + "." + base64url(HMAC-SHA256(payload))`。
 *
 * 注意：本文件与 `apps/platform-api/src/control/onboarding-ticket.ts` 保持逐字一致
 * （两个应用不共享运行时包）；两侧都有固定向量的单测，改一处另一处会红。
 */
export const DEV_ONBOARDING_SECRET = "dev-only-onboarding-secret-change-me-0001";

/** 工单默认有效期：7 天。客户换人、换微信重发都够用，又不会长期裸露。 */
export const ONBOARDING_TICKET_TTL_SECONDS = 7 * 24 * 60 * 60;

export class OnboardingTicketError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OnboardingTicketError";
  }
}

function base64url(buffer: Buffer): string {
  return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64url(value: string): Buffer {
  return Buffer.from(value.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

export function signOnboardingTicket(
  ticket: {
    v?: 1;
    slug: string;
    name: string;
    ownerEmail: string | null;
    kind?: "tenant" | "invite";
    role?: OnboardingTicket["role"];
    membershipId?: string;
    exp?: number;
  },
  secret: string,
  ttlSeconds: number = ONBOARDING_TICKET_TTL_SECONDS,
  now: Date = new Date(),
): string {
  const payload = OnboardingTicket.parse({
    ...ticket,
    exp: ticket.exp && ticket.exp > 0 ? ticket.exp : Math.floor(now.getTime() / 1000) + ttlSeconds,
  });
  const body = base64url(Buffer.from(JSON.stringify(payload), "utf8"));
  const signature = base64url(createHmac("sha256", secret).update(body).digest());
  return `${body}.${signature}`;
}

export function verifyOnboardingTicket(
  code: string,
  secret: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): OnboardingTicket {
  const parts = code.trim().split(".");
  if (parts.length !== 2) throw new OnboardingTicketError("开通链接格式不正确，请向对接人重新索取");
  const [body, signature] = parts as [string, string];
  if (!body || !signature)
    throw new OnboardingTicketError("开通链接格式不正确，请向对接人重新索取");

  const expected = createHmac("sha256", secret).update(body).digest();
  const actual = fromBase64url(signature);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new OnboardingTicketError("开通链接无效，请向对接人重新索取");
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(fromBase64url(body).toString("utf8"));
  } catch {
    throw new OnboardingTicketError("开通链接无效，请向对接人重新索取");
  }
  const parsed = OnboardingTicket.safeParse(decoded);
  if (!parsed.success) throw new OnboardingTicketError("开通链接内容不正确，请向对接人重新索取");
  if (parsed.data.exp <= nowSeconds) {
    throw new OnboardingTicketError("开通链接已过期，请向对接人索取一条新的");
  }
  return parsed.data;
}
