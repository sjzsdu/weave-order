"use client";

import { useEffect } from "react";

export function UndoToast({
  message,
  pending = false,
  onUndo,
  onDismiss,
}: {
  message: string;
  pending?: boolean;
  onUndo: () => void;
  onDismiss: () => void;
}) {
  useEffect(() => {
    const timer = setTimeout(onDismiss, 5000);
    return () => clearTimeout(timer);
  }, [onDismiss]);
  return (
    <div
      role="status"
      className="fixed inset-x-0 top-4 z-50 mx-auto flex w-[min(92vw,640px)] flex-wrap items-center gap-3 rounded-lg border border-line bg-surface px-4 py-3 text-sm shadow-card"
    >
      <span className="min-w-0 flex-1 break-words font-medium text-ink-900">{message}</span>
      <button
        type="button"
        disabled={pending}
        onClick={onUndo}
        className="min-h-11 text-indigo-600 underline underline-offset-2 disabled:opacity-50"
      >
        {pending ? "撤销中…" : "撤销"}
      </button>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="关闭提示"
        className="min-h-11 px-2 text-ink-400 hover:text-ink-900"
      >
        ✕
      </button>
    </div>
  );
}
