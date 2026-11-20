import { describe, expect, it } from "vitest";
import {
  onboardingIntentContext,
  onboardingProgress,
  onboardingQuoteContextFrom,
  onboardingSteps,
  quoteHref,
  stepsToRecord,
} from "./onboarding";

const zero = {
  customerCount: 0,
  sampleCount: 0,
  quoteCount: 0,
  sentQuoteCount: 0,
  confirmedShipmentCount: 0,
};

describe("开张清单", () => {
  it("新公司：四步顺序固定，全部未完成", () => {
    const steps = onboardingSteps(zero);
    expect(steps.map((step) => step.key)).toEqual(["customer", "sample", "quote", "approve"]);
    expect(steps.every((step) => step.done === false)).toBe(true);
    expect(onboardingProgress(steps)).toMatchObject({ completed: 0, total: 4, allDone: false });
  });

  it("每一步都指向真实入口的深链", () => {
    const [customer, sample, quote, approve] = onboardingSteps(zero);
    expect(customer?.href).toBe("/panorama/customers?new=1");
    expect(sample?.href).toBe("/panorama/samples?new=1");
    expect(quote?.href).toContain("/inbound?text=");
    expect(approve?.href).toBe("/approvals");
  });

  it("第③步带上刚建的客户名，统一输入页据此预填", () => {
    const href = quoteHref({ customerName: "杭州青禾服饰", sampleCode: "AUD-001" });
    const url = new URL(href, "https://app.wnbgj.com");
    expect(url.pathname).toBe("/inbound");
    expect(url.searchParams.get("text")).toBe("给杭州青禾服饰报第一张价：");

    const guess = onboardingSteps(zero, { customerName: "杭州青禾服饰" })[2];
    expect(guess?.hint).toContain("杭州青禾服饰");
  });

  it("没有客户时退化成通用话术，不编造客户名", () => {
    const [text] = [quoteHref({})];
    expect(decodeURIComponent(text)).toContain("给客户报第一张价：");
    expect(onboardingSteps(zero)[2]?.hint).not.toContain("客户 ");
  });

  it("完成判定只读统计：建了客户就打勾，报了价不会误判成已批", () => {
    const steps = onboardingSteps({ ...zero, customerCount: 1, sampleCount: 2, quoteCount: 1 });
    const byKey = Object.fromEntries(steps.map((step) => [step.key, step.done]));
    expect(byKey).toEqual({ customer: true, sample: true, quote: true, approve: false });
    expect(onboardingProgress(steps).next?.key).toBe("approve");
  });

  it("批掉第一单（报价发出或寄样确认）即视为完成", () => {
    expect(onboardingSteps({ ...zero, sentQuoteCount: 1 })[3]?.done).toBe(true);
    expect(onboardingSteps({ ...zero, confirmedShipmentCount: 1 })[3]?.done).toBe(true);
  });

  it("四步全完成 → allDone，没有下一步", () => {
    const steps = onboardingSteps({
      customerCount: 1,
      sampleCount: 1,
      quoteCount: 1,
      sentQuoteCount: 1,
      confirmedShipmentCount: 0,
    });
    expect(onboardingProgress(steps)).toMatchObject({ completed: 4, allDone: true, next: null });
  });
});

describe("开张进度上报", () => {
  it("只上报业务上已完成、服务端还没记时间的步骤", () => {
    const steps = onboardingSteps({ ...zero, customerCount: 1, sampleCount: 1 });
    expect(stepsToRecord(steps, undefined)).toEqual(["customer", "sample"]);
    expect(
      stepsToRecord(steps, {
        completedAt: { customer: "2026-11-16T10:00:00.000Z" },
      }),
    ).toEqual(["sample"]);
  });

  it("服务端已经记过的步骤不重复上报（幂等）", () => {
    const steps = onboardingSteps({ ...zero, customerCount: 1 });
    const state = {
      completedAt: {
        customer: "2026-11-16T10:00:00.000Z",
        sample: "2026-11-16T10:00:00.000Z",
        quote: "2026-11-16T10:00:00.000Z",
        approve: "2026-11-16T10:00:00.000Z",
      },
    };
    expect(stepsToRecord(steps, state)).toEqual([]);
  });
});

describe("第③步的上下文", () => {
  it("从 panorama 取第一个客户与样品，用于文案与提交 context", () => {
    const panorama = {
      customers: [{ id: "c1", name: "杭州青禾服饰", code: "KH-018" }],
      samples: [{ id: "s1", code: "AUD-001", name: "走查测试样品" }],
    };
    expect(onboardingQuoteContextFrom(panorama)).toEqual({
      customerName: "杭州青禾服饰",
      customerCode: "KH-018",
      sampleCode: "AUD-001",
    });
    expect(onboardingIntentContext(panorama)).toEqual({
      customerId: "c1",
      customerName: "杭州青禾服饰",
      customerCode: "KH-018",
      sampleId: "s1",
      sampleCode: "AUD-001",
      source: "onboarding-checklist",
    });
  });

  it("什么都没有时不编造 context", () => {
    expect(onboardingQuoteContextFrom(undefined)).toEqual({
      customerName: null,
      customerCode: null,
      sampleCode: null,
    });
    expect(onboardingIntentContext(undefined)).toBeUndefined();
  });
});
