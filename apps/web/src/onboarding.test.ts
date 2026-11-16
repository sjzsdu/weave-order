import { describe, expect, it } from "vitest";
import {
  EMPTY_ONBOARDING_PREFS,
  ONBOARDING_STORAGE_KEY,
  onboardingProgress,
  onboardingSteps,
  readOnboardingPrefs,
  recordCompletions,
  writeOnboardingPrefs,
  type OnboardingPrefs,
} from "./onboarding";

const zero = {
  customerCount: 0,
  sampleCount: 0,
  quoteCount: 0,
  sentQuoteCount: 0,
  confirmedShipmentCount: 0,
};

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    dump: () => Object.fromEntries(data),
  };
}

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
    expect(quote?.href.startsWith("/today?intent=")).toBe(true);
    expect(approve?.href).toBe("/approvals");
  });

  it("完成判定只读统计：建了客户就打勾，产品报价不会误判成已批", () => {
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

describe("开张清单进度持久化", () => {
  it("没有存档时回到默认值", () => {
    expect(readOnboardingPrefs(memoryStorage())).toEqual(EMPTY_ONBOARDING_PREFS);
  });

  it("写进去的只要可读字段，脏数据不抛错", () => {
    const store = memoryStorage();
    writeOnboardingPrefs(
      { collapsed: true, skipped: false, completedAt: { customer: "t" } },
      store,
    );
    expect(readOnboardingPrefs(store)).toEqual({
      collapsed: true,
      skipped: false,
      completedAt: { customer: "t" },
    });

    const dirty = memoryStorage({ [ONBOARDING_STORAGE_KEY]: "{not json" });
    expect(readOnboardingPrefs(dirty)).toEqual(EMPTY_ONBOARDING_PREFS);
  });

  it("没有 storage（服务端 / 隐私模式）时不崩", () => {
    expect(readOnboardingPrefs(null)).toEqual(EMPTY_ONBOARDING_PREFS);
    expect(() => writeOnboardingPrefs(EMPTY_ONBOARDING_PREFS, null)).not.toThrow();
  });

  it("完成时间只记第一次，重复观察不覆盖", () => {
    const steps = onboardingSteps({ ...zero, customerCount: 1 });
    const first = recordCompletions(EMPTY_ONBOARDING_PREFS, steps, "2026-11-16T10:00:00.000Z");
    expect(first.completedAt.customer).toBe("2026-11-16T10:00:00.000Z");

    const second = recordCompletions(first, steps, "2026-11-16T12:00:00.000Z");
    expect(second).toBe(first);

    // 新增完成步骤时只补新键，旧时间保持不变。
    const more = recordCompletions(
      first,
      onboardingSteps({ ...zero, customerCount: 1, sampleCount: 1 }),
      "2026-11-16T12:00:00.000Z",
    );
    expect(more.completedAt).toEqual({
      customer: "2026-11-16T10:00:00.000Z",
      sample: "2026-11-16T12:00:00.000Z",
    });
  });

  it("跳过状态会写进存档（同一 key，版本化）", () => {
    const store = memoryStorage();
    const prefs: OnboardingPrefs = { ...EMPTY_ONBOARDING_PREFS, skipped: true };
    writeOnboardingPrefs(prefs, store);
    expect(store.dump()[ONBOARDING_STORAGE_KEY]).toContain('"skipped":true');
    expect(ONBOARDING_STORAGE_KEY).toBe("weave:onboarding:v1");
  });
});
