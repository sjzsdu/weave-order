import type { OnboardingState, OnboardingStepKey, PanoramaStats } from "@weave-order/schema";

/**
 * 开张清单：新公司首屏的四步。
 *
 * 每一步都指向**已经存在**的真实入口，不新增流程：
 * ① 客户页的新建抽屉 ② 样品页的新建编辑器 ③ 工作台的意图栏（带上刚建的客户与样品）
 * ④ 审批窗口。
 *
 * 完成判定只读 panorama 的统计，不另建表、不在前端推算业务数字。
 * 进度本身（首次完成时间 / 收起 / 跳过）由后端 `onboarding_state` 持有，
 * 换设备一致；见 `useOnboardingState`。
 */
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

/** 第③步自动带上的上下文：客户与样品都来自已加载的 panorama。 */
export interface OnboardingQuoteContext {
  customerName?: string | null;
  customerCode?: string | null;
  sampleCode?: string | null;
}

export function onboardingSteps(
  stats: OnboardingStats,
  context: OnboardingQuoteContext = {},
): OnboardingStep[] {
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
      hint: quoteHint(context),
      href: quoteHref(context),
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

/**
 * 第③步落地时把客户与样品带进 composer：`/today?onboard=quote` 让工作台
 * 知道这次输入来自开张清单，提交意图时把已有客户/样品作为 context 一起落库，
 * 用户只补数量与价格。
 */
export function quoteHref(context: OnboardingQuoteContext): string {
  const name = context.customerName?.trim();
  const text = name ? `给${name}报第一张价：` : "给客户报第一张价：";
  return `/today?intent=${encodeURIComponent(text)}&onboard=quote`;
}

function quoteHint(context: OnboardingQuoteContext): string {
  const parts = [
    context.customerName?.trim() ? `客户 ${context.customerName.trim()}` : null,
    context.sampleCode?.trim() ? `样品 ${context.sampleCode.trim()}` : null,
  ].filter((part): part is string => Boolean(part));
  if (parts.length === 0) return "客户和样品已经在库里，说一句要报什么就行。";
  return `${parts.join(" · ")} 已经带上了，只补数量和价格。`;
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

/**
 * 需要上报给服务端的步骤：业务上已经完成、但进度表里还没有首次时间。
 *
 * 只上报「完成」，时间戳由服务端生成——客户端时钟不可信，
 * 也不能让一次误操作把历史时间改掉。
 */
export function stepsToRecord(
  steps: OnboardingStep[],
  state: Pick<OnboardingState, "completedAt"> | undefined,
): OnboardingStepKey[] {
  return steps.filter((step) => step.done && !state?.completedAt[step.key]).map((step) => step.key);
}

/** 从 panorama 取第③步要带上的客户与样品：优先最早建的那一个。 */
export function onboardingQuoteContextFrom(
  panorama:
    | {
        customers: ReadonlyArray<{ name: string; code: string }>;
        samples: ReadonlyArray<{ code: string }>;
      }
    | undefined,
): OnboardingQuoteContext {
  const customer = panorama?.customers[0];
  const sample = panorama?.samples[0];
  return {
    customerName: customer?.name ?? null,
    customerCode: customer?.code ?? null,
    sampleCode: sample?.code ?? null,
  };
}

/** 提交意图时随行落库的 context：客户/样品 id + 编号，执行器据此不用再问一遍。 */
export function onboardingIntentContext(
  panorama:
    | {
        customers: ReadonlyArray<{ id: string; name: string; code: string }>;
        samples: ReadonlyArray<{ id: string; code: string; name?: string }>;
      }
    | undefined,
): Record<string, string> | undefined {
  const customer = panorama?.customers[0];
  const sample = panorama?.samples[0];
  if (!customer && !sample) return undefined;
  return {
    ...(customer
      ? { customerId: customer.id, customerName: customer.name, customerCode: customer.code }
      : {}),
    ...(sample ? { sampleId: sample.id, sampleCode: sample.code } : {}),
    source: "onboarding-checklist",
  };
}
