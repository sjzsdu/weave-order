"use client";

import { useEffect, useRef, useState } from "react";
import { cn } from "./primitives";

/**
 * 顶栏命令入口（⌘K）。不自动抢焦点，不打断打字（§8.3 #7）。
 *
 * 提交一律就地展开结果：绝不跳页、绝不清空到用户看不到去向。
 * `onSubmit` 返回 `false` 表示未被服务端接收，此时原文保留在输入框里。
 */
export function CommandBar({
  onSubmit,
  placeholder = "说点什么…（⌘K）",
  right,
  feedback,
}: {
  onSubmit?: (text: string) => Promise<boolean> | boolean | void;
  placeholder?: string;
  right?: React.ReactNode;
  /** 提交后就地展开的结果区（状态卡、失败原因、重试按钮）。 */
  feedback?: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setOpen(true);
      }
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  const submit = async () => {
    const text = value.trim();
    if (!text || submitting) return;
    setSubmitting(true);
    try {
      const accepted = onSubmit ? await onSubmit(text) : true;
      if (accepted !== false) setValue("");
      // 结果区保持展开：用户要能立刻看到「这句话去哪了」。
      inputRef.current?.focus();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="relative flex items-center gap-3">
      {open ? (
        <>
          <div className="flex min-w-[280px] items-center gap-2 rounded-md border border-indigo-600/40 bg-surface px-3 py-1.5">
            <span className="text-xs text-ink-400">⌘K</span>
            <input
              ref={inputRef}
              value={value}
              onChange={(event) => setValue(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void submit();
              }}
              placeholder={placeholder}
              aria-busy={submitting}
              className="min-h-8 w-full bg-transparent text-sm text-ink-900 outline-none placeholder:text-ink-400"
            />
            {submitting && (
              <span className="whitespace-nowrap text-xs text-indigo-600">正在提交…</span>
            )}
          </div>
          {feedback && (
            <div
              role="status"
              className="absolute left-0 right-0 top-full z-40 mt-2 max-h-[70vh] w-[min(560px,92vw)] overflow-auto rounded-lg border border-line bg-surface p-3 shadow-card"
            >
              {feedback}
            </div>
          )}
        </>
      ) : (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className={cn(
            "min-h-9 rounded-md border border-line bg-surface px-3 text-sm text-ink-400",
            "hover:border-ink-400 hover:text-ink-700",
          )}
        >
          {placeholder}
        </button>
      )}
      {right}
    </div>
  );
}
