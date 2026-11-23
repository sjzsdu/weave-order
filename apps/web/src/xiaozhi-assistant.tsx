"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

/**
 * 全局「小织」浮标（WAN-211 UX-002）：给智能体一个可见的常驻存在。
 *
 * 不是完整聊天机器人：对话能力需要后端会话接口，本迭代先把「小织在值守」
 * 的状态、自然语言入口和常用去处固定在右下角，用户不用先理解「该点哪个 tab」。
 * 输入原文照统一输入页的同一路径（/inbound?text=）流转，理解卡与执行由既有内核完成。
 */
export function XiaozhiAssistant({ pendingCount }: { pendingCount: number }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const rootRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();
    const onDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const submit = () => {
    const value = text.trim();
    if (!value) return;
    setText("");
    setOpen(false);
    router.push(`/inbound?text=${encodeURIComponent(value)}`);
  };

  const status =
    pendingCount > 0 ? `有 ${pendingCount} 件等你决定，小织在值守` : "小织在值守，随时可以派活";

  return (
    <div ref={rootRef} className="fixed bottom-24 right-4 z-40 md:bottom-6 md:right-6">
      {open && (
        <div
          role="dialog"
          aria-label="小织助手"
          className="absolute bottom-full right-0 mb-3 w-[min(92vw,360px)] rounded-xl border border-line bg-surface p-4 shadow-card"
        >
          <div className="flex items-start gap-3">
            <span
              aria-hidden
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-indigo-600 text-sm font-semibold text-white"
            >
              织
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold text-ink-900">小织 · 智能体助手</p>
              <p className="mt-0.5 text-xs text-ink-500">{status}</p>
            </div>
            <button
              type="button"
              aria-label="关闭小织助手"
              onClick={() => setOpen(false)}
              className="inline-flex h-7 w-7 items-center justify-center rounded text-base leading-none text-ink-400 hover:bg-paper hover:text-ink-700"
            >
              ×
            </button>
          </div>

          <label htmlFor="xiaozhi-input" className="mt-3 block text-xs font-medium text-ink-700">
            一句话 + 几张图，说给小织听
          </label>
          <textarea
            id="xiaozhi-input"
            ref={inputRef}
            value={text}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                event.preventDefault();
                submit();
              }
            }}
            rows={3}
            maxLength={4000}
            placeholder="比如：这款 220g 棉的，要 500 米，什么价"
            className="mt-2 w-full resize-y rounded-md border border-line bg-paper/40 px-3 py-2 text-sm text-ink-900 outline-none focus:border-indigo-600"
          />
          <div className="mt-2 flex items-center justify-between gap-2">
            <span className="text-[11px] text-ink-400">⌘/Ctrl + Enter 发送</span>
            <button
              type="button"
              disabled={text.trim().length === 0}
              onClick={submit}
              className="inline-flex min-h-9 items-center rounded-md bg-ink-900 px-4 text-sm text-white hover:bg-ink-700 disabled:opacity-50"
            >
              发给小织
            </button>
          </div>

          <div className="mt-3 grid gap-1 border-t border-line pt-3">
            <Link
              href="/workbench"
              onClick={() => setOpen(false)}
              className="rounded-md px-2 py-1.5 text-sm text-ink-700 hover:bg-paper"
            >
              看工作台：今天小织做了什么
            </Link>
            <Link
              href="/items"
              onClick={() => setOpen(false)}
              className="rounded-md px-2 py-1.5 text-sm text-ink-700 hover:bg-paper"
            >
              看事项：所有在办的事
            </Link>
          </div>
        </div>
      )}

      <button
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label="小织助手"
        onClick={() => setOpen((value) => !value)}
        className="group flex items-center gap-2 rounded-full border border-line bg-surface py-1.5 pl-1.5 pr-3 shadow-card hover:border-indigo-600"
      >
        <span
          aria-hidden
          className="relative flex h-8 w-8 items-center justify-center rounded-full bg-indigo-600 text-sm font-semibold text-white"
        >
          织
          <span
            className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full border-2 border-surface bg-moss-600 animate-pulse"
            aria-hidden
          />
        </span>
        <span className="text-sm text-ink-700">小织</span>
      </button>
    </div>
  );
}
