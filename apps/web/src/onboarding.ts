import type { PanoramaStats } from "@weave-order/schema";

/**
 * 开张清单：新公司首屏的四步。
 *
 * 每一步都指向**已经存在**的真实入口，不新增流程：
 * ① 客户页的新建抽屉 ② 样品页的新建编辑器 ③ 工作台的意图栏 ④ 审批窗口。
 * 完成判定只读 panorama 的统计，不另建表、不在前端推算业务数字。
 */
export type OnboardingStepKey = "customer" | "sample" | "quote" | "approve";

export interface OnboardingStep {
  key: OnboardingStepKey;
  title: string;
  hint: string;
  href: string;
  done: boolean;
}

type OnboardingStats = Pick<
  PanoramaStats,
  "customerCount" | "sampleCount" | "quoteCount" | "sentQuoteCount" | "confirmedShipmentCount"
>;

export function onboardingSteps(stats: OnboardingStats): OnboardingStep[] {
  return [
    {
      key: "customer",
      title: "建第一个客户",
      hint: "填个名字就能建，后面再补联系方式。",
      href: "/panorama/customers?new=1",
      done: stats.customerCount > 0,
    },
    {
      key: "sample",
      title: "建第一个样品",
      hint: "拍一张图或填个编号，规格可以之后补。",
      href: "/panorama/samples?new=1",
      done: stats.sampleCount > 0,
    },
    {
      key: "quote",
      title: "让小织报第一张价",
      hint: "客户和样品已经在库里，说一句要报什么就行。",
      href: "/today?intent=给客户报第一张价：",
      done: stats.quoteCount > 0,
    },
    {
      key: "approve",
      title: "批掉第一单",
      hint: "报价、寄样都在审批窗口，点批准就生效。",
      href: "/approvals",
      done: stats.sentQuoteCount > 0 || stats.confirmedShipmentCount > 0,
    },
  ];
}

export interface OnboardingProgress {
  completed: number;
  total: number;
  allDone: boolean;
  /** 第一个未完成的步骤；全部完成时为 null。 */
  next: OnboardingStep | null;
}

export function onboardingProgress(steps: OnboardingStep[]): OnboardingProgress {
  const completed = steps.filter((step) => step.done).length;
  return {
    completed,
    total: steps.length,
    allDone: steps.length > 0 && completed === steps.length,
    next: steps.find((step) => !step.done) ?? null,
  };
}

/** localStorage key 带版本号：以后改步骤就换版本，旧进度自然失效而不是错勾。 */
export const ONBOARDING_STORAGE_KEY = "weave:onboarding:v1";

export interface OnboardingPrefs {
  /** 用户主动收起：不再占屏，完整版可以从工作台尾部重新展开。 */
  collapsed: boolean;
  /** 用户跳过：本设备不再提示。 */
  skipped: boolean;
  /** 第一次观察到某步完成的时间（ISO），不编造、不补写历史。 */
  completedAt: Partial<Record<OnboardingStepKey, string>>;
}

export const EMPTY_ONBOARDING_PREFS: OnboardingPrefs = {
  collapsed: false,
  skipped: false,
  completedAt: {},
};

type ReadableStorage = Pick<Storage, "getItem">;
type WritableStorage = Pick<Storage, "setItem">;

/** 读失败（隐私模式、配额、脏数据）一律回到默认值：清单不该让整个页面报错。 */
export function readOnboardingPrefs(storage?: ReadableStorage | null): OnboardingPrefs {
  const store = storage ?? safeStorage();
  if (!store) return EMPTY_ONBOARDING_PREFS;
  try {
    const raw = store.getItem(ONBOARDING_STORAGE_KEY);
    if (!raw) return EMPTY_ONBOARDING_PREFS;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return EMPTY_ONBOARDING_PREFS;
    const value = parsed as Partial<OnboardingPrefs>;
    return {
      collapsed: value.collapsed === true,
      skipped: value.skipped === true,
      completedAt:
        typeof value.completedAt === "object" && value.completedAt !== null
          ? value.completedAt
          : {},
    };
  } catch {
    return EMPTY_ONBOARDING_PREFS;
  }
}

export function writeOnboardingPrefs(
  prefs: OnboardingPrefs,
  storage?: WritableStorage | null,
): void {
  const store = storage ?? safeStorage();
  if (!store) return;
  try {
    store.setItem(ONBOARDING_STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // 存不下就只影响下次进入的勾选，不影响当前页面。
  }
}

/**
 * 把「这一步现在是完成的」记成时间戳（只记第一次）。
 *
 * 完成时间拿不到真实时刻（比如别人在其他设备建的客户）就不写，
 * 界面上只显示勾，不编造「3 分钟前完成」。
 */
export function recordCompletions(
  prefs: OnboardingPrefs,
  steps: OnboardingStep[],
  now: string,
): OnboardingPrefs {
  let changed = false;
  const completedAt = { ...prefs.completedAt };
  for (const step of steps) {
    if (step.done && !completedAt[step.key]) {
      completedAt[step.key] = now;
      changed = true;
    }
  }
  return changed ? { ...prefs, completedAt } : prefs;
}

function safeStorage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}
