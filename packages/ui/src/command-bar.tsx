"use client";

import { useEffect, useRef, useState } from "react";
import { cn } from "./primitives";

/** 可直接回车执行的固定命令（如「建客户」），不是意图文本。 */
export interface CommandItem {
  label: string;
  hint?: string;
  run: () => void;
}

/**
 * 顶栏命令入口（⌘K）。不自动抢焦点，不打断打字（§8.3 #7）。
 *
 * 两种用法共用同一个输入框：
 * - 命中 `commands` 里的固定命令 → 执行命令（跳转/打开表单），不当意图提交；
 * - 其余文字 → 交给 `onSubmit`，就地展开结果：绝不跳页、绝不清空到用户看不到去向。
 * `onSubmit` 返回 `false` 表示未被服务端接收，此时原文保留在输入框里。
 */
export function CommandBar({
  onSubmit,
  commands = [],
  placeholder = "说点什么…（⌘K）",
  right,
  feedback,
}: {
  onSubmit?: (text: string) => Promise<boolean> | boolean | void;
  commands?: CommandItem[];
  placeholder?: string;
  right?: React.ReactNode;
  /** 提交后就地展开的结果区（状态卡、失败原因、重试按钮）。 */
  feedback?: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");
  const [activeIndex, setActiveIndex] = useState(-1);
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

  // 输入变化后旧的键盘选中位置就失效了，重置到「没有选中」= 默认走意图通道。
  useEffect(() => setActiveIndex(-1), [value]);

  const trimmed = value.trim();
  const visibleCommands = commands.filter((command) => !trimmed || command.label.includes(trimmed));

  const runCommand = (command: CommandItem) => {
    setValue("");
    setOpen(false);
    command.run();
  };

  const submit = async () => {
    if (submitting) return;
    const selected = activeIndex >= 0 ? visibleCommands[activeIndex] : undefined;
    if (selected) {
      runCommand(selected);
      return;
    }
    // 没按方向键、但恰好完整打出了一个命令名：回车就执行，不当作一句话丢给智能体。
    const exact = commands.find((command) => command.label === trimmed);
    if (exact) {
      runCommand(exact);
      return;
    }
    if (!trimmed) return;
    setSubmitting(true);
    try {
      const accepted = onSubmit ? await onSubmit(trimmed) : true;
      if (accepted !== false) setValue("");
      // 结果区保持展开：用户要能立刻看到「这句话去哪了」。
      inputRef.current?.focus();
    } finally {
      setSubmitting(false);
    }
  };

  const onInputKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" && visibleCommands.length > 0) {
      event.preventDefault();
      setActiveIndex((index) => (index + 1) % visibleCommands.length);
      return;
    }
    if (event.key === "ArrowUp" && visibleCommands.length > 0) {
      event.preventDefault();
      setActiveIndex((index) => (index <= 0 ? visibleCommands.length - 1 : index - 1));
      return;
    }
    if (event.key === "Enter") void submit();
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
              onKeyDown={onInputKeyDown}
              placeholder={placeholder}
              aria-busy={submitting}
              aria-controls={visibleCommands.length > 0 ? "command-bar-commands" : undefined}
              className="min-h-8 w-full bg-transparent text-sm text-ink-900 outline-none placeholder:text-ink-400"
            />
            {submitting && (
              <span className="whitespace-nowrap text-xs text-indigo-600">正在提交…</span>
            )}
          </div>
          {visibleCommands.length > 0 && (
            <ul
              id="command-bar-commands"
              className="absolute bottom-full left-0 z-40 mb-2 w-[min(320px,92vw)] rounded-lg border border-line bg-surface p-1 shadow-card"
            >
              {visibleCommands.map((command, index) => (
                <li key={command.label}>
                  <button
                    type="button"
                    // 用 mouseDown 抢在 blur 之前执行，避免输入框先失焦再点不中。
                    onMouseDown={(event) => {
                      event.preventDefault();
                      runCommand(command);
                    }}
                    onMouseEnter={() => setActiveIndex(index)}
                    className={cn(
                      "flex w-full items-center justify-between gap-3 rounded-md px-3 py-2 text-left text-sm",
                      index === activeIndex ? "bg-indigo-100 text-indigo-600" : "text-ink-700",
                    )}
                  >
                    <span>{command.label}</span>
                    {command.hint && <span className="text-xs text-ink-400">{command.hint}</span>}
                  </button>
                </li>
              ))}
              <li className="px-3 py-1 text-[10px] text-ink-400">
                ↑↓ 选择，回车执行；其他文字回车交给小织
              </li>
            </ul>
          )}
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
