"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "./primitives";

const EXAMPLES = [
  "这款 220g 棉的，要 500 米，什么价",
  "给青禾服饰寄三个 32S 精梳棉的样",
  "华瑞的订单交期只剩 6 天，帮我跟一下",
];

/**
 * 页内意图输入。
 *
 * 行为契约（与顶栏 ⌘K 共用同一个提交 hook）：
 * - 提交中按钮立刻显示「小织正在整理…」，防止重复点击；
 * - 只有提交被服务端接收（返回 true）才清空输入并保留焦点；
 * - 失败时原文一个字都不丢，原因由父级渲染。
 */
export function IntentComposer({
  onSubmit,
  busy,
  error,
  initialText,
  autoFocus,
}: {
  onSubmit: (text: string) => Promise<boolean>;
  busy?: boolean;
  error?: string | null;
  /** 从客户 360 带过来的上下文（如「给杭州青禾报价：」）。 */
  initialText?: string;
  /** 空状态「新建事项」跳进来：输入框为空，但光标要已就位。 */
  autoFocus?: boolean;
}) {
  const [text, setText] = useState(initialText ?? "");
  const [focused, setFocused] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const submitting = busy === true;

  useEffect(() => {
    // 从客户 360 跳进来时，带过来的上下文要能直接接着打。
    if (initialText || autoFocus) inputRef.current?.focus();
  }, [initialText, autoFocus]);

  /*
   * 同路由软导航（开张清单第③步、客户 360 的快捷动作）不会重新挂载组件，
   * 只改 `initialText`。少了这一步，`useState` 的初值只在首次渲染生效，
   * 用户点进来看到的是空输入框、提交也不带 context（WAN-142 R1）。
   * 用户已经自己改过内容时不覆盖：只有 initialText 真的变化才同步。
   */
  useEffect(() => {
    if (initialText) setText(initialText);
  }, [initialText]);

  const submit = async () => {
    const value = text.trim();
    if (!value || submitting) return;
    const accepted = await onSubmit(value);
    if (!accepted) return; // 原文保留，用户可以原地重试
    setText("");
    // 焦点必须留在输入框：连续说第二句话不该再点一次。
    requestAnimationFrame(() => inputRef.current?.focus());
  };

  return (
    <div className="rounded-lg border border-line bg-surface p-5">
      <label htmlFor="intent-input" className="text-sm font-medium text-ink-900">
        粘贴客户原话，小织会整理成报价草稿
      </label>
      <textarea
        id="intent-input"
        ref={inputRef}
        value={text}
        onChange={(event) => setText(event.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
            event.preventDefault();
            void submit();
          }
        }}
        rows={4}
        maxLength={4000}
        placeholder="例如：这款 220g 棉的，要 500 米，什么价"
        aria-busy={submitting}
        className="mt-2 w-full resize-y rounded-md border border-line bg-paper/40 px-3 py-2 text-sm text-ink-900 outline-none focus:border-indigo-600"
      />
      <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-2">
          {EXAMPLES.map((example) => (
            <button
              key={example}
              type="button"
              onClick={() => {
                setText(example);
                inputRef.current?.focus();
              }}
              className="rounded-full border border-line px-3 py-1 text-xs text-ink-700 hover:border-ink-400"
            >
              {example}
            </button>
          ))}
        </div>
        <Button
          variant="primary"
          onClick={() => void submit()}
          disabled={submitting || text.trim().length === 0}
        >
          {submitting ? "小织正在整理…" : "发给小织"}
        </Button>
      </div>
      <p className="mt-2 text-xs text-ink-400" aria-live="polite">
        {submitting
          ? "正在提交，小织受理后会立刻生成一张可追踪的卡片。"
          : focused
            ? "⌘/Ctrl + Enter 发送；发送后焦点留在这里，可以接着说下一句。"
            : "提交后可以在下方看到这句话的处理进展，10 分钟内可撤销。"}
      </p>
      {error && (
        <p className="mt-3 rounded-md border border-vermilion-600/30 bg-vermilion-600/10 px-3 py-2 text-sm text-vermilion-600">
          {error}
        </p>
      )}
    </div>
  );
}
