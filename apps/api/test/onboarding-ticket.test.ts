import { describe, expect, it } from "vitest";
import {
  DEV_ONBOARDING_SECRET,
  OnboardingTicketError,
  signOnboardingTicket,
  verifyOnboardingTicket,
} from "../src/onboarding/ticket";

/**
 * 固定向量：与 apps/platform-api/src/control/onboarding-ticket.ts 共用同一份。
 * 两边任何一侧改了编码格式，这里都会红。
 */
const GOLDEN_PAYLOAD = {
  v: 1 as const,
  kind: "tenant" as const,
  slug: "qinghe",
  name: "青禾纺织",
  ownerEmail: "boss@qinghe.example",
  role: null,
  exp: 1_800_000_000,
};
const GOLDEN_CODE =
  "eyJ2IjoxLCJraW5kIjoidGVuYW50Iiwic2x1ZyI6InFpbmdoZSIsIm5hbWUiOiLpnZLnpr7nurrnu4ciLCJvd25lckVtYWlsIjoiYm9zc0BxaW5naGUuZXhhbXBsZSIsInJvbGUiOm51bGwsImV4cCI6MTgwMDAwMDAwMH0.Z1ezGN6YoRqgGLRLEykSywd1qZHW4MqiKDzvifS4s7Y";

describe("开通链接票据", () => {
  it("能验证控制面签发的固定向量", () => {
    const ticket = verifyOnboardingTicket(GOLDEN_CODE, DEV_ONBOARDING_SECRET, 1_700_000_000);
    expect(ticket).toEqual(GOLDEN_PAYLOAD);
  });

  it("签名结果与固定向量一致", () => {
    expect(signOnboardingTicket(GOLDEN_PAYLOAD, DEV_ONBOARDING_SECRET)).toBe(GOLDEN_CODE);
  });

  it("过期后拒绝", () => {
    expect(() => verifyOnboardingTicket(GOLDEN_CODE, DEV_ONBOARDING_SECRET, 1_800_000_001)).toThrow(
      OnboardingTicketError,
    );
  });

  it("改一个字符就拒绝", () => {
    const tampered = GOLDEN_CODE.replace("eyJ2Ijo", "eyJ2Ijs");
    expect(() => verifyOnboardingTicket(tampered, DEV_ONBOARDING_SECRET, 1_700_000_000)).toThrow(
      OnboardingTicketError,
    );
  });

  it("换密钥就拒绝", () => {
    expect(() => verifyOnboardingTicket(GOLDEN_CODE, "another-secret", 1_700_000_000)).toThrow(
      OnboardingTicketError,
    );
  });

  it("格式不对时给出可操作的提示", () => {
    expect(() => verifyOnboardingTicket("not-a-ticket", DEV_ONBOARDING_SECRET)).toThrow(/重新索取/);
  });
});
