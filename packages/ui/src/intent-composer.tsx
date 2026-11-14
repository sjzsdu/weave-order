"use client";

import { useState } from "react";
import { Button } from "./primitives";

const EXAMPLES = [
  "这款 220g 棉的，要 500 米，什么价",
  "给青禾服饰寄三个 32S 精梳棉的样",
  "华瑞的订单交期只剩 6 天，帮我跟一下",
];

/** 粘贴客户原话 → agent 出草稿；不做逐条录入表单。 */
export function IntentComposer({
  onSubmit,
  busy,
  error,
  initialText,
}: {
  onSubmit: (text: string) => void;
  busy?: boolean;
  error?: string | null;
  /** 从客户 360 带过来的上下文（如「给杭州青禾报价：」）。 */
  initialText?: string;
}) {
  const [text, setText] = useState(initialText ?? "");
  const submit = () => {
    const value = text.trim();
    if (!value || busy) return;
    onSubmit(value);
  };
  return (
    <div className="rounded-lg border border-line bg-surface p-5">
      <label htmlFor="intent" className="text-sm font-medium text-ink-900">
        粘贴客户原话，小织会整理成报价草稿
      </label>
      <textarea
        id="intent"
        value={text}
        onChange={(event) => setText(event.target.value)}
        rows={4}
        placeholder="例如：这款 220g 棉的，要 500 米，什么价"
        className="mt-2 w-full resize-y rounded-md border border-line bg-paper/40 px-3 py-2 text-sm text-ink-900 outline-none focus:border-indigo-600"
      />
      <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-2">
          {EXAMPLES.map((example) => (
            <button
              key={example}
              type="button"
              onClick={() => setText(example)}
              className="rounded-full border border-line px-3 py-1 text-xs text-ink-700 hover:border-ink-400"
            >
              {example}
            </button>
          ))}
        </div>
        <Button variant="primary" onClick={submit} disabled={busy || text.trim().length === 0}>
          {busy ? "小织正在整理…" : "生成草稿"}
        </Button>
      </div>
      {error && <p className="mt-3 text-sm text-vermilion-600">{error}</p>}
    </div>
  );
}
