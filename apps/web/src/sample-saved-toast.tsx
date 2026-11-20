"use client";

import Link from "next/link";
import { useEffect } from "react";

/** toast 只关心「是哪个样品」，不需要整条实体。 */
export interface SampleSaveFeedback {
  id: string;
  name: string;
  code: string;
  /** 新建还是编辑：同一套 UI 用两种说法，不能把编辑说成「已建」。 */
  created: boolean;
}

export function toSampleSaveFeedback(
  sample: { id: string; name: string; code: string },
  created: boolean,
): SampleSaveFeedback {
  return { id: sample.id, name: sample.name, code: sample.code, created };
}

export function sampleSavedTitle(feedback: Pick<SampleSaveFeedback, "name" | "created">): string {
  return `样品「${feedback.name}」${feedback.created ? "已建" : "已更新"}`;
}

/** 动作级 toast：不阻塞，带下一步，而不是让图墙悄悄多一格（WAN-149）。 */
export function SampleSavedToast({
  feedback,
  onDismiss,
  onOpen,
}: {
  feedback: SampleSaveFeedback;
  onDismiss: () => void;
  onOpen: () => void;
}) {
  useEffect(() => {
    const timer = setTimeout(onDismiss, 8000);
    return () => clearTimeout(timer);
  }, [onDismiss]);

  return (
    <div
      role="status"
      className="fixed inset-x-0 top-4 z-50 mx-auto flex w-[min(92vw,640px)] flex-wrap items-center gap-3 rounded-lg border border-line bg-surface px-4 py-3 text-sm shadow-card"
    >
      <span className="font-medium text-ink-900">{sampleSavedTitle(feedback)}</span>
      <span className="text-xs text-ink-400">{feedback.code}</span>
      <Link
        href={`/inbound?text=${encodeURIComponent(`用${feedback.name}报价：`)}&sampleId=${encodeURIComponent(feedback.id)}`}
        className="text-indigo-600 underline underline-offset-2"
      >
        用它报价 →
      </Link>
      <button type="button" onClick={onOpen} className="text-ink-700 underline underline-offset-2">
        补图 / 看规格
      </button>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="关闭提示"
        className="ml-auto text-ink-400 hover:text-ink-900"
      >
        ✕
      </button>
    </div>
  );
}
