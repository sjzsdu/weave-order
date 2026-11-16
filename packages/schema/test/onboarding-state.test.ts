import { describe, expect, it } from "vitest";
import {
  ONBOARDING_STEP_KEYS,
  OnboardingState,
  UpdateOnboardingStateInput,
} from "../src/onboarding";

describe("开张进度契约", () => {
  it("四步键序固定", () => {
    expect(ONBOARDING_STEP_KEYS).toEqual(["customer", "sample", "quote", "approve"]);
  });

  it("默认态可解析：没有任何完成时间时 updatedAt 为 null", () => {
    const state = OnboardingState.parse({
      completedAt: {},
      collapsed: false,
      skipped: false,
      allDoneAt: null,
      updatedAt: null,
    });
    expect(state.completedAt).toEqual({});
    expect(state.updatedAt).toBeNull();
  });

  it("完成时间必须是 ISO 时间，未知步骤键被拒绝", () => {
    expect(() =>
      OnboardingState.parse({
        completedAt: { customer: "2026-11-16T10:00:00.000Z" },
        collapsed: false,
        skipped: false,
        allDoneAt: null,
        updatedAt: "2026-11-16T10:00:00.000Z",
      }),
    ).not.toThrow();

    expect(() =>
      OnboardingState.parse({
        completedAt: { customer: "昨天" },
        collapsed: false,
        skipped: false,
        allDoneAt: null,
        updatedAt: null,
      }),
    ).toThrow();

    expect(() =>
      OnboardingState.parse({
        completedAt: { unknown_step: "2026-11-16T10:00:00.000Z" },
        collapsed: false,
        skipped: false,
        allDoneAt: null,
        updatedAt: null,
      }),
    ).toThrow();
  });

  it("更新只接受完成/收起/跳过，客户端不能自报时间戳", () => {
    expect(UpdateOnboardingStateInput.parse({ completeSteps: ["customer"] })).toEqual({
      completeSteps: ["customer"],
    });
    expect(UpdateOnboardingStateInput.parse({ collapsed: true, skipped: false })).toEqual({
      collapsed: true,
      skipped: false,
    });
    // 直接传 completedAt 是契约外字段，必须被拒绝（时间由服务端生成）。
    expect(() =>
      UpdateOnboardingStateInput.parse({
        completedAt: { customer: "2026-11-16T10:00:00.000Z" },
      }),
    ).toThrow();
  });
});
