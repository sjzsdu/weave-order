"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { cn } from "@weave-order/ui";
import {
  onboardingProgress,
  type OnboardingPrefs,
  type OnboardingStep,
  type OnboardingStepKey,
} from "@/onboarding";

/**
 * 开张清单：建完公司后落在空工作台的新用户，按这四步就能跑通第一单。
 *
 * 三条产品约束：
 * - 完成判定来自服务端统计（`done`），组件只负责展示与记录首次完成时间；
 * - 收起 / 跳过只存在本设备（`localStorage`，key 带版本号），不假装跨设备同步；
 * - 全部完成 3 秒后淡出，不再长期占屏。
 */
export function OnboardingChecklist({
  steps,
  prefs,
  onPrefsChange,
  autoCollapse,
}: {
  steps: OnboardingStep[];
  prefs: OnboardingPrefs;
  onPrefsChange: (next: OnboardingPrefs) => void;
  /** 客户或样品已经不是一个都没有了：默认折叠成一行，避免挡住正常工作。 */
  autoCollapse: boolean;
}) {
  const progress = onboardingProgress(steps);
  const [manuallyExpanded, setManuallyExpanded] = useState(false);
  const [faded, setFaded] = useState(false);
  const collapsed = prefs.collapsed || (autoCollapse && !manuallyExpanded);

  // 全部完成：先给一眼「开张完成」，3 秒后淡出并记住收起状态。
  useEffect(() => {
    if (!progress.allDone || collapsed) return;
    const timer = setTimeout(() => {
      setFaded(true);
      onPrefsChange({ ...prefs, collapsed: true });
    }, 3000);
    return () => clearTimeout(timer);
  }, [progress.allDone, collapsed, prefs, onPrefsChange]);

  if (prefs.skipped) return null;

  if (collapsed) {
    return (
      <button
        type="button"
        onClick={() => {
          setManuallyExpanded(true);
          if (prefs.collapsed) onPrefsChange({ ...prefs, collapsed: false });
        }}
        className="flex w-full items-center gap-2 rounded-lg border border-line bg-surface px-4 py-2 text-left text-xs text-ink-400 hover:border-ink-400"
      >
        <span className="font-medium text-ink-700">开张清单</span>
        <span>
          {progress.completed}/{progress.total} 已完成
        </span>
        <span className="ml-auto text-indigo-600">展开</span>
      </button>
    );
  }

  if (progress.allDone) {
    return (
      <section
        role="status"
        className={cn(
          "rounded-lg border border-moss-600/30 bg-moss-600/10 px-5 py-4 transition-opacity duration-700",
          faded ? "opacity-0" : "opacity-100",
        )}
      >
        <p className="text-sm font-medium text-moss-600">开张完成，小织开始跟单了。</p>
        <p className="mt-1 text-xs text-ink-400">
          客户、样品、报价、第一单都已经跑通。接下来它会盯交期和收款，需要你决定的会出现在审批窗口。
        </p>
      </section>
    );
  }

  return (
    <section className="rounded-lg border border-indigo-600/25 bg-surface px-5 py-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold text-ink-900">开张清单</h2>
          <p className="mt-0.5 text-xs text-ink-400">
            四步跑通第一单：{progress.completed}/{progress.total} 已完成
            {progress.next ? ` · 下一步：${progress.next.title}` : ""}
          </p>
        </div>
        <div className="flex items-center gap-3 text-xs">
          <button
            type="button"
            onClick={() => onPrefsChange({ ...prefs, collapsed: true })}
            className="text-ink-400 underline underline-offset-2 hover:text-ink-700"
          >
            收起
          </button>
          <button
            type="button"
            onClick={() => onPrefsChange({ ...prefs, skipped: true })}
            className="text-ink-400 underline underline-offset-2 hover:text-ink-700"
          >
            跳过
          </button>
        </div>
      </div>

      <ol className="mt-3 divide-y divide-line overflow-hidden rounded-md border border-line">
        {steps.map((step, index) => {
          const isNext = progress.next?.key === step.key;
          return (
            <li
              key={step.key}
              className={cn(
                "flex flex-wrap items-center gap-3 px-3 py-2.5",
                isNext && "bg-indigo-600/5",
              )}
            >
              <span
                aria-hidden
                className={cn(
                  "flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-xs",
                  step.done ? "border-moss-600 bg-moss-600 text-white" : "border-line text-ink-400",
                )}
              >
                {step.done ? "✓" : index + 1}
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-baseline gap-2">
                  <span
                    className={cn(
                      "text-sm",
                      step.done ? "text-ink-400 line-through" : "font-medium text-ink-900",
                    )}
                  >
                    {step.title}
                  </span>
                  {step.done && (
                    <span className="text-xs text-ink-400">
                      已完成{formatCompletedAt(prefs.completedAt[step.key])}
                    </span>
                  )}
                </span>
                {!step.done && (
                  <span className="mt-0.5 block text-xs text-ink-400">{step.hint}</span>
                )}
              </span>
              <Link
                href={step.href}
                className={cn(
                  "inline-flex min-h-8 shrink-0 items-center rounded-md px-3 text-xs",
                  step.done
                    ? "border border-line text-ink-700 hover:border-ink-400"
                    : "bg-ink-900 text-white hover:bg-ink-700",
                )}
              >
                {step.done ? "再看一次" : "去完成 →"}
              </Link>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function formatCompletedAt(iso: string | undefined): string {
  if (!iso) return "";
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";
  return ` · ${at.toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}`;
}

export type { OnboardingStep, OnboardingStepKey };
