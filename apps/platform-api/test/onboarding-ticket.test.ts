import { describe, expect, it } from "vitest";
import {
  DEV_ONBOARDING_SECRET,
  OnboardingTicketError,
  signOnboardingTicket,
  verifyOnboardingTicket,
} from "../src/control/onboarding-ticket";

/**
 * 固定向量：与 apps/api/src/onboarding/ticket.ts 共用同一份。
 * 控制面签出的链接必须能被业务侧验过，反之亦然。
 */
const GOLDEN_PAYLOAD = {
  v: 1 as const,
  slug: "qinghe",
  name: "青禾纺织",
  ownerEmail: "boss@qinghe.example",
  exp: 1_800_000_000,
};
const GOLDEN_CODE =
  "eyJ2IjoxLCJzbHVnIjoicWluZ2hlIiwibmFtZSI6Iumdkuemvue6uue7hyIsIm93bmVyRW1haWwiOiJib3NzQHFpbmdoZS5leGFtcGxlIiwiZXhwIjoxODAwMDAwMDAwfQ.9KMVMlEl5N1GyOvA4L-VCfHWbBK2m8Ty7kmDDHZNCmY";

describe("开通链接票据（控制面）", () => {
  it("签出的链接与固定向量一致", () => {
    expect(signOnboardingTicket(GOLDEN_PAYLOAD, DEV_ONBOARDING_SECRET)).toBe(GOLDEN_CODE);
  });

  it("不带 exp 时按 7 天有效期补齐", () => {
    const code = signOnboardingTicket(
      { ...GOLDEN_PAYLOAD, exp: undefined },
      DEV_ONBOARDING_SECRET,
      7 * 24 * 60 * 60,
      new Date("2026-01-01T00:00:00Z"),
    );
    const ticket = verifyOnboardingTicket(code, DEV_ONBOARDING_SECRET, 1_767_225_600);
    expect(ticket.exp).toBe(
      Math.floor(new Date("2026-01-01T00:00:00Z").getTime() / 1000) + 7 * 86400,
    );
  });

  it("自行验签能取回原文", () => {
    expect(verifyOnboardingTicket(GOLDEN_CODE, DEV_ONBOARDING_SECRET, 1_700_000_000)).toEqual(
      GOLDEN_PAYLOAD,
    );
  });

  it("篡改后拒绝", () => {
    expect(() =>
      verifyOnboardingTicket(
        GOLDEN_CODE.replace("eyJ2Ijo", "eyJ2Ijs"),
        DEV_ONBOARDING_SECRET,
        1_700_000_000,
      ),
    ).toThrow(OnboardingTicketError);
  });
});
